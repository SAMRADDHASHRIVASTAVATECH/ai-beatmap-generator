'use strict';

/**
 * Capability manifest: a persistent, machine-generated guide to everything this
 * box can do — every configured MCP server and every skill — embedded in the
 * harness (system prompt), so the model does not have to guess.
 *
 * Two data sources, always both used:
 *   1. Static (always available, zero process starts): config command, cwd,
 *      package.json description, skill frontmatter.
 *   2. Measured (NEXUS_CAPABILITY_MEASURE=1 or `npm run capabilities -- --measure`):
 *      starts each server once, records its tool count + first-run errors.
 *      The result is cached under .nexus/capabilities.json so eager cost is paid
 *      once per config change, not per turn.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { CapabilityRegistry, collectServers, listSkills } = require('./inherit');

const MANIFEST_NAME = 'capabilities.json';

async function measureServers(workspace, onLog = () => {}) {
  // Lazy: run only when explicitly asked. Servers return to idle afterwards.
  const reg = new CapabilityRegistry({ workspace, onLog });
  reg.discover();
  const out = {};
  for (const name of Object.keys(reg.defs)) {
    try {
      const tools = await reg.inspect(name);
      out[name] = { ok: true, tools: tools.length, sample: tools.slice(0, 30).map((t) => t.name) };
    } catch (e) {
      out[name] = { ok: false, error: String(e.message || e).slice(0, 240) };
    }
  }
  reg.stopAll();
  return out;
}

async function buildManifest({ workspace, measure = false, onLog = () => {} } = {}) {
  const file = path.join(workspace || process.cwd(), '.nexus', MANIFEST_NAME);
  const { servers, sources } = collectServers(workspace);
  const skills = listSkills(workspace);
  let measured = null;
  if (measure && process.env.NEXUS_CAPABILITY_MEASURE !== '0') {
    onLog(`measuring ${Object.keys(servers).length} servers once (offline starts)…`);
    try {
      measured = await measureServers(workspace, onLog);
    } catch (e) {
      onLog(`measurement failed: ${e.message}`);
    }
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    measured: Boolean(measured),
    sources: sources.map((s) => ({ file: s.file, servers: s.servers })),
    servers: Object.entries(servers).map(([name, def]) => ({
      name,
      command: (def.command || [def.url || '']).join(' ').slice(0, 160),
      enabled: def.enabled !== false,
      description: (typeof def.description === 'string' && def.description) || '',
      measured: measured ? measured[name] || null : null,
    })),
    skills: skills.map((s) => ({ id: s.id, description: String(s.description || '').slice(0, 140) })),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, file };
}

async function loadManifest(workspace) {
  const file = path.join(workspace || process.cwd(), '.nexus', MANIFEST_NAME);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compact system-prompt section. Budget-aware: when there are more skills than
 * fit, the index is cut and the prompt says exactly how to reach the rest.
 * This is what "teaches the harness every MCP and skill, in every way".
 */
function renderPromptSection(manifest, { charBudget = 6000 } = {}) {
  const lines = [];
  lines.push('## How to use everything on this machine (this is current and complete)');
  lines.push('');
  lines.push('Decision tree, in order:');
  lines.push('1. If the task matches a skill, call `skill <id>` first and follow those instructions. They are already vetted; do not improvise a manual when a skill exists.');
  lines.push('2. If the task needs the outside world or specialised tools (web, git, Android, SQL, media, browser, system), use an inherited MCP via `mcp_inspect <server>` then `mcp_call`, or call its native `mcp_<server>_<tool>` directly.');
  lines.push('3. Built-in file/grep/read/write/shell tools for code and local files.');
  lines.push('4. `run_command` only for what fits none of the above.');
  lines.push('');
  lines.push('MCP rules:');
  lines.push('- Servers marked on-demand start the moment you call one of their tools (or `mcp_start <server>`). A disabled-in-config server is NOT an unavailable server.');
  lines.push('- `mcp_inspect <server>` before calling anything unfamiliar; `mcp_catalog` to see all servers and their on-demand state; `mcp_call <server> <tool> <args>` as the escape hatch.');
  lines.push('- If a call fails: read the error, fix the arguments, retry once with `mcp_inspect` fresh. Never give up because of a naming error.');
  lines.push('');
  lines.push('Skill rules:');
  lines.push('- No skill id → `skill` lists every skill (id + one-line description).');
  lines.push('- Pick the skill whose description matches the task. Load it, then do exactly what it says.');
  lines.push('- Multi-skill tasks: load both; they compose.');
  lines.push('');
  const servers = manifest.servers || [];
  lines.push(`Configured MCP servers (${servers.length}):`);
  for (const s of servers) {
    const state = s.measured ? (s.measured.ok ? `measured ${s.measured.tools} tools` : 'measure FAILED') : (s.enabled ? 'ready-to-start' : 'on-demand');
    const desc = s.description ? ` — ${s.description.slice(0, 90)}` : '';
    lines.push(`- ${s.name} [${state}]${desc}`);
  }
  lines.push('');
  const skills = manifest.skills || [];
  lines.push(`Skills (${skills.length}). Use \`skill\` to list all with descriptions; the most useful start with your task:`);
  const perSkill = 64;
  let used = lines.join('\n').length;
  let shown = 0;
  for (const s of skills) {
    const line = `- ${s.id}${s.description ? ' — ' + s.description.slice(0, perSkill - s.id.length - 4) : ''}`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < skills.length) {
    lines.push(`… and ${skills.length - shown} more (call \`skill\` with no args to see them all).`);
  }
  return lines.join('\n');
}

module.exports = { buildManifest, loadManifest, renderPromptSection, MANIFEST_NAME };
