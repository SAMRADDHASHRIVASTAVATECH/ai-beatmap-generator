'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runAgent } = require('../core/agent');

test('agent denied file write reports refusal to model and leaves file unchanged', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-approval-'));
  let calls = 0;
  let sawDenial = false;
  const pool = {
    async chat(_model, messages) {
      calls++;
      if (calls === 1) return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'not allowed' }) } }] } }] };
      sawDenial = messages.some((m) => m.role === 'tool' && /did not approve/.test(m.content));
      return { choices: [{ message: { role: 'assistant', content: 'The write was not approved.' } }] };
    },
  };
  try {
    const result = await runAgent({ prompt: 'write a file', modelKey: 'coder', workspace, pool, emit: () => {}, authorize: async () => false });
    assert.equal(result.text, 'The write was not approved.');
    assert.equal(sawDenial, true);
    await assert.rejects(fs.stat(path.join(workspace, 'blocked.txt')), { code: 'ENOENT' });
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
