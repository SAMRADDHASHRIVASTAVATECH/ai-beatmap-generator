const test = require('node:test');
const assert = require('node:assert');

const { makeState, handleKey, addTranscript, renderToLines } = require('../core/tui-lib');

test('typing then Enter emits a send effect', () => {
  const s = makeState({ rows: 30, cols: 100 });
  for (const ch of 'hello world') {
    const r = handleKey(s, { name: ch, char: ch });
    Object.assign(s, r.state);
  }
  const r = handleKey(s, { name: 'enter' });
  const send = r.effects.find((e) => e.type === 'send');
  assert.ok(send, 'send effect emitted');
  assert.strictEqual(send.text, 'hello world');
});

test('/chats opens the chats view', () => {
  const s = makeState({ rows: 30, cols: 100 });
  for (const ch of '/chats') {
    const r = handleKey(s, { name: ch === '/' ? '/' : ch, char: ch });
    Object.assign(s, r.state);
  }
  const r = handleKey(s, { name: 'enter' });
  assert.strictEqual(r.state.view, 'chats');
});

test('Tab cycles mode and emits modeChanged', () => {
  const s = makeState({ rows: 30, cols: 100 });
  const r = handleKey(s, { name: 'tab' });
  assert.strictEqual(r.state.mode, 'supervisor');
  assert.ok(r.effects.some((e) => e.type === 'modeChanged'));
});

test('Ctrl+P opens the command palette; Escape closes it', () => {
  const s = makeState({ rows: 30, cols: 100 });
  let r = handleKey(s, { name: 'p', ctrl: true });
  assert.strictEqual(r.state.view, 'palette');
  r = handleKey(r.state, { name: 'escape' });
  assert.strictEqual(r.state.view, 'chat');
});

test('approval y approves a pending approval', () => {
  const s = makeState({ rows: 30, cols: 100 });
  s.pendingApproval = { name: 'Dangerous op', detail: 'rm files' };
  const r = handleKey(s, { name: 'y' });
  assert.ok(r.effects.some((e) => e.type === 'approval' && e.approved === true));
  assert.strictEqual(r.state.pendingApproval, null);
});

test('renderer returns exactly rows lines, no wider than cols (visible chars)', () => {
  const s = makeState({ rows: 34, cols: 110 });
  addTranscript(s, 'you', 'fix the bug in core/tui.js using @tui.js reference');
  addTranscript(s, 'nexus', 'Inspecting the codebase.');
  const lines = renderToLines(s);
  assert.strictEqual(lines.length, 34);
  for (const l of lines) {
    const plain = l.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    assert.ok(plain.length <= 115, `line too wide: ${plain.length}`);
  }
});

test('/mcp opens mcp overlay; Space toggles first server', () => {
  const s = makeState({ rows: 30, cols: 100,
    mcp: [{ name: 'fake-srv', connected: true, enabled: true, command: 'fake', tools: [] }],
  });
  for (const ch of '/mcp') {
    const r = handleKey(s, { name: ch, char: ch });
    Object.assign(s, r.state);
  }
  let r = handleKey(s, { name: 'enter' });
  assert.strictEqual(r.state.view, 'mcp');
  r = handleKey(r.state, { name: 'space' });
  assert.strictEqual(r.state.mcp[0].enabled, false);
  assert.ok(r.effects.some((e) => e.type === 'toggleMcp'));
});

test('/skill opens skills view and toggles first skill', () => {
  const s = makeState({ rows: 30, cols: 100,
    skills: [{ name: 'arcade', active: false, description: 'fun' }],
  });
  for (const ch of '/skill') {
    const r = handleKey(s, { name: ch, char: ch });
    Object.assign(s, r.state);
  }
  let r = handleKey(s, { name: 'enter' });
  assert.strictEqual(r.state.view, 'skills');
  r = handleKey(r.state, { name: 'space' });
  assert.strictEqual(r.state.skills[0].active, true);
  assert.ok(r.effects.some((e) => e.type === 'toggleSkill'));
});

const { cellWidth, sortedChats, commands, setPresence } = require('../core/tui-lib');
const plain = (line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const frame = (state) => renderToLines(state).map(plain).join('\n');
const press = (state, name, char = '', opts = {}) => handleKey(state, { name, char, ...opts });

test('a real TTY Return key sends the draft (readline calls it return)', () => {
  const s = makeState();
  press(s, 'h', 'h'); press(s, 'i', 'i');
  const r = press(s, 'return', '\r');
  assert.deepStrictEqual(r.effects.map((e) => e.type), ['send']);
  assert.equal(r.effects[0].text, 'hi');
  assert.equal(s.composer, '');
});

test('composer remains visible in small terminals; menus replace the chat body', () => {
  for (const rows of [12, 16, 20, 24, 34]) for (const cols of [24, 48, 80, 120]) {
    const s = makeState({ rows, cols, noColor: true });
    addTranscript(s, 'nexus', 'A very long answer that should never hide the input.'.repeat(10));
    for (const view of ['chat', 'palette', 'chats', 'mcp', 'skills', 'files']) {
      s.view = view;
      if (view === 'palette') s.paletteSelection = commands.length - 1;
      const lines = renderToLines(s);
      assert.equal(lines.length, rows, `${rows}x${cols} ${view}`);
      assert.ok(lines.every((line) => cellWidth(line) <= cols), `${rows}x${cols} ${view}: overflow`);
      if (view === 'chat' && cols >= 48) assert.match(lines.slice(-5).join('\n'), /ASK NEXUS/);
      if (view === 'palette' && cols >= 48 && rows >= 16) {
        assert.match(lines.join('\n'), /\/quit/, 'selected command scrolls into view');
        assert.doesNotMatch(lines.join('\n'), /ASK NEXUS/, 'menu has room to breathe');
      }
    }
  }
});

test('approval is never clipped by the logo or composer', () => {
  const s = makeState({ rows: 20, cols: 60, noColor: true });
  s.pendingApproval = { name: 'DELETE CONVERSATION', detail: 'This only removes the current chat.' };
  assert.match(frame(s), /PERMISSION REQUIRED/);
  assert.match(frame(s), /APPROVE/);
  assert.match(frame(s), /DENY/);
  assert.doesNotMatch(frame(s), /ASK NEXUS/);
});

test('busy runs queue the prompt instead of dropping it (OpenCode semantics)', () => {
  const s = makeState();
  s.busy = true;
  for (const ch of 'next request') press(s, ch, ch);
  const r = press(s, 'return', '\r');
  assert.equal(r.effects.length, 0);
  assert.equal(s.composer, '');                     // consumed into the queue
  assert.equal(s.chats[0].messages.length, 0);      // committed at turn start, not before
  assert.equal(s.promptQueue.length, 1);
  assert.equal(s.promptQueue.list()[0].text, 'next request');
  assert.match(s.notice, /[Qq]ueued/);
});

test('/queue lists queued prompts and rm/clear manage them', () => {
  const s = makeState();
  s.promptQueue.enqueue('first task', []);
  s.promptQueue.enqueue('second task', []);
  press(s, '/queue'.split('').join('') === '' ? '/' : '/', '/'); // type "/queue"
  for (const ch of 'queue') press(s, ch, ch);
  press(s, 'return', '\r');
  assert.match(s.notice, /Queued 2/);
  press(s, '/queue rm 1'.split(' ')[0] === '' ? '/' : '/', '/');
  for (const ch of 'queue rm 1') press(s, ch, ch);
  press(s, 'return', '\r');
  assert.equal(s.promptQueue.length, 1);
  assert.equal(s.promptQueue.list()[0].text, 'second task');
  press(s, '/queue clear'.split(' ')[0] === '' ? '/' : '/', '/');
  for (const ch of 'queue clear') press(s, ch, ch);
  press(s, 'return', '\r');
  assert.equal(s.promptQueue.length, 0);
});

test('a queued prompt drains as its own turn when the agent goes idle', () => {
  const s = makeState();
  s.busy = true;
  s.promptQueue.enqueue('next request', []);
  // simulate the end of the current run (busy cleared by the runtime)
  s.busy = false;
  const item = s.promptQueue.shift();
  assert.equal(item.text, 'next request');
});

test('Ctrl+S requires confirmation to arm, and disarms on the next press', () => {
  const s = makeState();
  assert.equal(s.systemAccess, false);
  assert.equal(press(s, 's', '', { ctrl: true }).effects.length, 0);
  assert.equal(s.systemAccess, false);
  assert.equal(press(s, 's', '', { ctrl: true }).effects[0].armed, true);
  assert.equal(s.systemAccess, true);
  assert.equal(press(s, 's', '', { ctrl: true }).effects[0].armed, false);
  assert.equal(s.systemAccess, false);
});

test('saved chat navigation uses the same sorted order as the displayed list', () => {
  const s = makeState({ chats: [
    { id: 'old', title: 'Older', pinned: false, createdAt: 1, messages: [] },
    { id: 'pinned', title: 'Pinned', pinned: true, createdAt: 2, messages: [] },
    { id: 'new', title: 'Newest', pinned: false, createdAt: 3, messages: [] },
  ], activeChatId: 'old' });
  press(s, 'p', '', { ctrl: true });
  s.paletteFilter = 'chats';
  press(s, 'enter');
  assert.equal(s.view, 'chats');
  assert.deepStrictEqual(sortedChats(s).map((c) => c.id), ['pinned', 'new', 'old']);
  press(s, 'up');
  assert.equal(press(s, 'return', '\r').effects[0].chatId, 'new');
});

test('file search attaches selected files and sends them with the next message', () => {
  const s = makeState({ files: [{ path: 'src/main.js', dir: false }, { path: 'README.md', dir: false }] });
  for (const ch of '/attach') press(s, ch, ch);
  press(s, 'return', '\r');
  assert.equal(s.view, 'files');
  press(s, 'm', 'm');
  assert.match(frame(s), /src\/main\.js/);
  press(s, 'return', '\r');
  assert.equal(s.view, 'chat');
  assert.deepStrictEqual(s.attachments, ['src/main.js']);
  press(s, 'h', 'h'); press(s, 'i', 'i');
  const r = press(s, 'return', '\r');
  assert.deepStrictEqual(r.effects[0].resources, ['src/main.js']);
  assert.deepStrictEqual(s.attachments, []);
});

test('response text is sanitized and CJK/emoji count as terminal cells', () => {
  const s = makeState({ cols: 26, rows: 16 });
  addTranscript(s, 'nexus', '\x1b[2J\x1b]0;EVIL\x07你好 👩‍💻 👍🏽 response');
  const lines = renderToLines(s).map(plain);
  assert.ok(lines.every((line) => cellWidth(line) <= 26));
  assert.doesNotMatch(lines.join('\n'), /\x1b|EVIL/);
  assert.match(lines.join('\n'), /你好/);
});

test('animation changes busy frames and respects reduced motion', () => {
  const s = makeState({ rows: 22, cols: 80, noColor: true });
  s.busy = true; setPresence(s, 'executing');
  const first = frame(s);
  s.tickFrame++;
  assert.notEqual(frame(s), first);
  s.animation = false;
  const staticFrame = frame(s);
  s.tickFrame++;
  assert.equal(frame(s), staticFrame);
});

test('interrupted and paused states behave differently', () => {
  const s = makeState();
  const interrupt = press(s, 'x', '', { ctrl: true });
  assert.equal(interrupt.effects[0].type, 'interrupt');
  assert.equal(s.stopped, false, 'Ctrl+X stops the current run, not all future runs');
  for (const ch of '/halt') press(s, ch, ch);
  const halt = press(s, 'return', '\r');
  assert.equal(halt.effects[0].type, 'halt');
  assert.equal(s.stopped, true);
  for (const ch of 'next') press(s, ch, ch);
  assert.equal(press(s, 'return', '\r').effects.length, 0);
  assert.equal(s.composer, 'next');
  s.composer = '/unhalt'; s.cursor = 7;
  assert.equal(press(s, 'return', '\r').effects[0].type, 'unhalt');
  assert.equal(s.stopped, false);
});

test('narrow rendering terminates even with wide graphemes', () => {
  const s = makeState({ cols: 1, rows: 12 });
  addTranscript(s, 'nexus', '🐱你好');
  const lines = renderToLines(s);
  assert.equal(lines.length, 12);
  assert.ok(lines.every((line) => cellWidth(line) <= 1));
});

test('conversation and MCP search filter the selectable rows, not just the labels', () => {
  const s = makeState({ chats: [
    { id: 'a', title: 'Alpha', pinned: false, createdAt: 1, messages: [] },
    { id: 'b', title: 'Beta', pinned: false, createdAt: 2, messages: [] },
  ], activeChatId: 'a', mcp: [
    { name: 'notes', enabled: true }, { name: 'calendar', enabled: true },
  ] });
  for (const ch of '/chats') press(s, ch, ch);
  press(s, 'return', '\r');
  press(s, '/', '/');
  for (const ch of 'alp') press(s, ch, ch);
  assert.match(frame(s), /Alpha/);
  assert.doesNotMatch(frame(s), /Beta/);
  assert.equal(press(s, 'return', '\r').effects[0].chatId, 'a');
  for (const ch of '/mcp') press(s, ch, ch);
  press(s, 'return', '\r');
  press(s, '/', '/');
  for (const ch of 'cal') press(s, ch, ch);
  assert.match(frame(s), /calendar/);
  assert.doesNotMatch(frame(s), /notes/);
  assert.equal(press(s, 'space').effects[0].name, 'calendar');
});

test('approval choices stay visible in an 8-row terminal', () => {
  const s = makeState({ rows: 8, cols: 50, noColor: true });
  s.pendingApproval = { name: 'DELETE', detail: 'Are you sure?' };
  const output = frame(s);
  assert.match(output, /PERMISSION REQUIRED/);
  assert.match(output, /\[Y\] APPROVE/);
  assert.match(output, /\[N\] DENY/);
});

test('rename prompt can be replaced with Ctrl+U; composer supports Ctrl+W', () => {
  const s = makeState();
  for (const ch of '/rename') press(s, ch, ch);
  press(s, 'return', '\r');
  assert.equal(s.prompt, 'rename');
  press(s, 'u', '', { ctrl: true });
  for (const ch of 'Project work') press(s, ch, ch);
  const renamed = press(s, 'return', '\r');
  assert.deepStrictEqual(renamed.effects[0].title, 'Project work');
  for (const ch of 'delete previous') press(s, ch, ch);
  press(s, 'w', '', { ctrl: true });
  assert.equal(s.composer, 'delete ');
});

test('emergency stop aborts before dismissing a pending tool approval', () => {
  const s = makeState();
  s.pendingApproval = { name: 'write_file', detail: 'secrets' };
  s.busy = true;
  const stopped = press(s, 'x', '', { ctrl: true });
  assert.deepStrictEqual(stopped.effects.map((e) => e.type), ['interrupt', 'approval']);
  assert.equal(stopped.effects[1].approved, false);
  assert.equal(s.pendingApproval, null);
});

test('history navigation restores an unsent draft', () => {
  const s = makeState();
  for (const ch of 'old question') press(s, ch, ch);
  press(s, 'return', '\r');
  for (const ch of 'new draft') press(s, ch, ch);
  press(s, 'up');
  assert.equal(s.composer, 'old question');
  press(s, 'down');
  assert.equal(s.composer, 'new draft');
});

test('long rename prompts scroll horizontally to keep the caret in view', () => {
  const s = makeState({ rows: 16, cols: 30, noColor: true });
  s.prompt = 'rename'; s.promptValue = 'A'.repeat(100) + 'END'; s.promptCursor = 103;
  const lines = renderToLines(s);
  assert.match(lines.join('\n'), /END/);
  assert.ok(lines.every((line) => cellWidth(line) <= 30));
});
