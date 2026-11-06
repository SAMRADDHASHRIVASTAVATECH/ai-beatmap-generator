'use strict';

// Searchable long-term memory, task checkpoints and resume support.
// Built on top of the per-workspace conversation store: turns are indexed by
// keyword TF (no external deps) so interrupted work can be found later.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

class LongTermMemory {
  constructor(root) {
    this.root = root;
    this.index = new Map(); // token -> Set of message ids
    this.messages = new Map(); // id -> { workspace, role, content, time, tags }
  }

  async load(workspace) {
    const file = this._file(workspace);
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(data.messages)) return [];
      for (const m of data.messages) this._index(m);
      return data.messages;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  _file(workspace) {
    const key = crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex');
    return path.join(this.root, 'memory', `${key}.json`);
  }

  async store(workspace, role, content, tags = []) {
    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      workspace: path.resolve(workspace),
      role,
      content: String(content || ''),
      time: new Date().toISOString(),
      tags: Array.isArray(tags) ? tags : [],
    };
    const file = this._file(workspace);
    const existing = await this.load(workspace).catch(() => []);
    existing.push(msg);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify({ workspace: path.resolve(workspace), messages: existing }, null, 2), { mode: 0o600 });
    this._index(msg);
    return msg;
  }

  _index(msg) {
    this.messages.set(msg.id, msg);
    const seen = new Set();
    for (const t of tokenize(msg.content)) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!this.index.has(t)) this.index.set(t, new Set());
      this.index.get(t).add(msg.id);
    }
  }

  search(query, { limit = 20, workspace = null } = {}) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const scores = new Map();
    for (const t of tokens) {
      const ids = this.index.get(t);
      if (!ids) continue;
      for (const id of ids) {
        const m = this.messages.get(id);
        if (!m) continue;
        if (workspace && m.workspace !== path.resolve(workspace)) continue;
        scores.set(id, (scores.get(id) || 0) + 1);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.messages.get(id));
  }
}

// Task checkpoint for resuming interrupted work.
class CheckpointStore {
  constructor(root) {
    this.root = root;
  }

  _file(runId) {
    return path.join(this.root, 'checkpoints', `${runId}.json`);
  }

  async save(runId, state) {
    const file = this._file(runId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const payload = { runId, savedAt: new Date().toISOString(), ...state };
    await fs.writeFile(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    return payload;
  }

  async load(runId) {
    try {
      return JSON.parse(await fs.readFile(this._file(runId), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async list() {
    try {
      const dir = path.join(this.root, 'checkpoints');
      const files = await fs.readdir(dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async remove(runId) {
    await fs.rm(this._file(runId), { force: true });
  }
}

module.exports = { LongTermMemory, CheckpointStore, tokenize };