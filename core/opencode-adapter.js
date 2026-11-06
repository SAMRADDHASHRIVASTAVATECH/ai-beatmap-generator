'use strict';

// Adapter boundary for the (not-yet-embedded) OpenCode harness.
// Nexus keeps its own runtime; this module defines the interface a future
// in-process OpenCode runtime must satisfy so callers can swap implementations
// without touching the UI.
class OpenCodeAdapter {
  constructor({ pool, workspace } = {}) {
    this.pool = pool;
    this.workspace = workspace;
    this.available = false;
  }

  async init() {
    // Detect an installed OpenCode CLI (not in-process, but usable as a tool).
    const fs = require('node:fs');
    const candidates = [
      'C:\\\\Users\\\\HP\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@opencode\\\\cli\\\\bin\\\\opencode.exe',
    ];
    this.available = candidates.some((c) => { try { return fs.existsSync(c); } catch { return false; } });
    return this.available;
  }

  async runSession({ prompt, modelKey, history = [] }) {
    if (!this.available) {
      return { ok: false, reason: 'OpenCode runtime not embedded; use Nexus native agent' };
    }
    return { ok: true, text: '' };
  }

  status() {
    return { available: this.available, mode: 'native-nexus', workspace: this.workspace };
  }
}

module.exports = { OpenCodeAdapter };