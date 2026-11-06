'use strict';

/**
 * Serial prompt queue for direct interactive mode.
 * Semantics ported from OpenCode (packages/opencode/src/cli/cmd/run/runtime.queue.ts):
 * prompts typed while the agent is busy queue up here and drain one turn at a
 * time; queued prompts stay visible and removable (/queue rm N) until their
 * turn begins. /new bypasses the queue; exits are handled by the caller.
 */

class PromptQueue {
  constructor() {
    this.items = [];   // [{ id, text, resources, enqueuedAt }]
    this.seq = 0;
  }

  enqueue(text, resources = [], meta = {}) {
    const item = {
      id: ++this.seq,
      text: String(text || ''),
      resources: resources.slice(),
      chatId: meta.chatId || null,
      enqueuedAt: Date.now(),
    };
    this.items.push(item);
    return item;
  }

  /** Remove queued prompt by 1-based index. Returns removed item or null. */
  remove(index) {
    const i = Number(index) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) return null;
    return this.items.splice(i, 1)[0] || null;
  }

  /** Shift the next prompt (its turn begins now). */
  shift() {
    return this.items.shift() || null;
  }

  get length() { return this.items.length; }

  list() { return this.items.map((item, i) => ({ n: i + 1, id: item.id, text: item.text })); }

  clear() { this.items.length = 0; }
}

module.exports = { PromptQueue };
