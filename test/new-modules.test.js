'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

test('memory search + checkpoint roundtrip', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  const { LongTermMemory, CheckpointStore } = require('../core/memory');
  const mem = new LongTermMemory(tmp);
  await mem.store('/ws', 'user', 'fix the login bug in auth module');
  await mem.store('/ws', 'assistant', 'patched token validation');
  const hits = mem.search('login auth', { workspace: '/ws' });
  assert.ok(hits.length >= 1);
  const cps = new CheckpointStore(tmp);
  await cps.save('run1', { phase: 'BUILD', done: true });
  const loaded = await cps.load('run1');
  assert.equal(loaded.phase, 'BUILD');
  const list = await cps.list();
  assert.ok(list.includes('run1'));
  await cps.remove('run1');
});

test('benchmark record + select', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  const { BenchmarkStore } = require('../core/benchmark');
  const b = new BenchmarkStore(tmp);
  await b.record('coder', { tool_call: 0.9, code_edit: 0.8 });
  await b.record('scout', { tool_call: 0.5 });
  assert.equal(b.select('tool_call', ['coder', 'scout']), 'coder');
  assert.ok(b.score('coder') > 0);
});

test('purple cycle transitions', () => {
  const { PurpleCycle } = require('../core/purple');
  const c = new PurpleCycle({ maxIterations: 2 });
  c.start('fix build');
  c.record('PLAN', 'pass');
  assert.equal(c.phase, 'IMPLEMENT');
  c.record('IMPLEMENT', 'pass');
  c.record('BUILD', 'fail', 'compile error');
  assert.equal(c.phase, 'DIAGNOSE');
});

test('orchestration parallel + verifier', async () => {
  const { ParallelExecutor, IndependentVerifier } = require('../core/orchestration');
  const pe = new ParallelExecutor({ concurrency: 2 });
  const r = await pe.run([async () => 1, async () => 2, async () => 3]);
  assert.deepEqual(r.map((x) => x.value), [1, 2, 3]);
  const v = new IndependentVerifier([{ name: 't', fn: async () => ({ ok: true, evidence: 'ok' }) }]);
  const res = await v.verify({});
  assert.equal(res.passed, true);
});

test('sandbox policy + encrypted store', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  const { SandboxPolicy, EncryptedStore } = require('../core/sandbox');
  const sp = new SandboxPolicy({ workspace: tmp, allowNetwork: false, allowSystem: false });
  assert.equal(sp.checkPath(path.join(tmp, 'a.txt')).ok, true);
  assert.equal(sp.checkPath('C:\\Windows\\system32').ok, false);
  assert.equal(sp.checkCommand('curl http://x').ok, false);
  const es = new EncryptedStore(tmp, 'secret');
  await es.write('conv', { hello: 'world' });
  const data = await es.read('conv');
  assert.equal(data.hello, 'world');
});

test('integrations csv + deck', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  const { writeCsv, readCsv, writeDeck, readDeck } = require('../core/integrations');
  await writeCsv(path.join(tmp, 'a.csv'), [['a', 'b'], ['1', '2']]);
  const rows = await readCsv(path.join(tmp, 'a.csv'));
  assert.equal(rows[0][0], 'a');
  await writeDeck(path.join(tmp, 'd.json'), [{ title: 's1' }]);
  const deck = await readDeck(path.join(tmp, 'd.json'));
  assert.equal(deck.slides.length, 1);
});

test('opencode adapter status', () => {
  const { OpenCodeAdapter } = require('../core/opencode-adapter');
  const a = new OpenCodeAdapter({ workspace: '/ws' });
  assert.equal(a.status().available, false);
});

test('session create/append/list', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  const { SessionManager } = require('../core/session');
  const sm = new SessionManager(tmp);
  const s = await sm.create({ workspace: '/ws', title: 't' });
  await sm.appendMessage(s.id, { role: 'user', content: 'hi' });
  const list = await sm.list();
  assert.equal(list.length, 1);
  const loaded = await sm.load(s.id);
  assert.equal(loaded.messages.length, 1);
});

test('plugin manager loads', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
  const { PluginManager } = require('../core/plugin');
  const pm = new PluginManager();
  await fs.writeFile(path.join(tmp, 'p.js'), 'module.exports = { id: "p", tools: [{ name: "t", run: async () => "ok" }], hooks: { beforeTool: [async (c) => { c.touched = true; }] } };');
  const loaded = await pm.loadDir(tmp);
  assert.ok(loaded.includes('p'));
  assert.ok(pm.getTool('t'));
});

test('permissions wildcard', () => {
  const { PermissionManager } = require('../core/permissions');
  const pm = new PermissionManager({ 'read_file': 'allow', 'mcp_*': 'ask' });
  assert.equal(pm.match('read_file'), 'allow');
  assert.equal(pm.match('mcp_foo'), 'ask');
  assert.equal(pm.match('write_file'), 'ask');
});

test('lsp manager', () => {
  const { LspManager, LspClient } = require('../core/lsp');
  const m = new LspManager();
  m.register('js', new LspClient({ command: null }));
  assert.ok(m.get('js'));
});