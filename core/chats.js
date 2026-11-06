'use strict';

/**
 * Multi-conversation store. One JSON file per chat under <root>/chats/.
 * Supports: list, create, switch, rename, pin/unpin, duplicate, delete.
 * Deliberately independent of project files — deleting a chat never touches them.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function nowIso() { return new Date().toISOString(); }
function newId() {
  return `chat_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

class ChatStore {
  constructor(root) {
    this.root = path.join(root, 'chats');
    this.currentFile = path.join(this.root, '.current');
  }

  async _ensure() { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); }

  _file(id) { return path.join(this.root, `${id}.json`); }

  async list() {
    await this._ensure();
    const out = [];
    let names = [];
    try { names = await fs.readdir(this.root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try { out.push(await this._read(name.replace(/\.json$/, ''))); } catch { /* corrupt file — skip */ }
    }
    // pinned first, then newest updated
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async current() {
    const id = await this._loadCurrent();
    if (id) {
      try { return await this._read(id); } catch { /* fall through */ }
    }
    // adopt newest chat, or create the first one
    const list = await this.list();
    if (list[0]) { await this._saveCurrent(list[0].id); return list[0]; }
    return this.create();
  }

  async _loadCurrent() {
    try { return (await fs.readFile(this.currentFile, 'utf8')).trim() || null; } catch { return null; }
  }

  async _saveCurrent(id) {
    await this._ensure();
    await fs.writeFile(this.currentFile, String(id), { mode: 0o600 });
  }

  async _read(id) {
    const data = JSON.parse(await fs.readFile(this._file(id), 'utf8'));
    return {
      id: data.id || id,
      title: String(data.title || 'Untitled chat').slice(0, 120),
      pinned: !!data.pinned,
      createdAt: data.createdAt || nowIso(),
      updatedAt: data.updatedAt || nowIso(),
      messages: Array.isArray(data.messages) ? data.messages : [],
    };
  }

  async _write(chat) {
    await this._ensure();
    const file = this._file(chat.id);
    const temp = path.join(this.root, `.${chat.id}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(chat, null, 2), { mode: 0o600 });
      await fs.rename(temp, file); // never expose a half-written chat after a crash
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return chat;
  }

  titleFrom(firstUserMessage) {
    const t = String(firstUserMessage || '').replace(/\s+/g, ' ').trim();
    if (!t) return 'Untitled chat';
    return t.length > 64 ? t.slice(0, 61) + '…' : t;
  }

  async create(title) {
    const id = newId();
    const chat = { id, title: title || 'Untitled chat', pinned: false, createdAt: nowIso(), updatedAt: nowIso(), messages: [] };
    await this._write(chat);
    await this._saveCurrent(id);
    return chat;
  }

  async switchTo(id) {
    await this._read(id); // validate
    await this._saveCurrent(id);
    return this._read(id);
  }

  async get(id) { return this._read(id); }

  async appendMessage(id, role, content) {
    const chat = await this._read(id);
    chat.messages.push({ role, content: String(content || ''), time: nowIso() });
    if (!chat.title || chat.title === 'Untitled chat') {
      const firstUser = chat.messages.find((m) => m.role === 'user');
      if (firstUser) chat.title = this.titleFrom(firstUser.content);
    }
    chat.updatedAt = nowIso();
    return this._write(chat);
  }

  // Keep a completed request and response together in one write. A failed or
  // interrupted run should not leave a dangling user turn in model history.
  async appendTurn(id, user, assistant) {
    const chat = await this._read(id);
    const time = nowIso();
    chat.messages.push(
      { role: 'user', content: String(user), time },
      { role: 'assistant', content: String(assistant), time }
    );
    if (!chat.title || chat.title === 'Untitled chat') chat.title = this.titleFrom(user);
    chat.updatedAt = time;
    return this._write(chat);
  }

  async replaceMessages(id, messages) {
    const chat = await this._read(id);
    chat.messages = messages.map((m) => ({ role: m.role, content: String(m.content), time: m.time || nowIso() }));
    chat.updatedAt = nowIso();
    return this._write(chat);
  }

  async undoLastTurn(id) {
    const chat = await this._read(id);
    const last = chat.messages.length - 1;
    if (last < 1 || chat.messages[last].role !== 'assistant' || chat.messages[last - 1].role !== 'user') return false;
    chat.messages.splice(last - 1, 2);
    chat.updatedAt = nowIso();
    await this._write(chat);
    return true;
  }

  async rename(id, title) {
    const chat = await this._read(id);
    chat.title = String(title || '').trim().slice(0, 120) || chat.title;
    chat.updatedAt = nowIso();
    return this._write(chat);
  }

  async pin(id, pinned = true) {
    const chat = await this._read(id);
    chat.pinned = !!pinned;
    chat.updatedAt = nowIso();
    return this._write(chat);
  }

  async duplicate(id) {
    const src = await this._read(id);
    const copy = {
      id: newId(),
      title: src.title + ' (copy)',
      pinned: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: src.messages.map((m) => ({ ...m })),
    };
    await this._write(copy);
    await this._saveCurrent(copy.id);
    return copy;
  }

  async delete(id) {
    await fs.rm(this._file(id), { force: true });
    const cur = await this._loadCurrent();
    if (cur === id) {
      const rest = await this.list();
      if (rest[0]) { await this._saveCurrent(rest[0].id); return rest[0]; }
      return this.create();
    }
    return this.current();
  }
}

module.exports = { ChatStore };
