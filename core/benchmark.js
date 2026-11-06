'use strict';

// Capability benchmarks and intelligent model selection based on measured
// performance. Stores per-model scores in memory (and optionally to disk).
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_TASKS = [
  { id: 'tool_call', prompt: 'Call read_file on package.json', weight: 2 },
  { id: 'code_edit', prompt: 'Edit a unique string in a file', weight: 2 },
  { id: 'reasoning', prompt: 'Explain a bug from a stack trace', weight: 1.5 },
  { id: 'summarize', prompt: 'Summarize a 200 line file', weight: 1 },
  { id: 'planning', prompt: 'Break a feature into steps', weight: 1.5 },
];

class BenchmarkStore {
  constructor(root) {
    this.root = root;
    this.results = new Map(); // modelKey -> { scores, measuredAt, samples }
  }

  async record(modelKey, taskScores, meta = {}) {
    const prev = this.results.get(modelKey) || { scores: {}, samples: 0 };
    const merged = { ...prev.scores };
    for (const [k, v] of Object.entries(taskScores || {})) {
      merged[k] = Number.isFinite(v) ? v : 0;
    }
    const entry = {
      modelKey,
      scores: merged,
      samples: (prev.samples || 0) + 1,
      measuredAt: new Date().toISOString(),
      meta,
    };
    this.results.set(modelKey, entry);
    await this._persist(modelKey, entry);
    return entry;
  }

  _file(modelKey) {
    return path.join(this.root, 'benchmarks', `${modelKey}.json`);
  }

  async _persist(modelKey, entry) {
    const file = this._file(modelKey);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
  }

  async load(modelKey) {
    try {
      const entry = JSON.parse(await fs.readFile(this._file(modelKey), 'utf8'));
      this.results.set(modelKey, entry);
      return entry;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  score(modelKey) {
    const e = this.results.get(modelKey);
    if (!e) return 0;
    let total = 0;
    let weight = 0;
    for (const t of DEFAULT_TASKS) {
      const v = e.scores[t.id];
      if (Number.isFinite(v)) {
        total += v * t.weight;
        weight += t.weight;
      }
    }
    return weight ? total / weight : 0;
  }

  // Pick the best model for a task type among available keys.
  select(taskId, availableKeys = []) {
    const ranked = availableKeys
      .map((k) => ({ key: k, score: this.score(k) || 0 }))
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    // If no measured scores, fall back to first available.
    if (ranked.every((r) => r.score === 0)) return ranked[0].key;
    return ranked[0].key;
  }

  summary() {
    return [...this.results.values()].map((e) => ({
      modelKey: e.modelKey,
      score: this.score(e.modelKey),
      samples: e.samples,
      measuredAt: e.measuredAt,
    }));
  }
}

module.exports = { BenchmarkStore, DEFAULT_TASKS };