'use strict';

// Plugin system: load JS plugins from a directory, register tools and hooks.
const fs = require('node:fs/promises');
const path = require('node:path');

class PluginManager {
  constructor() {
    this.plugins = new Map();
    this.tools = new Map();
    this.hooks = { beforeTool: [], afterTool: [], onMessage: [] };
  }

  async loadDir(dir) {
    let entries;
    try { entries = await fs.readdir(dir); } catch { return []; }
    const loaded = [];
    for (const f of entries) {
      if (!f.endsWith('.js')) continue;
      const full = path.join(dir, f);
      try {
        const mod = require(full);
        const id = (mod && mod.id) || f.replace(/\.js$/, '');
        this.plugins.set(id, mod);
        if (mod.tools) for (const t of mod.tools) this.tools.set(t.name, t);
        if (mod.hooks) {
          for (const h of mod.hooks.beforeTool || []) this.hooks.beforeTool.push(h);
          for (const h of mod.hooks.afterTool || []) this.hooks.afterTool.push(h);
          for (const h of mod.hooks.onMessage || []) this.hooks.onMessage.push(h);
        }
        loaded.push(id);
      } catch (e) {
        // skip broken plugins
      }
    }
    return loaded;
  }

  getTool(name) { return this.tools.get(name); }
  listTools() { return [...this.tools.keys()]; }
  listPlugins() { return [...this.plugins.keys()]; }

  async runHook(name, ctx) {
    const list = this.hooks[name] || [];
    for (const h of list) {
      try { await h(ctx); } catch {}
    }
  }
}

module.exports = { PluginManager };