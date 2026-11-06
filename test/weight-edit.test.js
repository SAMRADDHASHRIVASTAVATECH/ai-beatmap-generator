const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Weight experiments are on demand only: they must refuse to run without an
// explicit approval plus a written reason, and must never target base weights.
test('weight experiment refuses to run without approval and records nothing', async () => {
  const { run, scaffold, list } = require('../core/weight-edit');
  const ws = path.join(os.tmpdir(), `nexus-we-${Date.now()}`);
  const made = await scaffold({ workspace: ws, mode: 'synthetic', name: 'gate test' });
  const refused = await run({ workspace: ws, id: made.id });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.refused, true);
  assert.match(refused.error, /approve:true/);
  const noReason = await run({ workspace: ws, id: made.id, approve: true });
  assert.strictEqual(noReason.refused, true);
  assert.ok((await list({ workspace: ws })).every((e) => !/run_/.test(e.id)));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('weight experiment scaffold writes config and never targets base weights', async () => {
  const { scaffold } = require('../core/weight-edit');
  const ws = path.join(os.tmpdir(), `nexus-we2-${Date.now()}`);
  const made = await scaffold({ workspace: ws, mode: 'synthetic', name: 'scaffold test' });
  const cfg = JSON.parse(fs.readFileSync(path.join(made.dir, 'edit.json'), 'utf8'));
  assert.strictEqual(cfg.base_weights_read_only, true);
  assert.strictEqual(cfg.mode, 'synthetic');
  assert.ok(cfg.max_edit_fraction > 0 && cfg.max_edit_fraction < 0.01);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('weight experiment probe reports what this machine can actually run', async () => {
  const { probe } = require('../core/weight-edit');
  const p = await probe();
  assert.strictEqual(p.on_demand_only, true);
  assert.strictEqual(typeof p.synthetic_ready, 'boolean');
  assert.strictEqual(typeof p.hf_ready, 'boolean');
  assert.ok(Array.isArray(p.missing));
  // synthetic mode needs nothing beyond python + torch
  if (p.synthetic_ready) assert.ok(p.python && p.torch);
});
