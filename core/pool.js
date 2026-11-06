'use strict';

const { execFile } = require('node:child_process');
const { REGISTRY, POLICY } = require('./config');
const { normalizeInventory } = require('./inventory');
const lm = require('./lmstudio');

const LOCAL_PREFIX = 'local:';

function freeVramMb() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(-1);
        const n = parseInt(String(stdout).trim().split('\n')[0], 10);
        // Treat very low readings as unreliable (e.g. shared/low-memory hosts)
        // so model loading is not blocked by a noisy nvidia-smi sample.
        resolve(Number.isFinite(n) && n >= 1500 ? n : -1);
      }
    );
  });
}

class ModelPool {
  constructor(emit = () => {}) {
    this.emit = emit;
    this.resident = new Map(); // key -> { key, modelId, instanceId, vramGb, loadedAt, lastUsed, refcount }
    this.idCache = new Map();
    this.queue = Promise.resolve(); // serialises pool state transitions
    this.waiters = new Set();
    this.inventory = [];
    this.inventoryError = null;
    this.discovered = new Map();
    this.metrics = new Map();
  }

  _enqueue(fn) {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  _notifyWaiters() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  // Register under the queue lock so a release cannot be missed.
  _waitForRelease() {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  spec(key) {
    const s = REGISTRY[key] || this.discovered.get(key);
    if (!s) throw new Error(`unknown model key "${key}" (refresh local model inventory first)`);
    return s;
  }

  async resolve(key, refresh = false) {
    if (key.startsWith(LOCAL_PREFIX)) {
      const spec = this.spec(key);
      if (!spec.available) throw new Error(`local model "${spec.modelId}" is no longer available; refresh inventory`);
      return spec.modelId;
    }
    if (!refresh && this.idCache.has(key)) return this.idCache.get(key);
    const needle = this.spec(key).match.toLowerCase();
    const models = await lm.listModels();
    const hits = models
      .filter((m) => String(m.key || m.id || '').toLowerCase().includes(needle))
      .map((m) => m.key || m.id)
      .sort((a, b) => a.length - b.length);
    if (!hits.length) {
      throw new Error(
        `no downloaded model matches "${this.spec(key).match}" for "${key}". ` +
          `Visible: ${models.map((m) => m.key).join(', ')}`
      );
    }
    this.idCache.set(key, hits[0]);
    return hits[0];
  }

  async status() {
    const free = await freeVramMb();
    return {
      freeVramMb: free,
      resident: [...this.resident.values()].map((i) => ({
        key: i.key,
        label: this.spec(i.key).label,
        modelId: i.modelId,
        vramGb: Number(i.vramGb.toFixed(2)),
        idleSeconds: Math.round((Date.now() - i.lastUsed) / 1000),
        refcount: i.refcount,
        pinned: !!this.spec(i.key).pinned,
      })),
      models: [...Object.entries(REGISTRY), ...this.discovered.entries()].map(([key, s]) => ({
        key,
        label: s.label,
        role: s.role,
        match: s.match,
        priority: s.priority,
        pinned: !!s.pinned,
        slots: s.slots,
        resident: this.resident.has(key),
        available: key.startsWith(LOCAL_PREFIX) ? !!s.available : this.idCache.has(key),
        modelId: key.startsWith(LOCAL_PREFIX) ? s.modelId : (this.idCache.get(key) || null),
        type: s.type || null,
      })),
      inventory: this.inventory,
      inventoryError: this.inventoryError,
      metrics: Object.fromEntries(this.metrics),
    };
  }

  async _unload(inst, why) {
    // Never silently unload another application's duplicate instances.
    const ids = await this._instancesOf(inst.modelId);
    if (ids.length > 1) throw new Error(`cannot automatically evict ${inst.key}: multiple instances are loaded in LM Studio`);
    // An unsuccessful unload must not be treated as freed VRAM.
    await lm.unloadModel(ids[0] || inst.instanceId, inst.modelId);
    this.resident.delete(inst.key);
    this.emit({ type: 'pool', action: 'evict', key: inst.key, why });
    this._notifyWaiters();
  }

  async _enforceResidentLimit(key) {
    if (this.spec(key).cpu_only) return;
    const limit = Math.max(1, POLICY.max_resident || 1);
    const rank = (i) => (this.spec(i.key).pinned ? 1 : 0);
    while ([...this.resident.values()].filter((i) => !this.spec(i.key).cpu_only).length >= limit) {
      const victims = [...this.resident.values()]
        .filter((i) => !this.spec(i.key).cpu_only && i.refcount === 0 && i.key !== key)
        .sort((a, b) => rank(a) - rank(b) || a.lastUsed - b.lastUsed);
      if (!victims.length) {
        const error = new Error('all resident local models are in use');
        error.code = 'POOL_BUSY';
        throw error;
      }
      await this._unload(victims[0], `resident limit: making room for ${key}`);
    }
  }

  /**
   * `pinned` means "evict me last", not "never evict me" — on a 4 GB card
   * nothing else could ever load otherwise. Unpinned idle models go first,
   * then pinned ones. A refused eviction would deadlock the whole pool.
   */
  async _makeRoom(needGb, keep) {
    let free = await freeVramMb();
    if (free < 0) return;
    const floor = POLICY.vram_floor_mb;
    const rank = (i) => (this.spec(i.key).pinned ? 1 : 0);
    const victims = [...this.resident.values()]
      .filter((i) => i.refcount === 0 && i.key !== keep)
      .sort((a, b) => rank(a) - rank(b) || a.lastUsed - b.lastUsed);
    while (free < needGb * 1024 + floor && victims.length) {
      const v = victims.shift();
      await this._unload(v, `making room for ${keep}`);
      free = await freeVramMb();
    }
    if (free < needGb * 1024 + floor) {
      throw new Error(
        `not enough VRAM for ${keep}: need ~${Math.round(needGb * 1024)} MB, ` +
          `${free} MB free and nothing left to evict`
      );
    }
  }

  async _instancesOf(modelId) {
    const models = await lm.listModels();
    const m = models.find((x) => (x.key || x.id) === modelId);
    return (m?.loaded_instances || []).map((i) => String(i.id));
  }

  /**
   * Reconcile with the server. A fresh app process knows nothing about models
   * LM Studio already holds, so without this we double-load and burn VRAM.
   * Duplicate instances are reported but never automatically unloaded.
   */
  sync() {
    return this._enqueue(() => this._syncUnsafe());
  }

  async _syncUnsafe() {
    let models;
    try {
      models = await lm.listModels();
    } catch (error) {
      this.inventoryError = error.message;
      return;
    }
    this.inventoryError = null;
    this.inventory = normalizeInventory(models);
    // Extra downloaded models are selectable by their exact reported ID.
    // The named Nexus profiles remain intact for existing workflows.
    const extras = new Map();
    const profileIds = new Set(Object.values(REGISTRY).map((s) =>
      this.inventory.find((item) => item.id.toLowerCase().includes(s.match.toLowerCase()))?.id
    ).filter(Boolean));
    for (const item of this.inventory) {
      const isProfile = profileIds.has(item.id);
      const key = LOCAL_PREFIX + item.id;
      if (!isProfile || this.discovered.has(key)) {
        extras.set(key, {
          modelId: item.id, match: item.id, label: item.id, type: item.type,
          role: 'Discovered local model; capabilities not yet benchmarked.',
          diskGb: item.sizeBytes ? item.sizeBytes / 1024 ** 3 : 3,
          context_length: item.maxContextLength ? Math.min(item.maxContextLength, 16384) : 8192,
          slots: 1, priority: 0, pinned: false, cpu_only: false, available: true,
        });
      }
    }
    // Keep resident specs addressable even if the server stops reporting them.
    for (const [key, spec] of this.discovered) {
      if (!extras.has(key) && this.resident.has(key)) extras.set(key, { ...spec, available: false });
    }
    this.discovered = extras;
    for (const [key, spec] of [...Object.entries(REGISTRY), ...this.discovered.entries()]) {
      const needle = spec.match.toLowerCase();
      const m = models.find((x) => key.startsWith(LOCAL_PREFIX)
        ? String(x.key || x.id || '') === spec.modelId
        : String(x.key || x.id || '').toLowerCase().includes(needle));
      if (!m) {
        this.idCache.delete(key);
        continue;
      }
      const insts = m.loaded_instances || [];
      const modelId = m.key || m.id;
      this.idCache.set(key, modelId);

      if (!insts.length) {
        const tracked = this.resident.get(key);
        // A transient server response must not drop an active lease and allow
        // another model to load on top of it.
        if (tracked?.refcount > 0) continue;
        if (this.resident.delete(key)) this.emit({ type: 'pool', action: 'gone', key });
        continue;
      }

      if (insts.length > 1) {
        this.emit({ type: 'pool', action: 'duplicates', key, count: insts.length });
      }

      if (!this.resident.has(key)) {
        this.resident.set(key, {
          key,
          modelId,
          instanceId: String(insts[0].id ?? modelId),
          vramGb: spec.diskGb || 3,
          loadedAt: Date.now(),
          lastUsed: Date.now(),
          refcount: 0,
        });
        this.emit({ type: 'pool', action: 'adopt', key, label: spec.label });
      }
    }
  }

  /** Wait outside the state lock when another model has an active lease. */
  async _acquire(key, leased) {
    for (;;) {
      const result = await this._enqueue(async () => {
        try {
          const inst = await this._loadUnsafe(key);
          if (leased) inst.refcount += 1;
          inst.lastUsed = Date.now();
          return { inst };
        } catch (error) {
          if (error.code !== 'POOL_BUSY') throw error;
          return { wait: this._waitForRelease() };
        }
      });
      if (result.inst) return result.inst;
      await result.wait;
    }
  }

  load(key) {
    return this._acquire(key, false);
  }

  async _loadUnsafe(key) {
    await this._syncUnsafe();
    const existing = this.resident.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const spec = this.spec(key);
    const modelId = await this.resolve(key);

    const weightsGb = spec.diskGb || 3;
    const kvGb = spec.offload_kv_cache_to_gpu === false ? 0 : 0.6;
    const needGb = weightsGb * 0.98 + kvGb + 0.4;

    await this._enforceResidentLimit(key);
    if (!spec.cpu_only) await this._makeRoom(needGb, key);

    const body = {
      model: modelId,
      context_length: spec.context_length || 8192,
      flash_attention: true,
    };
    if (spec.offload_kv_cache_to_gpu !== undefined) {
      body.offload_kv_cache_to_gpu = !!spec.offload_kv_cache_to_gpu;
    }

    this.emit({ type: 'pool', action: 'load-start', key, label: spec.label });
    const t0 = Date.now();
    let res;
    try {
      res = await lm.loadModel(modelId, body);
    } catch (e) {
      this.emit({ type: 'pool', action: 'load-error', key, error: e.message });
      throw e;
    }
    const inst = {
      key,
      modelId,
      instanceId: String(res.instance_id || res.instanceId || modelId),
      vramGb: needGb,
      loadedAt: Date.now(),
      lastUsed: Date.now(),
      refcount: 0,
    };
    this.resident.set(key, inst);
    this.emit({
      type: 'pool',
      action: 'load-done',
      key,
      label: spec.label,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    });
    return inst;
  }

  unload(key) {
    return this._enqueue(async () => {
      const inst = this.resident.get(key);
      if (!inst) return;
      if (inst.refcount > 0) throw new Error(`cannot unload ${key}: model is in use`);
      const ids = await this._instancesOf(inst.modelId).catch(() => []);
      const targets = ids.length ? ids : [inst.instanceId];
      for (const id of targets) await lm.unloadModel(id, inst.modelId);
      this.resident.delete(key);
      this.emit({ type: 'pool', action: 'evict', key, why: 'explicit' });
      this._notifyWaiters();
    });
  }

  reap() {
    return this._enqueue(async () => {
      const now = Date.now();
      const gone = [];
      for (const inst of [...this.resident.values()]) {
        if (this.spec(inst.key).pinned || inst.refcount > 0) continue;
        if (now - inst.lastUsed > POLICY.idle_ttl_seconds * 1000) {
          await this._unload(inst, 'idle timeout');
          gone.push(inst.key);
        }
      }
      return gone;
    });
  }

  /** Acquire the refcount under the same lock as load/eviction. */
  async lease(key) {
    const inst = await this._acquire(key, true);
    let released = false;
    return {
      inst,
      release: () => {
        if (released) return;
        released = true;
        inst.refcount = Math.max(0, inst.refcount - 1);
        inst.lastUsed = Date.now();
        this._notifyWaiters();
      },
    };
  }

  async chat(key, messages, tools, opts = {}) {
    if (opts.signal?.aborted) throw new Error('Run interrupted');
    const lease = await this.lease(key);
    const start = Date.now();
    const metrics = this.metrics.get(key) || { calls: 0, failures: 0, durationMs: 0, promptTokens: 0, completionTokens: 0 };
    this.metrics.set(key, metrics);
    metrics.calls++;
    try {
      const body = {
        model: lease.inst.modelId,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 2048,
      };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      if (opts.signal?.aborted) throw new Error('Run interrupted');
      const response = await lm.chat(body, { signal: opts.signal });
      const usage = response?.usage || {};
      if (Number.isFinite(usage.prompt_tokens)) metrics.promptTokens += usage.prompt_tokens;
      if (Number.isFinite(usage.completion_tokens)) metrics.completionTokens += usage.completion_tokens;
      return response;
    } catch (error) {
      metrics.failures++;
      throw error;
    } finally {
      metrics.durationMs += Date.now() - start;
      this.metrics.set(key, metrics);
      lease.release();
    }
  }

  async embed(texts) {
    const lease = await this.lease('embedder');
    try {
      return await lm.embed(lease.inst.modelId, texts);
    } finally {
      lease.release();
    }
  }
}

module.exports = { ModelPool, freeVramMb };
