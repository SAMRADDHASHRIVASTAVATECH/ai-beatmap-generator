'use strict';

const fs = require('node:fs/promises');
const fss = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_READ_BYTES = 200_000;
const MAX_LIST = 400;

/**
 * Commands that are blocked even with full system access. These are the ones
 * that destroy the machine or make it unbootable in one line.
 */
const DENY = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bbcdedit\b.*\b(delete|set)\b/i,
  /\bvssadmin\b.*\bdelete\b/i,
  /\bcipher\s+\/w/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i,
  /\brd\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i,
  /\bremove-item\b.*-recurse.*\b[a-z]:\\?\s*$/i,
  /\\windows\\system32\b.*\b(del|rd|remove-item)\b/i,
  /\breg\s+delete\s+hklm\b/i,
];

function expandHome(p) {
  let s = String(p || '.');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  s = s.replace(/%([A-Za-z_]+)%/g, (m, name) => process.env[name] ?? m);
  return s;
}

/**
 * Workspace-sandboxed resolution. With `allowSystem` the agent may reach any
 * absolute path on the machine — the UI switch is the consent gate.
 */
function resolveInside(root, p, allowSystem = false) {
  const raw = expandHome(p);
  if (allowSystem) return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p} (turn on SYSTEM access to leave the workspace)`);
  }
  return abs;
}


async function walk(root, dir, out, depth = 0) {
  if (out.length >= MAX_LIST || depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_LIST) return;
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    out.push({ path: rel, dir: e.isDirectory() });
    if (e.isDirectory()) await walk(root, full, out, depth + 1);
  }
}

const SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root' },
          offset: { type: 'integer', description: '1-based first line (optional)' },
          limit: { type: 'integer', description: 'Max lines (optional, default 400)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with full content. Prefer edit_file for changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact unique string in a file. old_string must appear exactly once. Include enough surrounding context to be unique. This is the preferred way to change code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in the workspace, recursively (capped).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Defaults to workspace root' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search, default workspace root' },
          include: { type: 'string', description: 'File extension filter, e.g. ".js"' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace and return stdout/stderr. Use for tests, builds, git.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Working directory (absolute or ~). Defaults to the workspace root, or the home directory when system access is on.' },
          timeout_ms: { type: 'integer', description: 'Default 60000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Spawn a bounded subagent for a self-contained piece of work. The subagent has the same approval requirements and returns a summary. Tasks are executed sequentially by this harness. Use only when delegation adds value.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short 3-5 word label' },
          prompt: { type: 'string', description: 'Complete self-contained instructions' },
          agent: {
            type: 'string',
            description: 'Model profile (scout, coder, reader, planner, escalation) or an exact discovered local:<model-id>; use only models known to be available',
          },
        },
        required: ['description', 'prompt'],
      },
    },
  },
];

/** Extra tools unlocked only when the SYSTEM switch is on. */
const SYSTEM_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'open_path',
      description:
        'Open a file, folder, or URL with the operating system default application. Use to launch an app or show a result to the user.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~ path, or http(s) URL' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description:
        'Report host details: OS, CPU, memory, uptime, user, drives and free space. Call this before machine-wide work.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/**
 * Full-surface tools. These are always available — there is no degraded mode.
 * They mirror what OpenCode exposes, plus the inherited MCP and skill surface.
 */
const EXTRA_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files by glob pattern, e.g. "**/*.ts", "src/**/*.{js,jsx}". Returns matching paths sorted by newest first.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, ** and * supported' },
          path: { type: 'string', description: 'Directory to search, default workspace root' },
          limit: { type: 'integer', description: 'Max results, default 200' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'webfetch',
      description:
        'Fetch a URL and return its content as text, markdown or raw HTML. Use for documentation, APIs and pages the user links.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http:// or https:// URL' },
          format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Default markdown' },
          timeout_s: { type: 'integer', description: 'Default 30' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a multi-file patch. Accepts the "*** Begin Patch" format (*** Add File / *** Update File / *** Delete File) or a unified diff with ---/+++/@@ hunks. Use for coordinated changes across several files in one step.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The full patch text' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Replace the task list for the current job. Use it to track multi-step work so nothing is dropped. Pass an empty array to clear.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Ordered task list',
            items: {
              type: 'object',
              properties: {
                task: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
                note: { type: 'string' },
              },
              required: ['task'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_read',
      description: 'Read back the current task list with statuses.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill',
      description:
        'List or load an inherited skill. With no id, lists every available skill. With an id, returns that skill\'s full instructions to follow.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id to load; omit to list all' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_catalog',
      description:
        'List every inherited MCP server with its state and tool count, plus the number of skills available. Use this to discover what this machine can do.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Optional: show tools for one server' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_inspect',
      description:
        'Start an MCP server if needed and return the input schema of each of its tools, so you know the exact arguments to pass.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'MCP server name' } },
        required: ['server'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_start',
      description:
        'Start an MCP server by name (works for servers disabled in the opencode config too, they start on demand) and list the tools it exposes. Use this before mcp_call when you are unsure of exact tool names.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name, e.g. olcap-web-browser' },
        },
        required: ['server'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description:
        'Call any inherited MCP tool by server name and tool name. Use mcp_inspect first to learn the arguments.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name, e.g. olcap-web-browser' },
          tool: { type: 'string', description: 'Tool name on that server' },
          args: { type: 'object', description: 'Arguments object matching the tool schema' },
        },
        required: ['server', 'tool'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consult',
      description:
        'Ask a different local model for a second opinion, on demand. scout = fast lookup, planner = design/reasoning, reader = long-context, escalation = strongest reasoning. Use when stuck, when a decision matters, or to double-check your own answer before replying.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: ['scout', 'planner', 'reader', 'escalation'], description: 'Which core to consult' },
          question: { type: 'string', description: 'Self-contained question with all needed context' },
          max_tokens: { type: 'integer', description: 'Default 700' },
        },
        required: ['model', 'question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'experiment',
      description:
        'ON-DEMAND weight-space experiments. Directly edits a small network\'s weights (no gradients, no optimizer) and verifies the edit by measurement. Only call this when the user explicitly asks for a weight experiment, a LoRA/weight edit, or "the MIT weight-space thing" in this turn. Never run it as part of normal work. action=status reports what the machine can do; scaffold creates a directory but runs nothing; run REQUIRES approve:true plus a written reason; promote REQUIRES approved_by and verified evidence. Base model files are never modified.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'list', 'scaffold', 'run', 'promote'] },
          mode: { type: 'string', enum: ['synthetic', 'hf'], description: 'synthetic = fast crippled-MLP repair; hf = local causal-LM directory' },
          model_dir: { type: 'string', description: 'Local model directory for mode=hf' },
          name: { type: 'string', description: 'Experiment label' },
          id: { type: 'string', description: 'Experiment id for run/promote' },
          approve: { type: 'boolean', description: 'Must be true to run. Set only after the user explicitly approved this run' },
          reason: { type: 'string', description: 'Written reason, recorded in the registry' },
          approved_by: { type: 'string', description: 'Name recorded when promoting' },
          max_edit_fraction: { type: 'number', description: 'Fraction of a tensor that may change, default 0.0002' },
          scan_layers: { type: 'integer', description: 'hf mode: layers sampled for ablation' },
          max_new_tokens: { type: 'integer', description: 'hf mode: generation cap' },
          prompts: { type: 'array', items: { type: 'string' }, description: 'hf mode: evaluation prompts' },
          budget_evals: { type: 'integer', description: 'synthetic mode: how many candidate edits to evaluate' },
          timeout_min: { type: 'integer', description: 'Run timeout in minutes, default 30' },
        },
        required: ['action'],
      },
    },
  },
];

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/\\\\]*';
      }
    } else if (c === '?') {
      out += '.';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else if (c === '/') {
      out += '[\\\\/]';
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

async function globFiles(base, pattern, limit) {
  const re = globToRegExp(pattern.replace(/^\.\//, ''));
  const found = [];
  const stack = [base];
  let visited = 0;
  while (stack.length && found.length < limit && visited < 20000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (found.length >= limit) break;
      visited++;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (e.isDirectory()) stack.push(full);
      else if (re.test(rel)) {
        let mtime = 0;
        try {
          mtime = (await fs.stat(full)).mtimeMs;
        } catch {}
        found.push({ rel, mtime });
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.rel);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- patching
function applyUnifiedHunks(original, hunks) {
  const lines = original.split('\n');
  let cursor = 0;
  for (const h of hunks) {
    const want = h.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
    if (!want.length) continue;
    // find the context block at or after the cursor
    let at = -1;
    for (let i = cursor; i <= lines.length - want.length; i++) {
      let ok = true;
      for (let k = 0; k < want.length; k++) {
        if (lines[i + k] !== want[k]) { ok = false; break; }
      }
      if (ok) { at = i; break; }
    }
    if (at === -1) {
      // relax: try anywhere in the file
      for (let i = 0; i <= lines.length - want.length; i++) {
        let ok = true;
        for (let k = 0; k < want.length; k++) {
          if (lines[i + k] !== want[k]) { ok = false; break; }
        }
        if (ok) { at = i; break; }
      }
    }
    if (at === -1) throw new Error('patch context did not match the file');
    const replacement = h.lines.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1));
    lines.splice(at, want.length, ...replacement);
    cursor = at + replacement.length;
  }
  return lines.join('\n');
}

function parsePatchBlocks(patch) {
  // "*** Begin Patch" style
  const blocks = [];
  const lines = patch.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/);
    const upd = line.match(/^\*\*\* Update File:\s*(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    if (add || upd || del) {
      if (cur) blocks.push(cur);
      cur = { op: add ? 'add' : upd ? 'update' : 'delete', file: (add || upd || del)[1].trim(), lines: [] };
      continue;
    }
    if (/^\*\*\* End Patch/.test(line)) { if (cur) { blocks.push(cur); cur = null; } continue; }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function parseUnified(patch) {
  const files = [];
  const lines = patch.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^---\s+[ab]\/(.+)$/);
    const p = line.match(/^\+\+\+\s+[ab]\/(.+)$/);
    if (m) { cur = { file: m[1].trim(), lines: [] }; continue; }
    if (p && cur) { files.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  for (const f of files) {
    const hunks = [];
    let h = null;
    for (const line of f.lines) {
      if (line.startsWith('@@')) { if (h) hunks.push(h); h = { lines: [] }; continue; }
      if (!h) continue;
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (!line.length) continue;
      const c = line[0];
      if (c === ' ' || c === '+' || c === '-') h.lines.push(line);
    }
    if (h) hunks.push(h);
    f.hunks = hunks;
  }
  return files;
}

function buildPatchHunks(blockLines) {
  const hunks = [];
  let h = null;
  for (const line of blockLines) {
    if (line.startsWith('@@')) { if (h) hunks.push(h); h = { lines: [] }; continue; }
    if (!h) h = { lines: [] };
    if (!line.length) continue;
    const c = line[0];
    if (c === ' ' || c === '+' || c === '-') h.lines.push(line);
  }
  if (h) hunks.push(h);
  return hunks;
}

// ---------------------------------------------------------------- todos
const todoState = { items: [] };

/** MCP results arrive as objects or strings; keep them readable and bounded. */
function stringifyMcp(out) {
  let text;
  if (typeof out === 'string') text = out;
  else {
    try {
      text = JSON.stringify(out, null, 2);
    } catch {
      text = String(out);
    }
  }
  if (text.length > 24_000) text = text.slice(0, 24_000) + '\n… (truncated)';
  return text;
}

async function executeTool(name, args, ctx) {
  const root = ctx.workspace;

  // Enforce inherited OpenCode permission rules when present.
  if (ctx.permissions && typeof ctx.permissions.match === 'function') {
    const action = ctx.permissions.match(name);
    if (action === 'deny') return `ERROR: permission denied for ${name} by inherited policy`;
  }

  // Enforce sandbox policy when present.
  if (ctx.sandbox && typeof ctx.sandbox.checkCommand === 'function') {
    if (name === 'run_command') {
      const c = ctx.sandbox.checkCommand(String((args || {}).command || ''));
      if (!c.ok) return `ERROR: ${c.reason}`;
    }
    for (const k of ['path', 'cwd']) {
      if (args && args[k]) {
        const r = ctx.sandbox.checkPath(String(args[k]));
        if (!r.ok) return `ERROR: ${r.reason}`;
      }
    }
  }

  // Flattened native MCP names (mcp_<server>_<tool>) are what the model sees
  // in its own tool list, so it calls them directly. Route those before the
  // builtin switch — the three builtin meta-tools keep their exact names.
  const META = new Set(['mcp_catalog', 'mcp_inspect', 'mcp_call', 'mcp_start']);
  if (ctx.registry && /^mcp[_-]/i.test(String(name)) && !META.has(name)) {
    const hit = await ctx.registry.resolveOrStart(name);
    if (hit) {
      if (ctx.emit) ctx.emit({ type: 'cap-log', message: `native tool ${hit.server}/${hit.tool}` });
      return stringifyMcp(await ctx.registry.callRaw(hit.server, hit.tool, args || {}));
    }
    const hints = ctx.registry.suggest(name) || [];
    return [
      `ERROR: no tool named "${name}" on any running server.`,
      hints.length ? `Did you mean one of these?\n${hints.join('\n')}` : 'Use mcp_catalog to see servers, then mcp_inspect <server> for exact tool names.',
    ].join('\n');
  }

  switch (name) {
    case 'read_file': {
      const abs = resolveInside(root, args.path, ctx.systemAccess);
      const stat = await fs.stat(abs);
      if (stat.size > MAX_READ_BYTES) {
        return `ERROR: file is ${Math.round(stat.size / 1024)} KB, too large. Use grep or read with offset/limit.`;
      }
      const raw = await fs.readFile(abs, 'utf8');
      const lines = raw.split('\n');
      const offset = Math.max(1, args.offset || 1);
      const limit = Math.max(1, Math.min(args.limit || 400, 2000));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return slice.map((l, i) => `${offset + i}: ${l}`).join('\n') || '(empty)';
    }

    case 'write_file': {
      const abs = resolveInside(root, args.path, ctx.systemAccess);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content ?? '', 'utf8');
      return `wrote ${args.path} (${String(args.content ?? '').length} chars)`;
    }

    case 'edit_file': {
      const abs = resolveInside(root, args.path, ctx.systemAccess);
      const raw = await fs.readFile(abs, 'utf8');
      const oldS = args.old_string ?? '';
      const newS = args.new_string ?? '';
      if (!oldS) return 'ERROR: old_string is empty';
      const first = raw.indexOf(oldS);
      if (first === -1) return 'ERROR: old_string not found in file. Read the file again and copy the exact text.';
      const second = raw.indexOf(oldS, first + oldS.length);
      if (second !== -1) return 'ERROR: old_string appears more than once. Add more surrounding context to make it unique.';
      await fs.writeFile(abs, raw.slice(0, first) + newS + raw.slice(first + oldS.length), 'utf8');
      return `edited ${args.path}`;
    }

    case 'list_dir': {
      const abs = resolveInside(root, args.path || '.', ctx.systemAccess);
      const out = [];
      await walk(abs, abs, out);
      if (!out.length) return '(empty)';
      return out.map((o) => (o.dir ? o.path + '/' : o.path)).join('\n');
    }

    case 'grep': {
      const base = resolveInside(root, args.path || '.', ctx.systemAccess);
      const re = new RegExp(args.pattern, 'i');
      const files = [];
      await walk(base, base, files);
      const hits = [];
      for (const f of files) {
        if (f.dir) continue;
        if (args.include && !f.path.endsWith(args.include)) continue;
        let text;
        const full = path.join(base, f.path);
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_READ_BYTES) continue;
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= 120) return hits.join('\n');
          }
        }
      }
      return hits.length ? hits.join('\n') : '(no matches)';
    }

    case 'run_command': {
      const cmd = String(args.command || '');
      if (!cmd.trim()) return 'ERROR: empty command';
      if (DENY.some((r) => r.test(cmd))) return 'ERROR: command blocked by safety policy (destructive system operation)';
      const timeout = Math.min(Math.max(args.timeout_ms || 60000, 1000), 300000);
      let cwd = root;
      if (ctx.systemAccess) {
        try {
          cwd = args.cwd ? resolveInside(root, args.cwd, true) : os.homedir();
          await fs.access(cwd);
        } catch {
          cwd = os.homedir();
        }
      }
      return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        execFile(
          isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
          isWindows ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
          { cwd, timeout, maxBuffer: 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            const parts = [];
            if (stdout) parts.push(stdout.trim());
            if (stderr) parts.push('[stderr]\n' + stderr.trim());
            if (err && err.killed) parts.push('[timed out]');
            else if (err && err.code) parts.push(`[exit ${err.code}]`);
            resolve(parts.join('\n').slice(0, 8000) || '(no output)');
          }
        );
      });
    }

    case 'open_path': {
      if (!ctx.systemAccess) return 'ERROR: system access is off — turn on SYSTEM in the top bar';
      const { shell } = require('electron');
      const target = expandHome(args.path);
      if (/^https?:\/\//i.test(target)) {
        await shell.openExternal(target);
        return `opened url ${target}`;
      }
      const abs = resolveInside(root, target, true);
      const err = await shell.openPath(abs);
      return err ? `ERROR: ${err}` : `opened ${abs}`;
    }

    case 'system_info': {
      if (!ctx.systemAccess) return 'ERROR: system access is off — turn on SYSTEM in the top bar';
      const cpus = os.cpus();
      const totalGb = os.totalmem() / 1024 ** 3;
      const freeGb = os.freemem() / 1024 ** 3;
      const lines = [
        `host      : ${os.hostname()}`,
        `platform  : ${os.platform()} ${os.release()} (${os.arch()})`,
        `cpu       : ${cpus[0]?.model?.trim()} x${cpus.length}`,
        `memory    : ${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(1)} GB`,
        `uptime    : ${(os.uptime() / 3600).toFixed(1)} h`,
        `user      : ${os.userInfo().username}`,
        `home      : ${os.homedir()}`,
        `cwd(root) : ${root}`,
        `time      : ${new Date().toString()}`,
      ];
      const drives = await new Promise((resolve) => {
        execFile(
          'wmic',
          ['logicaldisk', 'get', 'caption,freespace,size', '/format:csv'],
          { timeout: 8000, windowsHide: true },
          (err, stdout) => resolve(err ? '' : stdout)
        );
      });
      if (drives) {
        const rows = drives
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z]:/.test(l.split(',')[0] || '') && l.includes(','));
        for (const r of rows.slice(0, 8)) {
          const [, free, size, cap] = r.split(',');
          if (!cap) continue;
          const f = Number(free) / 1024 ** 3;
          const s = Number(size) / 1024 ** 3;
          if (s > 0) lines.push(`drive ${cap} : ${f.toFixed(1)} GB free of ${s.toFixed(1)} GB`);
        }
      }
      return lines.join('\n');
    }

    case 'glob': {
      const base = resolveInside(root, args.path || '.', ctx.systemAccess);
      const limit = Math.max(1, Math.min(args.limit || 200, 1000));
      const hits = await globFiles(base, String(args.pattern || '**/*'), limit);
      return hits.length ? hits.join('\n') : '(no matches)';
    }

    case 'webfetch': {
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) return 'ERROR: url must start with http:// or https://';
      const timeout = Math.min(Math.max(args.timeout_s || 30, 3), 120) * 1000;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Nexus/0.3',
            Accept: 'text/html,application/json,text/plain,*/*',
          },
        });
        const raw = (await res.text()).slice(0, 400_000);
        if (!res.ok) return `ERROR: HTTP ${res.status} ${res.statusText}\n${raw.slice(0, 600)}`;
        const type = res.headers.get('content-type') || '';
        const format = args.format || 'markdown';
        if (format === 'html' || /json|plain|xml|csv|javascript/.test(type)) {
          return `${url}\n${res.status} ${type}\n\n${raw.slice(0, 60_000)}`;
        }
        const body = htmlToText(raw);
        return `${url}\n${res.status} ${type}\n\n${body.slice(0, 60_000) || '(no readable text)'}`;
      } catch (e) {
        return `ERROR: fetch failed: ${e.message}`;
      } finally {
        clearTimeout(timer);
      }
    }

    case 'apply_patch': {
      const patch = String(args.patch || '');
      if (!patch.includes('*** ') && !patch.includes('@@')) {
        return 'ERROR: patch must contain *** Add/Update/Delete File blocks or @@ hunks';
      }
      const done = [];
      if (patch.includes('*** ')) {
        for (const b of parsePatchBlocks(patch)) {
          const abs = resolveInside(root, b.file, ctx.systemAccess);
          if (b.op === 'add') {
            const content = b.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, content, 'utf8');
            done.push(`added ${b.file}`);
          } else if (b.op === 'delete') {
            await fs.rm(abs, { force: true });
            done.push(`deleted ${b.file}`);
          } else {
            const original = await fs.readFile(abs, 'utf8');
            const next = applyUnifiedHunks(original, buildPatchHunks(b.lines));
            await fs.writeFile(abs, next, 'utf8');
            done.push(`updated ${b.file}`);
          }
        }
      } else {
        for (const f of parseUnified(patch)) {
          const abs = resolveInside(root, f.file, ctx.systemAccess);
          const original = await fs.readFile(abs, 'utf8');
          const next = applyUnifiedHunks(original, f.hunks);
          await fs.writeFile(abs, next, 'utf8');
          done.push(`updated ${f.file}`);
        }
      }
      return done.length ? done.join('\n') : 'ERROR: patch contained no applicable changes';
    }

    case 'todo_write': {
      const items = Array.isArray(args.todos) ? args.todos : [];
      todoState.items = items.map((t, i) => ({
        n: i + 1,
        task: String(t.task || ''),
        status: ['pending', 'in_progress', 'done', 'blocked'].includes(t.status) ? t.status : 'pending',
        note: t.note ? String(t.note) : '',
      }));
      if (ctx.emit) ctx.emit({ type: 'todos', items: todoState.items });
      return todoState.items.length
        ? todoState.items.map((t) => `${t.n}. [${t.status}] ${t.task}${t.note ? ' — ' + t.note : ''}`).join('\n')
        : '(task list cleared)';
    }

    case 'todo_read': {
      if (!todoState.items.length) return '(no tasks)';
      return todoState.items.map((t) => `${t.n}. [${t.status}] ${t.task}${t.note ? ' — ' + t.note : ''}`).join('\n');
    }

    case 'skill': {
      const reg = ctx.registry;
      if (!reg) return 'ERROR: capability registry unavailable';
      if (!args.id) {
        const list = reg.skills || [];
        if (!list.length) return '(no skills found on this machine)';
        return list.map((s) => `${s.id} — ${s.description || s.name}`).join('\n');
      }
      const hit = (reg.skills || []).find((s) => s.id === args.id || s.name === args.id);
      if (!hit) return `ERROR: no skill "${args.id}". Use skill with no id to list them.`;
      const text = await fs.readFile(hit.file, 'utf8');
      return text.slice(0, 30_000);
    }

    case 'mcp_catalog': {
      const reg = ctx.registry;
      if (!reg) return 'ERROR: capability registry unavailable';
      const st = reg.status();
      if (args.server) {
        const s = st.servers.find((x) => x.name === args.server);
        if (!s) return `ERROR: no mcp server "${args.server}"`;
        const tools = s.state === 'ready' ? (await reg.inspect(args.server)).map((t) => t.name) : [];
        return [
          `server   : ${s.name}`,
          `state    : ${s.state}${s.error ? ' — ' + s.error : ''}`,
          `tools    : ${s.tools}`,
          `command  : ${s.command}`,
          tools.length ? `\n${tools.join('\n')}` : '(start it with mcp_inspect to see tools)',
        ].join('\n');
      }
      const lines = [
        `mcp servers : ${st.servers.length}   tools live : ${st.toolCount}   skills : ${st.skills}`,
        `config      : ${st.sources.map((s) => `${s.file} (${s.servers})`).join(', ') || 'none'}`,
        '',
        ...st.servers.map((s) => `${s.name.padEnd(28)} ${(s.onDemand ? 'on-demand' : s.state).padEnd(9)} ${String(s.tools).padStart(3)} tools${s.error ? '  ! ' + s.error : ''}`),
      ];
      return lines.join('\n');
    }

    case 'mcp_inspect': {
      const reg = ctx.registry;
      if (!reg) return 'ERROR: capability registry unavailable';
      const tools = await reg.inspect(args.server);
      if (!tools.length) return `(server "${args.server}" exposes no tools)`;
      return tools
        .map((t) => `${t.name}\n  ${String(t.description || '').slice(0, 240)}\n  args: ${JSON.stringify(t.parameters).slice(0, 700)}`)
        .join('\n\n');
    }

    case 'mcp_start': {
      const reg = ctx.registry;
      if (!reg) return 'ERROR: capability registry unavailable';
      try {
        const tools = await reg.inspect(args.server);
        return [
          `server ${args.server} is running with ${tools.length} tool(s).`,
          tools.map((t) => t.name).join(', '),
        ].join('\n');
      } catch (e) {
        return `ERROR: ${e.message}`;
      }
    }

    case 'mcp_call': {
      const reg = ctx.registry;
      if (!reg) return 'ERROR: capability registry unavailable';
      return stringifyMcp(await reg.callRaw(args.server, args.tool, args.args || {}));
    }

    case 'consult': {
      if (!ctx.pool) return 'ERROR: model pool unavailable';
      const which = String(args.model || 'planner');
      try {
        ctx.pool.spec(which);
      } catch {
        return `ERROR: unknown core "${which}"`;
      }
      const question = String(args.question || '').trim();
      if (!question) return 'ERROR: question is empty';
      if (ctx.emit) ctx.emit({ type: 'consult', model: which, question: question.slice(0, 160) });
      try {
        const res = await ctx.pool.chat(
          which,
          [
            {
              role: 'system',
              content:
                'You are a specialist core inside a team of local models. Another agent asked for your judgement. ' +
                'Answer directly and concretely. No preamble, no restating the question. If you are unsure, say what you would check.',
            },
            { role: 'user', content: question },
          ],
          null,
          { temperature: 0.25, max_tokens: Math.min(Math.max(args.max_tokens || 700, 128), 2000) }
        );
        const text = res?.choices?.[0]?.message?.content || '(no answer)';
        return `[${which}] ${text}`;
      } catch (e) {
        return `ERROR: consult ${which} failed: ${e.message}`;
      }
    }

    case 'task': {
      if (!ctx.spawnSubagent) return 'ERROR: subagents unavailable here';
      return ctx.spawnSubagent(args);
    }

    case 'experiment': {
      // On-demand only. Never infer an experiment from a normal request.
      const { probe, scaffold, run, list, promote } = require('./weight-edit');
      const action = String(args.action || 'status');
      try {
        if (action === 'status') return JSON.stringify(await probe(), null, 2);
        if (action === 'list') return JSON.stringify(await list({ workspace: ctx.workspace }), null, 2);
        if (action === 'scaffold') {
          const made = await scaffold({
            workspace: ctx.workspace,
            mode: args.mode || 'synthetic',
            modelDir: args.model_dir || null,
            name: args.name || '',
            config: {
              maxEditFraction: args.max_edit_fraction,
              scanLayers: args.scan_layers,
              maxNewTokens: args.max_new_tokens,
              prompts: args.prompts,
              budgetEvals: args.budget_evals,
            },
          });
          return `scaffolded ${made.id} at ${made.dir}\nNothing was run. Call experiment action=run with approve:true and a reason.`;
        }
        if (action === 'run') {
          const out = await run({
            workspace: ctx.workspace,
            id: args.id,
            approve: args.approve === true,
            reason: args.reason,
            timeoutMs: Math.min(Number(args.timeout_min) || 30, 240) * 60 * 1000,
            onLine: (line) => { if (ctx.emit) ctx.emit({ type: 'experiment-log', line }); },
          });
          return JSON.stringify(out, null, 2);
        }
        if (action === 'promote') {
          const promoted = await promote({
            workspace: ctx.workspace,
            id: args.id,
            approvedBy: args.approved_by,
            reason: args.reason,
          });
          return JSON.stringify(promoted, null, 2);
        }
        return `ERROR: unknown experiment action "${action}"`;
      } catch (e) {
        return `ERROR: experiment ${action} failed: ${e.message}`;
      }
    }

    default: {
      // Last chance: the model may have emitted a bare tool name without the
      // server prefix. Accept it when exactly one running server owns it.
      if (ctx.registry) {
        const hit = ctx.registry.resolveLoose(name);
        if (hit) return stringifyMcp(await ctx.registry.callRaw(hit.server, hit.tool, args || {}));
      }
      return `ERROR: unknown tool "${name}". Use mcp_catalog to list servers, mcp_inspect <server> to list tools.`;
    }
  }
}

module.exports = { SCHEMAS, SYSTEM_SCHEMAS, EXTRA_SCHEMAS, executeTool, resolveInside, todoState };
