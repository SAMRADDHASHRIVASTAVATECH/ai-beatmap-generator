'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executeWithApproval, requiresApproval } = require('../core/approval');

test('sensitive and unknown tools fail closed when no approval is available', async () => {
  let executed = 0;
  const fn = async () => { executed++; return 'done'; };
  for (const name of ['write_file', 'run_command', 'webfetch', 'delete_everything']) {
    assert.equal(requiresApproval(name), true, name);
    assert.match(await executeWithApproval(name, {}, {}, fn), /approval unavailable/);
  }
  assert.equal(executed, 0);
});

test('only approved actions run; safe operations require no dialog', async () => {
  let executed = 0;
  const fn = async () => { executed++; return 'done'; };
  assert.match(await executeWithApproval('run_command', { command: 'echo x' }, { authorize: async () => false }, fn), /did not approve/);
  assert.equal(executed, 0);
  assert.equal(await executeWithApproval('run_command', { command: 'echo x' }, { authorize: async () => true }, fn), 'done');
  assert.equal(await executeWithApproval('read_file', { path: 'x' }, {}, fn), 'done');
  assert.equal(executed, 2);
});
