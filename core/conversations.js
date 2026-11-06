'use strict';

// Local per-workspace conversation history. Not a full task checkpoint or
// searchable knowledge system; never resumes side effects automatically.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EncryptedStore } = require('./sandbox');

class ConversationStore {
  constructor(root, options = {}) {
    this.root = root;
    this.queues = new Map();
    this.encrypted = !!options.encrypted;
    this.passphrase = options.passphrase;
  }

  _encryptedStore() {
    return new EncryptedStore(this.root, this.passphrase);
  }

  file(workspace) {
    const key = crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex');
    return path.join(this.root, 'conversations', `${key}.json`);
  }

  async read(workspace) {
    if (this.encrypted) {
      try {
        const data = await this._encryptedStore().read(this._key(workspace));
        if (data.workspace !== path.resolve(workspace) || !Array.isArray(data.messages)) return [];
        return data.messages.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }
    try {
      const data = JSON.parse(await fs.readFile(this.file(workspace), 'utf8'));
      if (data.workspace !== path.resolve(workspace) || !Array.isArray(data.messages)) return [];
      return data.messages.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  _key(workspace) {
    return require('node:crypto').createHash('sha256').update(path.resolve(workspace)).digest('hex');
  }

  async clear(workspace) {
    const file = this.file(workspace);
    await fs.rm(file, { force: true });
    this.queues.delete(workspace);
  }

  append(workspace, role, content) {
    if (!['user', 'assistant'].includes(role) || typeof content !== 'string') throw new Error('invalid conversation message');
    const previous = this.queues.get(workspace) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const messages = await this.read(workspace);
      messages.push({ role, content, time: new Date().toISOString() });
      if (this.encrypted) {
        await this._encryptedStore().write(this._key(workspace), { workspace: path.resolve(workspace), messages });
        return messages;
      }
      const file = this.file(workspace);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ workspace: path.resolve(workspace), messages }, null, 2), { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      return messages;
    });
    this.queues.set(workspace, next);
    next.finally(() => { if (this.queues.get(workspace) === next) this.queues.delete(workspace); }).catch(() => {});
    return next;
  }
}

function recentHistory(messages, maxChars = 16000, maxMessages = 12) {
  const pairs = [];
  let user = null;
  for (const m of messages || []) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'user') user = { role: 'user', content: m.content };
    else if (m.role === 'assistant' && user) {
      pairs.push([user, { role: 'assistant', content: m.content }]);
      user = null;
    }
  }
  const result = [];
  let chars = 0;
  for (const pair of pairs.reverse()) {
    const length = pair[0].content.length + pair[1].content.length;
    if (chars + length > maxChars || result.length + 2 > maxMessages) break;
    result.unshift(...pair);
    chars += length;
  }
  return result;
}

module.exports = { ConversationStore, recentHistory };
