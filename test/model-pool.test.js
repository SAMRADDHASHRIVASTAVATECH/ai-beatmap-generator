'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lm = require('../core/lmstudio');
const { ModelPool } = require('../core/pool');

function setup() {
  const originals = { listModels: lm.listModels, loadModel: lm.loadModel, unloadModel: lm.unloadModel, chat: lm.chat };
  const ids = ['qwen3-4b-instruct-2507', 'qwen3.5-2b'];
  const loaded = new Set();
  const events = [];
  lm.listModels = async () => ids.map((key) => ({ key, loaded_instances: loaded.has(key) ? [{ id: key }] : [] }));
  lm.loadModel = async (id) => { loaded.add(id); events.push(`load:${id}`); return { instance_id: id }; };
  lm.unloadModel = async (_instance, id) => { loaded.delete(id); events.push(`unload:${id}`); };
  const pool = new ModelPool();
  pool._makeRoom = async () => {}; // deterministic regardless of host GPU
  return { pool, loaded, events, restore: () => Object.assign(lm, originals) };
}

test('different local model waits for active lease, then swaps safely', async () => {
  const { pool, loaded, events, restore } = setup();
  try {
    const first = await pool.lease('coder');
    let acquired = false;
    const next = pool.lease('scout').then((v) => { acquired = true; return v; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(acquired, false, 'second model must wait for the active lease');
    assert.deepEqual([...loaded], ['qwen3-4b-instruct-2507']);
    await assert.rejects(pool.unload('coder'), /in use/);
    first.release();
    first.release(); // release is idempotent
    const second = await next;
    assert.deepEqual([...loaded], ['qwen3.5-2b']);
    assert.deepEqual(events, ['load:qwen3-4b-instruct-2507', 'unload:qwen3-4b-instruct-2507', 'load:qwen3.5-2b']);
    second.release();
  } finally { restore(); }
});

test('leases for the same model share one loaded instance', async () => {
  const { pool, events, restore } = setup();
  try {
    const [a, b] = await Promise.all([pool.lease('coder'), pool.lease('coder')]);
    assert.equal(a.inst, b.inst);
    assert.equal(a.inst.refcount, 2);
    assert.deepEqual(events, ['load:qwen3-4b-instruct-2507']);
    a.release(); b.release();
    assert.equal(a.inst.refcount, 0);
  } finally { restore(); }
});

test('discovery never automatically unloads duplicate instances', async () => {
  const { pool, events, restore } = setup();
  try {
    lm.listModels = async () => [
      { key: 'qwen3-4b-instruct-2507', loaded_instances: [{ id: 'a' }, { id: 'b' }] },
      { key: 'qwen3.5-2b', loaded_instances: [] },
    ];
    await pool.sync();
    assert.equal(events.length, 0);
    await assert.rejects(pool.load('scout'), /multiple instances/);
    assert.equal(events.length, 0);
  } finally { restore(); }
});

test('unload failure is not mistaken for a successful model swap', async () => {
  const { pool, loaded, restore } = setup();
  try {
    await pool.load('coder');
    lm.unloadModel = async () => { throw new Error('unload failed'); };
    await assert.rejects(pool.load('scout'), /unload failed/);
    assert.deepEqual([...loaded], ['qwen3-4b-instruct-2507']);
    assert.equal(pool.resident.has('coder'), true);
    assert.equal(pool.resident.has('scout'), false);
  } finally { restore(); }
});
