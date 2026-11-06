'use strict';

/**
 * Proactive automation: a persistent, file-backed task queue with
 * pause/resume, file watchers, recurring schedules and crash detection, plus
 * completion notifications. Deterministic scripts first — AI is only invoked
 * by tasks that explicitly ask for it.
 *
 * State survives restarts: the queue, the watch list, the schedule and the
 * notification log are plain JSON/JSONL under the data dir.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { isLowResource } = require('./resources');

const DEFAULTS = {
  queueFile: 'automation/queue.json',
  notifyFile: 'automation/notifications.jsonl',
  maxTasks: 500,
};

function now() { return new Date().toISOString(); }

class AutomationBus {
  constructor({ dataDir, onEvent = () => {} } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), '.nexus');
    this.queueFile = path.join(this.dataDir, DEFAULTS.queueFile);
    this.notifyFile = path.join(this.dataDir, DEFAULTS.notifyFile);
    this.onEvent = onEvent;
    this.enabled = true;          // master switch: automation active
    this.tasks = [];              // loaded from disk
    this.timers = new Map();      // taskId -> Timeout
    this.watchers = [];           // fs.FSWatcher[]
    this.running = false;
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.queueFile, 'utf8'));
      this.enabled = raw.enabled !== false;
      this.tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.tasks = [];
      this.enabled = true;
    }
    return this;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.queueFile), { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.queueFile, JSON.stringify({ enabled: this.enabled, tasks: this.tasks }, null, 2), { mode: 0o600 });
  }

  // ---------------------------------------------------------- enable/disable
  async setEnabled(v) {
    this.enabled = !!v;
    for (const [, t] of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
    await this.save();
    this.onEvent({ type: 'automation', enabled: this.enabled });
    return this.enabled;
  }

  async add(task) {
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      id,
      kind: task.kind || 'generic',
      title: String(task.title || 'task'),
      payload: task.payload || {},
      priority: Number.isFinite(task.priority) ? task.priority : 5,   // lower runs first
      recurringMs: task.recurringMs || null,
      dueAt: task.dueAt || now(),
      status: 'queued',                                               // queued|running|done|failed
      createdAt: now(),
      result: null,
      error: null,
    };
    this.tasks.push(entry);
    if (this.tasks.length > DEFAULTS.maxTasks) this.tasks = this.tasks.slice(-DEFAULTS.maxTasks);
    await this.save();
    this.onEvent({ type: 'task', task: entry });
    return entry;
  }

  list({ status = null } = {}) {
    return this.tasks.filter((t) => !status || t.status === status);
  }

  pause() { return this.setEnabled(false); }
  resume() { return this.setEnabled(true); }

  // ---------------------------------------------------------------- claiming
  claimNext() {
    if (!this.enabled) return null;
    const due = this.tasks
      .filter((t) => t.status === 'queued' && new Date(t.dueAt) <= new Date())
      .sort((a, b) => a.priority - b.priority || new Date(a.dueAt) - new Date(b.dueAt));
    if (!due.length) return null;
    // Under resource pressure, only high-priority (<=2) work proceeds.
    const allowLowPriority = !isLowResource();
    const candidate = due.find((t) => allowLowPriority || t.priority <= 2);
    if (!candidate) return null;
    candidate.status = 'running';
    candidate.startedAt = now();
    return candidate;
  }

  async complete(id, result) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no task ${id}`);
    t.status = 'done';
    t.result = result;
    t.finishedAt = now();
    if (t.recurringMs) {
      await this.add({ kind: t.kind, title: t.title, payload: t.payload, priority: t.priority, recurringMs: t.recurringMs, dueAt: new Date(Date.now() + t.recurringMs).toISOString() });
    }
    await this.save();
    await this.notify('task complete', `${t.title}`, { taskId: id });
    return t;
  }

  async fail(id, error) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no task ${id}`);
    t.status = 'failed';
    t.error = String(error).slice(0, 1000);
    t.finishedAt = now();
    await this.save();
    await this.notify('task failed', `${t.title}: ${t.error}`, { taskId: id });
    return t;
  }

  // ---------------------------------------------------------------- watchers
  watch(dir, { recursive = true, label = null, onEvent = null } = {}) {
    if (!this.enabled) return null;
    const watcher = fs.watch(dir, { recursive }, (eventType, filename) => {
      if (filename) {
        this.onEvent({ type: 'fs', eventType, file: path.join(dir, filename.toString()), label });
        if (onEvent) onEvent(eventType, path.join(dir, filename.toString()));
      }
    });
    this.watchers.push(watcher);
    return watcher;
  }

  // ------------------------------------------------------------- scheduling
  scheduleRecurring(name, fn, intervalMs) {
    const timer = setInterval(async () => {
      if (!this.enabled) return;
      try { await fn(); } catch (e) { this.onEvent({ type: 'automation-error', task: name, error: String(e.message || e) }); }
    }, intervalMs);
    this.timers.set(`every:${name}`, timer);
    return () => { clearInterval(timer); this.timers.delete(`every:${name}`); };
  }

  // ------------------------------------------------------------ run command
  watchCrash(name, command, { args = [], cwd, onCrash } = {}) {
    return new Promise((resolve) => {
      execFile(command, args, { cwd: cwd || process.cwd(), windowsHide: true, timeout: 0 },
        async (err, stdout, stderr) => {
          const code = err && typeof err.code === 'number' ? err.code : err ? null : 0;
          const ok = code === 0;
          const detail = ok ? '' : `exit ${code}: ${String(stderr || err).slice(0, 300)}`;
          this.onEvent({ type: 'crash-watch', task: name, ok, detail });
          if (!ok && onCrash) await onCrash({ stderr, stdout, code });
          resolve({ ok, code, stdout, stderr });
        });
    });
  }

  // ------------------------------------------------------------ notification
  async notify(title, body, extra = {}) {
    const line = JSON.stringify({ time: now(), title, body, ...extra });
    await fsp.mkdir(path.dirname(this.notifyFile), { recursive: true, mode: 0o700 });
    await fsp.appendFile(this.notifyFile, line + '\n', { mode: 0o600 });
    return { logged: true, toast: false };
  }

  async notifications(limit = 20) {
    try {
      const lines = (await fsp.readFile(this.notifyFile, 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async stop() {
    for (const [, t] of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
    this.running = false;
  }
}

module.exports = { AutomationBus };
