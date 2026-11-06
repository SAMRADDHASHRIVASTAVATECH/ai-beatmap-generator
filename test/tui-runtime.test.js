'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../core/chats');
const { createScreen, flattenFiles, fileContext, resolveFiles } = require('../core/tui-runtime');
const { runAgent } = require('../core/agent');
const { orchestrate } = require('../core/orchestrator');

test('completed turns save atomically; undo, duplicate and clear survive reload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tui-chat-'));
  try {
    const store = new ChatStore(root);
    const chat = await store.create();
    await store.appendTurn(chat.id, 'first question', 'first answer');
    await store.appendTurn(chat.id, 'second question', 'second answer');
    assert.equal((await store.get(chat.id)).messages.length, 4);
    assert.equal((await store.get(chat.id)).title, 'first question');
    assert.equal(await store.undoLastTurn(chat.id), true);
    assert.deepEqual((await store.get(chat.id)).messages.map((m) => m.content), ['first question', 'first answer']);
    const copy = await store.duplicate(chat.id);
    assert.equal(copy.messages.length, 2, 'duplicate includes message history');
    await store.replaceMessages(chat.id, []);
    assert.equal((await store.get(chat.id)).messages.length, 0);
    assert.equal((await store.get(copy.id)).messages.length, 2, 'clear only affects the selected chat');
    assert.equal(await store.undoLastTurn(chat.id), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('file context resolves only listed text files inside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tui-files-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const answer = 42;');
    await fs.writeFile(path.join(root, 'binary.png'), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(1_100_000));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'skip.js'), 'hidden');
    const files = flattenFiles(root);
    assert.ok(files.some((f) => f.path === 'src/app.js'));
    assert.ok(!files.some((f) => f.path.includes('node_modules')));
    const found = resolveFiles('@app.js what does this do?', [], files);
    assert.deepEqual(found.files, ['src/app.js']);
    const context = await fileContext(root, '@app.js please inspect', ['binary.png', 'large.txt'], files);
    assert.match(context.prompt, /export const answer = 42/);
    assert.ok(!context.prompt.includes('hidden'));
    assert.deepEqual(context.attached, ['src/app.js']);
    assert.equal(context.missing.length, 2);
    const escaped = await fileContext(root, '@../outside.txt', ['../outside.txt'], files);
    assert.equal(escaped.prompt, '@../outside.txt');
    assert.equal(escaped.attached.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('screen painter enters the alternate buffer, diffs rows, restores cursor', () => {
  const writes = [];
  const screen = createScreen({ write: (text) => writes.push(text) });
  screen.enter();
  screen.paint(['one', 'two']);
  const count = writes.length;
  screen.paint(['one', 'two']);
  assert.equal(writes.length, count, 'unchanged frames should not repaint');
  screen.paint(['one', 'three']);
  assert.match(writes.at(-1), /\x1b\[2;1Hthree/);
  assert.doesNotMatch(writes.at(-1), /one/);
  screen.leave();
  assert.match(writes[0], /\x1b\[\?1049h/);
  assert.match(writes.at(-1), /\x1b\[\?1049l/);
});

test('cancelled agent response never runs the returned tool calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tui-abort-'));
  const ctrl = new AbortController();
  let reply;
  const pool = { chat: () => new Promise((resolve) => { reply = resolve; }) };
  const running = runAgent({
    prompt: 'do not edit the file', modelKey: 'coder', workspace: root,
    pool, emit: () => {}, shouldAbort: () => ctrl.signal.aborted, signal: ctrl.signal,
  });
  try {
    while (!reply) await new Promise((resolve) => setImmediate(resolve));
    ctrl.abort();
    reply({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: '1', function: {
      name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist', content: 'bad' }),
    } }] } }] });
    const result = await running;
    assert.equal(result.cancelled, true);
    await assert.rejects(fs.access(path.join(root, 'should-not-exist')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('supervisor cancellation after planning does not dispatch its agents', async () => {
  const ctrl = new AbortController();
  const calls = [];
  const pool = { chat: async (name) => {
    calls.push(name);
    ctrl.abort();
    return { choices: [{ message: { content: '{"steps":[{"agent":"coder","task":"edit files"}]}' } }] };
  } };
  const result = await orchestrate({ prompt: 'edit files', workspace: os.tmpdir(), pool,
    emit: () => {}, shouldAbort: () => ctrl.signal.aborted, signal: ctrl.signal });
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, ['planner']);
});
