'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConversationStore, recentHistory } = require('../core/conversations');

test('conversation survives restart and stays separate per workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-memory-'));
  try {
    const a = path.join(root, 'project-a');
    const b = path.join(root, 'project-b');
    const first = new ConversationStore(root);
    await first.append(a, 'user', 'Remember my project');
    await first.append(a, 'assistant', 'I will remember.');
    await first.append(b, 'user', 'Another project');
    const restarted = new ConversationStore(root);
    assert.deepEqual((await restarted.read(a)).map((m) => m.content), ['Remember my project', 'I will remember.']);
    assert.deepEqual((await restarted.read(b)).map((m) => m.content), ['Another project']);
    if (process.platform !== 'win32') assert.equal((await fs.stat(restarted.file(a))).mode & 0o777, 0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bounded context excludes a dangling user request from an interrupted run', () => {
  const input = [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'done' },
    { role: 'user', content: 'interrupted' },
  ];
  assert.deepEqual(recentHistory(input), input.slice(0, 2));
  assert.ok(recentHistory(input, 4).reduce((sum, m) => sum + m.content.length, 0) <= 4);
});
