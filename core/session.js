'use strict';

// OpenCode-style session management: create, continue, list, persist, resume.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class SessionManager {
  constructor(root) {
    this.root = root;
    this.sessions = new Map();
  }

  _file(id) {
    return path.join(this.root, 'sessions', `${id}.json`);
  }

  async create({ workspace, title } = {}) {
    const id = crypto.randomBytes(8).toString('hex');
    const session = {
      id,
      title: title || 'New session',
      workspace: path.resolve(workspace || process.cwd()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      state: 'idle',
    };
    this.sessions.set(id, session);
    await this._persist(session);
    return session;
  }

  async load(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    try {
      const data = JSON.parse(await fs.readFile(this._file(id), 'utf8'));
      this.sessions.set(id, data);
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async list() {
    try {
      const dir = path.join(this.root, 'sessions');
      const files = await fs.readdir(dir);
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try { out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))); } catch {}
      }
      return out.map((s) => ({ id: s.id, title: s.title, workspace: s.workspace, updatedAt: s.updatedAt, state: s.state }));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async appendMessage(id, message) {
    const s = await this.load(id);
    if (!s) throw new Error(`session ${id} not found`);
    s.messages.push({ ...message, time: new Date().toISOString() });
    s.updatedAt = new Date().toISOString();
    await this._persist(s);
    return s;
  }

  async setState(id, state) {
    const s = await this.load(id);
    if (!s) throw new Error(`session ${id} not found`);
    s.state = state;
    s.updatedAt = new Date().toISOString();
    await this._persist(s);
    return s;
  }

  async _persist(session) {
    const file = this._file(session.id);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  async remove(id) {
    this.sessions.delete(id);
    await fs.rm(this._file(id), { force: true });
  }
}

module.exports = { SessionManager };