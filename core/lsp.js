'use strict';

// LSP integration: spawn language servers and collect diagnostics.
const { spawn } = require('node:child_process');

class LspClient {
  constructor({ command, args = [], root } = {}) {
    this.command = command;
    this.args = args;
    this.root = root;
    this.proc = null;
    this.diagnostics = new Map();
    this.ready = false;
  }

  start() {
    if (!this.command) return false;
    try {
      this.proc = spawn(this.command, this.args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] });
      this.ready = true;
      this.proc.on('exit', () => { this.ready = false; });
      return true;
    } catch (e) {
      this.ready = false;
      return false;
    }
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.ready = false;
    }
  }

  // Send a JSON-RPC-ish request (simplified; real LSP requires Content-Length framing).
  request(method, params) {
    if (!this.proc || !this.ready) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e6);
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try { this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`); } catch { resolve(null); return; }
      // Simplified: resolve after timeout; real impl would parse responses.
      setTimeout(() => resolve(null), 200);
    });
  }

  getDiagnostics(uri) {
    return this.diagnostics.get(uri) || [];
  }
}

class LspManager {
  constructor() {
    this.clients = new Map();
  }

  register(language, client) {
    this.clients.set(language, client);
  }

  get(language) {
    return this.clients.get(language);
  }

  startAll() {
    for (const c of this.clients.values()) c.start();
  }

  stopAll() {
    for (const c of this.clients.values()) c.stop();
  }
}

module.exports = { LspClient, LspManager };