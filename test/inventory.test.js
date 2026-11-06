'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lm = require('../core/lmstudio');
const { ModelPool } = require('../core/pool');
const { normalizeInventory } = require('../core/inventory');

test('normalization retains observed metadata and leaves untested capabilities unknown', () => {
  const [model] = normalizeInventory([{ key: 'new-model', type: 'llm', architecture: 'reported-arch', quantization: { name: 'Q4' }, size_bytes: 1234, max_context_length: 4096, loaded_instances: [] }]);
  assert.equal(model.id, 'new-model');
  assert.equal(model.architecture, 'reported-arch');
  assert.equal(model.quantization, 'Q4');
  assert.equal(model.sizeBytes, 1234);
  assert.equal(model.maxContextLength, 4096);
  assert.equal(model.capabilities.tools, null);
  assert.equal(model.capabilities.vision, null);
});

test('discovers nine reported models without loading them; an additional model can be selected', async () => {
  const originals = { listModels: lm.listModels, loadModel: lm.loadModel, unloadModel: lm.unloadModel };
  const ids = ['qwen3-4b-instruct-2507', 'qwen3.5-2b', 'ministral-3-3b-instruct-2512', 'lfm3-vl-2b', 'rnj-1-instruct', 'extra-a', 'extra-b', 'extra-c', 'extra-d'];
  const loaded = new Set();
  let loads = 0;
  lm.listModels = async () => ids.map((key) => ({ key, type: 'llm', max_context_length: 4096, loaded_instances: loaded.has(key) ? [{ id: key }] : [] }));
  lm.loadModel = async (id) => { loads++; loaded.add(id); return { instance_id: id }; };
  lm.unloadModel = async (_instance, id) => { loaded.delete(id); };
  const pool = new ModelPool();
  pool._makeRoom = async () => {};
  try {
    await pool.sync();
    const status = await pool.status();
    assert.equal(status.inventory.length, 9);
    assert.equal(status.models.filter((x) => x.key.startsWith('local:')).length, 4);
    assert.equal(loads, 0, 'discovery must not load models');
    const lease = await pool.lease('local:extra-c');
    assert.equal(lease.inst.modelId, 'extra-c');
    assert.equal(loads, 1);
    lease.release();
    await pool.unload('local:extra-c');
    assert.equal(loaded.size, 0);
  } finally { Object.assign(lm, originals); }
});
