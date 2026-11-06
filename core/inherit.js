'use strict';

/**
 * Inherit OpenCode's capability surface.
 *
 *  - every MCP server declared in OpenCode's config files
 *  - every skill in the skill roots
 *
 * Nothing is copied or duplicated: Nexus reads the same files OpenCode reads,
 * so anything added to OpenCode shows up here on next boot.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { McpServer } = require('./mcp');

const HOME = os.homedir();

// ---------------------------------------------------------------- jsonc
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJsonc(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripJsonc(raw));
  } catch {
    return null;
  }
}

function configFiles(workspace) {
  const files = [];
  const envDir = process.env.NEXUS_OPENCODE_DIR || path.join(HOME, '.config', 'opencode');
  for (const f of ['opencode.jsonc', 'opencode.json', 'config.json']) {
    const p = path.join(envDir, f);
    if (fs.existsSync(p)) files.push(p);
  }
  if (workspace) {
    for (const f of ['opencode.jsonc', 'opencode.json']) {
      const p = path.join(workspace, f);
      if (fs.existsSync(p)) files.push(p);
    }
  }
  return files;
}

function collectServers(workspace) {
  const servers = {};
  const sources = [];
  for (const file of configFiles(workspace)) {
    const cfg = readJsonc(file);
    const block = cfg && cfg.mcp;
    if (!block || typeof block !== 'object') continue;
    let count = 0;
    for (const [name, def] of Object.entries(block)) {
      if (!def || typeof def !== 'object') continue;
      if (!def.command && !def.url) continue;
      servers[name] = def;
      count++;
    }
    sources.push({ file, servers: count });
  }
  return { servers, sources };
}

// ---------------------------------------------------------------- skills
function skillRoots(workspace) {
  const roots = [
    path.join(HOME, '.config', 'opencode', 'skills'),
    path.join(HOME, '.claude', 'skills'),
  ];
  if (process.env.NEXUS_SKILL_PATHS) {
    for (const p of process.env.NEXUS_SKILL_PATHS.split(';')) if (p.trim()) roots.push(p.trim());
  }
  // Every skill root declared in the opencode configs (skills.paths), in order.
  for (const file of configFiles(workspace)) {
    const cfg = readJsonc(file);
    const list = cfg && cfg.skills && Array.isArray(cfg.skills.paths) ? cfg.skills.paths : [];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      roots.push(path.isAbsolute(raw) ? raw : path.resolve(path.dirname(file), raw));
    }
  }
  const external = 'D:\\AI-Tools-Consolidated\\New folder\\opencode\\skills';
  if (fs.existsSync(external)) roots.push(external);
  if (workspace) roots.push(path.join(workspace, '.opencode', 'skills'));
  return [...new Set(roots)].filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

function listSkills(workspace) {
  const out = [];
  const seen = new Set();
  for (const root of skillRoots(workspace)) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(root, d.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const id = d.name;
      if (seen.has(id)) continue;
      seen.add(id);
      let head = '';
      try {
        head = fs.readFileSync(file, 'utf8').slice(0, 4000);
      } catch {
        continue;
      }
      const fm = parseFrontmatter(head);
      out.push({
        id,
        name: fm.name || id,
        description: (fm.description || '').slice(0, 300),
        file,
        root,
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- context
/**
 * OpenCode reads standing instructions from AGENTS.md and its global config.
 * Nexus reads the very same files so project rules carry over unchanged.
 */
function loadProjectContext(workspace) {
  const files = [
    { file: path.join(workspace || '', 'AGENTS.md'), cap: 5000 },
    { file: path.join(workspace || '', 'CLAUDE.md'), cap: 3000 },
    { file: path.join(HOME, '.config', 'opencode', 'global-instructions.md'), cap: 5000 },
  ];
  const parts = [];
  for (const { file, cap } of files) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 400_000) continue;
      let body = fs.readFileSync(file, 'utf8').trim();
      if (!body) continue;
      if (body.length > cap) body = body.slice(0, cap) + '\n… (truncated)';
      parts.push(`--- ${file} ---\n${body}`);
    } catch {
      // absent files are normal
    }
  }
  if (!parts.length) return '';
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- registry
const EAGER = (process.env.NEXUS_MCP_EAGER || 'olcap-web-browser,olcap-research-knowledge,olcap-data-automation-os,n8n-full,media-master,windows-system')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

/** Collapse a tool name to its letters/digits so separator mangling stops mattering. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

class CapabilityRegistry {
  constructor({ workspace, onLog = () => {} } = {}) {
    this.workspace = workspace;
    this.onLog = onLog;
    this.servers = new Map(); // name -> McpServer
    this.defs = {};
    this.sources = [];
    this.skills = [];
    this.lastError = '';
  }

  discover() {
    const { servers, sources } = collectServers(this.workspace);
    this.defs = servers;
    this.sources = sources;
    for (const name of Object.keys(servers)) {
      if (!this.servers.has(name)) {
        this.servers.set(name, new McpServer(name, servers[name], this.onLog));
      }
    }
    this.skills = listSkills(this.workspace);
    this.projectContext = loadProjectContext(this.workspace);
    // Inherit OpenCode permission rules from config.
    this.permissions = {};
    for (const file of configFiles(this.workspace)) {
      const cfg = readJsonc(file);
      if (cfg && cfg.permission && typeof cfg.permission === 'object') {
        Object.assign(this.permissions, cfg.permission);
      }
    }
    this.onLog(`inherited ${Object.keys(servers).length} mcp servers, ${this.skills.length} skills, ${Object.keys(this.permissions).length} permission rules`);
    if (this.projectContext) this.onLog(`inherited ${this.projectContext.length} chars of project instructions`);
    return this;
  }

  async ensure(name, opts = {}) {
    const srv = this.servers.get(name);
    if (!srv) throw new Error(`unknown mcp server "${name}"`);
    const disabled = !this.defs[name] || this.defs[name].enabled === false;
    if (disabled && !opts.allowDisabled) {
      const e = new Error(`mcp server "${name}" is disabled in the opencode config`);
      e.code = 'DISABLED';
      throw e;
    }
    if (disabled) this.onLog(`mcp ${name}: starting on demand (disabled in config)`);
    await srv.start();
    return srv;
  }

  /** Warm the eager set in the background; failures are recorded, not fatal. */
  warm() {
    const names = EAGER.filter((n) => this.servers.has(n) && this.defs[n] && this.defs[n].enabled !== false);
    const missing = EAGER.filter((n) => !this.servers.has(n));
    if (missing.length) this.onLog(`eager servers not in config: ${missing.join(', ')}`);
    let i = 0;
    const CONCURRENCY = 2;
    const worker = async () => {
      while (i < names.length) {
        const name = names[i++];
        try {
          await this.ensure(name);
        } catch {}
      }
    };
    Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      const ready = [...this.servers.values()].filter((s) => s.state === 'ready');
      this.onLog(`mcp warm-up done: ${ready.length} ready, ${this.toolCount()} tools`);
    });
  }

  toolCount() {
    let n = 0;
    for (const s of this.servers.values()) n += s.tools.length;
    return n;
  }

  /** Native tool schemas for every server that is already running. */
  schemas() {
    const out = [];
    for (const [name, srv] of this.servers) {
      if (srv.state !== 'ready') continue;
      for (const t of srv.tools) {
        out.push({
          type: 'function',
          function: {
            name: `mcp_${safe(name)}_${safe(t.name)}`.slice(0, 64),
            description: `[${name}] ${t.description}`.slice(0, 900),
            parameters: t.parameters,
          },
        });
      }
    }
    return out;
  }

  /** Map the flattened tool name back to (server, tool). */
  resolveTool(fullName) {
    for (const [name, srv] of this.servers) {
      if (srv.state !== 'ready') continue;
      for (const t of srv.tools) {
        if (`mcp_${safe(name)}_${safe(t.name)}`.slice(0, 64) === fullName) return { server: name, tool: t.name };
      }
    }
    return null;
  }

  /**
   * Tolerant resolver. Small models routinely mangle the flattened name: they
   * swap '-' for '_', drop a separator, or drop the "mcp_" prefix entirely.
   * Compare normalized names so those calls still land on the right tool.
   */
  resolveLoose(fullName) {
    const exact = this.resolveTool(fullName);
    if (exact) return exact;
    const want = normalize(fullName);
    let bare = null;
    let bareHits = 0;
    for (const [name, srv] of this.servers) {
      if (srv.state !== 'ready') continue;
      for (const t of srv.tools) {
        if (normalize(`mcp_${safe(name)}_${safe(t.name)}`) === want) return { server: name, tool: t.name };
        if (normalize(`mcp_${name}_${t.name}`) === want) return { server: name, tool: t.name };
        if (normalize(t.name) === want) {
          bare = { server: name, tool: t.name };
          bareHits += 1;
        }
      }
    }
    return bareHits === 1 ? bare : null;
  }

  /**
   * Resolve a flattened name, starting the owning server if it is still cold.
   * This is what makes inherited capability genuinely on-demand.
   */
  async resolveOrStart(fullName) {
    const hit = this.resolveLoose(fullName);
    if (hit) return hit;
    const want = normalize(fullName);
    const cold = [...this.servers.keys()].filter((n) => {
      const nn = normalize(n);
      return nn.length > 3 && want.includes(nn);
    });
    for (const name of cold.slice(0, 2)) {
      try {
        await this.ensure(name, { allowDisabled: true });
      } catch (e) {
        this.onLog(`cold start ${name} failed: ${e.message}`);
      }
      const again = this.resolveLoose(fullName);
      if (again) return again;
    }
    return null;
  }

  /** Every ready server that owns a tool whose name looks close to `fullName`. */
  suggest(fullName) {
    const want = normalize(fullName);
    const out = [];
    for (const [name, srv] of this.servers) {
      if (srv.state !== 'ready') continue;
      const byServer = want.includes(normalize(name));
      const tools = (srv.tools || []).filter((t) => {
        if (byServer) return true;
        const n = normalize(t.name);
        return n.length > 3 && (want.includes(n) || n.includes(want));
      });
      if (tools.length) out.push(`${name}: ${tools.slice(0, 10).map((t) => t.name).join(', ')}`);
    }
    return out.slice(0, 4);
  }

  async call(fullName, args) {
    const hit = this.resolveTool(fullName);
    if (!hit) return `ERROR: unknown mcp tool "${fullName}"`;
    return this.callRaw(hit.server, hit.tool, args);
  }

  async callRaw(server, tool, args, opts = {}) {
    const srv = await this.ensure(server, { allowDisabled: opts.allowDisabled !== false });
    this.onLog(`mcp call ${server}/${tool}`);
    return srv.call(tool, args);
  }

  status() {
    return {
      sources: this.sources,
      skills: this.skills.length,
      toolCount: this.toolCount(),
      servers: [...this.servers.entries()].map(([name, s]) => ({
        name,
        state: s.state,
        tools: s.tools.length,
        error: s.error || '',
        command: (this.defs[name]?.command || [this.defs[name]?.url || '']).join(' ').slice(0, 160),
        enabled: this.defs[name]?.enabled !== false,
        onDemand: this.defs[name] ? this.defs[name].enabled === false : false,
      })),
    };
  }

  async inspect(server, opts = {}) {
    const srv = await this.ensure(server, { allowDisabled: opts.allowDisabled !== false });
    return srv.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  stopAll() {
    for (const s of this.servers.values()) s.stop();
  }
}

module.exports = { CapabilityRegistry, listSkills, collectServers, stripJsonc };
