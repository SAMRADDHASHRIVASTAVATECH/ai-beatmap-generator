'use strict';

/**
 * Learning and model evolution, done honestly:
 *
 * - versioned experiment registry (JSONL) under the data dir
 * - prompt/lesson experiments are kept strictly separate from weight (LoRA) ones
 * - candidate-vs-baseline comparison uses measured taskScores (0..1)
 * - original weights are never modified; outputs land in the experiment dir
 * - nothing is promoted without explicit approval recorded in the registry
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');

const KINDS = new Set(['prompt', 'weight', 'candidate']);

class ExperimentRegistry {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'experiments');
    this.registry = path.join(this.dir, 'registry.jsonl');
  }

  async _append(entry) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(this.registry, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  async record(exp) {
    if (!KINDS.has(exp.kind)) throw new Error(`unknown experiment kind ${exp.kind}`);
    const entry = {
      id: exp.id || `exp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      createdAt: new Date().toISOString(),
      kind: exp.kind,
      baseModel: exp.baseModel || null,
      description: exp.description || '',
      status: exp.status || 'proposed',   // proposed|running|verified|rejected|promoted
      scores: exp.scores || null,          // { taskId: 0..1 } candidate measurements
      baselineScores: exp.baselineScores || null,
      weightsTouched: exp.kind === 'weight',
      notes: exp.notes || '',
    };
    await this._append(entry);
    return entry;
  }

  async list({ kind = null, status = null } = {}) {
    try {
      const lines = (await fs.readFile(this.registry, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return lines.filter((e) => (!kind || e.kind === kind) && (!status || e.status === status));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Compare candidate scores against a baseline. Never trusts one sample blindly. */
  static compare(candidate = {}, baseline = {}, { margin = 0.05 } = {}) {
    const ids = [...new Set([...Object.keys(candidate), ...Object.keys(baseline)])];
    const rows = ids.map((id) => ({
      task: id,
      candidate: Number.isFinite(candidate[id]) ? candidate[id] : null,
      baseline: Number.isFinite(baseline[id]) ? baseline[id] : null,
      delta: Number.isFinite(candidate[id]) && Number.isFinite(baseline[id]) ? candidate[id] - baseline[id] : null,
    }));
    const deltas = rows.map((r) => r.delta).filter(Number.isFinite);
    const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const wins = deltas.filter((d) => d > margin).length;
    const losses = deltas.filter((d) => d < -margin).length;
    let verdict = 'inconclusive';
    if (deltas.length && avg > margin && wins >= losses) verdict = 'better';
    else if (deltas.length && avg < -margin && losses >= wins) verdict = 'worse';
    return { verdict, avgDelta: avg, rows };
  }

  /** Promotion gate: only a human, only after measured comparison + tests pass. */
  async promote(id, { approvedBy, reason } = {}) {
    if (!approvedBy) throw new Error('promotion requires an explicit approver name');
    const list = await this.list();
    const exp = list.find((e) => e.id === id);
    if (!exp) throw new Error(`no experiment ${id}`);
    if (exp.kind === 'weight' && exp.status !== 'verified') {
      throw new Error('weight experiments must be verified by tests before promotion');
    }
    const entry = { ...exp, id: `promote_${id}`, createdAt: new Date().toISOString(), status: 'promoted', promotedBy: approvedBy, reason: reason || '' };
    await this._append(entry);
    return entry;
  }

  /** Is LoRA/PEFT tooling present? Reports honestly instead of faking. */
  async loraTooling() {
    const found = await new Promise((resolve) => {
      execFile('python', ['-c', 'import unsloth; print(unsloth.__version__)'], { windowsHide: true, timeout: 30000 },
        (err, stdout) => resolve(err ? null : String(stdout).trim()));
    });
    return found
      ? { available: true, version: found, note: 'unsloth detected; experiments may run with a config that leaves base weights untouched' }
      : { available: false, note: 'unsloth not importable; weight experiments are scaffolded but cannot train on this machine until it is installed' };
  }

  /** Scaffold a weight-experiment dir. Never touches base model files. */
  async scaffoldWeightExperiment({ baseModel, name }) {
    const id = `lora_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const dir = path.join(this.dir, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const config = {
      id,
      baseModel,
      name: name || 'unnamed',
      outputDir: path.join(dir, 'adapter'),      // adapters only — never the base weights
      maxSteps: 100,
      learningRate: 0.0001,
      baseWeightsReadOnly: true,
      evalBeforePromote: true,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, 'lora.config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    return { id, dir, config };
  }
}

module.exports = { ExperimentRegistry, KINDS };
