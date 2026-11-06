const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { ExperimentRegistry } = require('../core/experiments');

const dir = () => path.join(os.tmpdir(), `nexus-exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

test('records and lists experiments by kind and status', async () => {
  const reg = new ExperimentRegistry(dir());
  await reg.record({ kind: 'prompt', description: 'tighter system prompt', status: 'verified' });
  await reg.record({ kind: 'weight', baseModel: 'rnj-1-instruct', description: 'lora candidate', status: 'proposed' });
  const all = await reg.list();
  assert.strictEqual(all.length, 2);
  assert.strictEqual((await reg.list({ kind: 'weight' })).length, 1);
  assert.strictEqual((await reg.list({ status: 'verified' }))[0].kind, 'prompt');
});

test('weight experiments cannot be promoted unverified; approver required', async () => {
  const reg = new ExperimentRegistry(dir());
  const exp = await reg.record({ kind: 'weight', baseModel: 'rnj-1-instruct', status: 'proposed' });
  await assert.rejects(reg.promote(exp.id), /approver/);
  await assert.rejects(reg.promote(exp.id, { approvedBy: 'tester' }), /verified/);
  const ok = await reg.record({ kind: 'weight', baseModel: 'rnj-1-instruct', status: 'verified' });
  const promoted = await reg.promote(ok.id, { approvedBy: 'tester', reason: 'better benchmark' });
  assert.strictEqual(promoted.status, 'promoted');
});

test('comparison verdicts are sane', () => {
  const cmp = ExperimentRegistry.compare({ tool_call: 0.8, code_edit: 0.7 }, { tool_call: 0.6, code_edit: 0.5 });
  assert.strictEqual(cmp.verdict, 'better');
  const worse = ExperimentRegistry.compare({ a: 0.3 }, { a: 0.9 });
  assert.strictEqual(worse.verdict, 'worse');
  const none = ExperimentRegistry.compare({}, {});
  assert.strictEqual(none.verdict, 'inconclusive');
});

test('weight experiment scaffold never targets base weights', async () => {
  const reg = new ExperimentRegistry(dir());
  const { config } = await reg.scaffoldWeightExperiment({ baseModel: 'rnj-1-instruct', name: 'test' });
  assert.strictEqual(config.baseWeightsReadOnly, true);
  assert.ok(config.outputDir.includes(config.id));
});

test('lora tooling is detected honestly', async () => {
  const reg = new ExperimentRegistry(dir());
  const t = await reg.loraTooling();
  assert.strictEqual(typeof t.available, 'boolean');
});
