const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the OpenCode config the registry reads, and provide one skill in a
// config-declared skills.paths root and one disabled MCP server.
const ocDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-oc-'));
const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skills-'));
const skillDir = path.join(skillsRoot, 'flex-skill');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  '---\nname: flex-skill\ndescription: Prove on-demand skill loading works\n---\n# Flex Skill\nDo the thing.\n'
);
fs.writeFileSync(
  path.join(ocDir, 'opencode.jsonc'),
  JSON.stringify({
    skills: { paths: [skillsRoot] },
    mcp: {
      fake: {
        type: 'local',
        command: [process.execPath, path.join(__dirname, 'fixtures', 'fake-mcp.js')],
        enabled: false, // disabled in config; must still start on demand
      },
    },
  }, null, 2)
);
process.env.NEXUS_OPENCODE_DIR = ocDir;

const { CapabilityRegistry } = require('../core/inherit');
const { executeTool } = require('../core/tools');

test('discovers config-declared skills and servers without starting them', () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  assert.ok(reg.skills.some((s) => s.id === 'flex-skill'), 'skill from skills.paths discovered');
  assert.ok(reg.defs.fake, 'server recorded');
  assert.strictEqual(reg.toolCount(), 0, 'disabled server not started during discovery');
  const status = reg.status();
  assert.ok(status.servers.some((s) => s.name === 'fake' && s.onDemand), 'marked on-demand');
  reg.stopAll();
});

test('disabled server is refused by plain ensure', async () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  await assert.rejects(reg.ensure('fake'), /disabled/);
  reg.stopAll();
});

test('disabled server starts on demand and serves a plain tool call', async () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  const hit = await reg.resolveOrStart('mcp_fake_flex_echo');
  assert.ok(hit, 'on-demand resolution works for a disabled server');
  assert.strictEqual(hit.server, 'fake');
  assert.strictEqual(hit.tool, 'flex_echo');
  const out = await reg.callRaw('fake', 'flex_echo', { text: 'hello nexus' });
  assert.match(String(out), /ECHO:hello nexus/);
  reg.stopAll();
});

test('flattened native tool name mcp_fake_flex_echo routes end-to-end', async () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  const ctx = {
    registry: reg,
    root: process.cwd(),
    workspace: process.cwd(),
    systemAccess: false,
    emit: () => {},
  };
  const out = await executeTool('mcp_fake_flex_echo', { text: 'plain text works' }, ctx);
  assert.match(String(out), /ECHO:plain text works/);
  reg.stopAll();
});

test('mcp_start boots the server and lists tools', async () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  const ctx = {
    registry: reg,
    root: process.cwd(),
    workspace: process.cwd(),
    systemAccess: false,
    emit: () => {},
  };
  const out = await executeTool('mcp_start', { server: 'fake' }, ctx);
  assert.match(String(out), /flex_echo/);
  reg.stopAll();
});

test('skill tool lists and loads the config-declared skill', async () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  const ctx = {
    registry: reg,
    root: process.cwd(),
    workspace: process.cwd(),
    systemAccess: false,
    emit: () => {},
  };
  const listed = await executeTool('skill', {}, ctx);
  assert.match(String(listed), /flex-skill/);
  const loaded = await executeTool('skill', { id: 'flex-skill' }, ctx);
  assert.match(String(loaded), /Flex Skill/);
  reg.stopAll();
});

test('mcp_call executes by server/tool name', async () => {
  const reg = new CapabilityRegistry({ workspace: undefined, onLog: () => {} });
  reg.discover();
  const ctx = {
    registry: reg,
    root: process.cwd(),
    workspace: process.cwd(),
    systemAccess: false,
    emit: () => {},
  };
  const out = await executeTool('mcp_call', { server: 'fake', tool: 'flex_echo', args: { text: 'ok' } }, ctx);
  assert.match(String(out), /ECHO:ok/);
  reg.stopAll();
});
