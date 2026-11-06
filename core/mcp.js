'use strict';

/**
 * Minimal MCP (Model Context Protocol) client for Nexus.
 *
 * Transports:
 *   - stdio  : spawn a process, newline-delimited JSON-RPC 2.0
 *   - http   : POST JSON-RPC, accepts application/json or text/event-stream
 *
 * Only what an agent needs: initialize, tools/list, tools/call.
 */

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PROTOCOL = '2024-11-05';

class StdioTransport {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.alive = false;
    this.stderrTail = '';
  }

  async start(timeoutMs = 30000) {
    const argv = this.cfg.command || [];
    if (!argv.length) throw new Error('no command');
    const [bin, ...args] = argv;
    this.proc = spawn(bin, args, {
      cwd: this.cfg.cwd || process.cwd(),
      env: { ...process.env, ...(this.cfg.environment || this.cfg.env || {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-1200);
    });
    this.proc.on('exit', () => {
      this.alive = false;
      for (const [, p] of this.pending) p.reject(new Error(`server "${this.name}" exited`));
      this.pending.clear();
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        return; // servers sometimes log plain text
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`spawn timeout for ${bin}`)), timeoutMs);
      this.proc.once('spawn', () => { clearTimeout(t); resolve(); });
      this.proc.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    this.alive = true;
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.alive) return Promise.reject(new Error(`server "${this.name}" is not running`));
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method, params) {
    if (!this.alive) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {}
  }

  stop() {
    this.alive = false;
    try { this.proc?.kill(); } catch {}
  }
}

class HttpTransport {
  constructor(name, cfg) {
    this.name = name;
    this.url = cfg.url;
    this.headers = cfg.headers || {};
    this.sessionId = null;
    this.nextId = 1;
    this.alive = true;
  }

  async start() {
    if (!this.url) throw new Error('no url');
    this.alive = true;
  }

  async request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctrl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const msg = JSON.parse(t.slice(5).trim());
            if (msg.id === id) {
              if (msg.error) throw new Error(msg.error.message || 'rpc error');
              return msg.result;
            }
          } catch (e) {
            if (e.message && !e.message.startsWith('Unexpected')) throw e;
          }
        }
        throw new Error('no response in event stream');
      }

      const msg = JSON.parse(text);
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    } finally {
      clearTimeout(timer);
    }
  }

  notify() {}
  stop() { this.alive = false; }
}

class McpServer {
  constructor(name, cfg, onLog = () => {}) {
    this.name = name;
    this.cfg = cfg;
    this.onLog = onLog;
    this.transport = cfg.url ? new HttpTransport(name, cfg) : new StdioTransport(name, cfg);
    this.tools = [];
    this.state = 'idle'; // idle | starting | ready | error
    this.error = '';
    this.startedAt = 0;
  }

  async start() {
    if (this.state === 'ready') return this;
    if (this.state === 'starting') {
      // another caller is already starting it
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (this.state === 'ready' || this.state === 'error') break;
      }
      if (this.state === 'ready') return this;
      throw new Error(this.error || 'startup failed');
    }
    this.state = 'starting';
    try {
      await this.transport.start();
      await this.transport.request(
        'initialize',
        {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          clientInfo: { name: 'nexus', version: '0.2.0' },
        },
        30000
      );
      this.transport.notify('notifications/initialized', {});
      const list = await this.transport.request('tools/list', {}, 30000);
      this.tools = (list?.tools || []).map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      }));
      this.state = 'ready';
      this.startedAt = Date.now();
      this.onLog(`mcp ${this.name}: ${this.tools.length} tools`);
      return this;
    } catch (e) {
      this.state = 'error';
      this.error = String(e.message || e).slice(0, 300);
      this.transport.stop();
      this.onLog(`mcp ${this.name}: ${this.error}`);
      throw e;
    }
  }

  async call(toolName, args) {
    if (this.state !== 'ready') await this.start();
    const r = await this.transport.request('tools/call', { name: toolName, arguments: args || {} }, 180000);
    const parts = (r?.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'json') return JSON.stringify(c.json);
      return `[${c.type}]`;
    });
    const out = parts.join('\n') || '(no content)';
    if (r?.isError) return `ERROR: ${out}`;
    return out;
  }

  stop() {
    this.transport.stop();
    this.state = 'idle';
    this.tools = [];
  }
}

module.exports = { McpServer, PROTOCOL };
