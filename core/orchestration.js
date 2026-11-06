'use strict';

// Advanced multi-agent orchestration: dynamic agent factory, collaboration
// protocol, independent verification, resource-aware parallel execution.
const { EventEmitter } = require('node:events');

class AgentFactory {
  constructor(pool) {
    this.pool = pool;
    this.agents = new Map();
  }

  create({ id, role, modelKey, systemPrompt, tools = [] }) {
    if (this.agents.has(id)) throw new Error(`agent ${id} already exists`);
    const agent = { id, role, modelKey, systemPrompt, tools, status: 'idle', createdAt: Date.now() };
    this.agents.set(id, agent);
    return agent;
  }

  get(id) { return this.agents.get(id); }
  list() { return [...this.agents.values()]; }
  remove(id) { this.agents.delete(id); }
}

// Collaboration protocol: agents exchange briefs via a shared bus.
class CollaborationBus extends EventEmitter {
  constructor() {
    super();
    this.briefs = [];
  }

  publish(brief) {
    const entry = { id: this.briefs.length + 1, time: new Date().toISOString(), ...brief };
    this.briefs.push(entry);
    this.emit('brief', entry);
    return entry;
  }

  recent(n = 10) { return this.briefs.slice(-n); }
}

// Independent verifier: runs a check function and returns pass/fail with evidence.
class IndependentVerifier {
  constructor(checks = []) {
    this.checks = checks;
  }

  async verify(ctx) {
    const results = [];
    for (const c of this.checks) {
      let ok = false;
      let evidence = '';
      try {
        const r = await c.fn(ctx);
        ok = !!r?.ok;
        evidence = r?.evidence || '';
      } catch (e) {
        ok = false;
        evidence = `threw: ${e.message}`;
      }
      results.push({ name: c.name, ok, evidence });
    }
    const passed = results.every((r) => r.ok);
    return { passed, results };
  }
}

// Resource-aware parallel executor with concurrency limit.
class ParallelExecutor {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = Math.max(1, concurrency);
  }

  async run(tasks) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const i = cursor++;
        try {
          results[i] = { ok: true, value: await tasks[i]() };
        } catch (e) {
          results[i] = { ok: false, error: e.message };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }
}

module.exports = { AgentFactory, CollaborationBus, IndependentVerifier, ParallelExecutor };