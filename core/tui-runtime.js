'use strict';

// I/O, persistence and agent wiring for the pure TUI in tui-lib.js. No Electron
// dependency: `node tui.js` works in a normal terminal on Windows/macOS/Linux.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const { ModelPool } = require('./pool');
const { runAgent } = require('./agent');
const { orchestrate, isComplex } = require('./orchestrator');
const { CapabilityRegistry } = require('./inherit');
const { ChatStore } = require('./chats');
const { McpServer } = require('./mcp');
const { AutomationBus } = require('./automation');
const lm = require('./lmstudio');
const voice = require('./voice');
const {
  makeState, renderToLines, handleKey, addTranscript, addActivity, setPresence,
  setNotice, newChat, getActiveChat, sortedChats,
} = require('./tui-lib');

const DATA_DIR = process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.config', 'opencode');
const MCP_STATE = path.join(DATA_DIR, 'nexus-mcp.json');
const EXTRA_MCP = path.join(DATA_DIR, 'nexus-extra.json');
const SKILLS_STATE = path.join(DATA_DIR, 'nexus-skills.json');

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
function setupRegistry(registry) {
  registry.discover();
  const extra = readJson(EXTRA_MCP, { mcp: {} });
  for (const [name, def] of Object.entries(extra.mcp || {})) {
    if (!def || !Array.isArray(def.command) || !def.command.length || registry.defs[name]) continue;
    registry.defs[name] = { ...def };
    registry.servers.set(name, new McpServer(name, def, () => {}));
  }
  const savedState = readJson(MCP_STATE, { disabled: [], enabled: [] });
  const disabled = new Set(Array.isArray(savedState?.disabled) ? savedState.disabled : []);
  const enabled = new Set(Array.isArray(savedState?.enabled) ? savedState.enabled : []);
  for (const name of disabled) if (registry.defs[name]) registry.defs[name].enabled = false;
  for (const name of enabled) if (registry.defs[name]) registry.defs[name].enabled = true;
  return registry;
}
function setMcpEnabled(registry, name, enabled) {
  const def = registry.defs[name];
  if (!def) throw new Error(`Unknown MCP server: ${name}`);
  def.enabled = enabled;
  const savedState = readJson(MCP_STATE, { disabled: [], enabled: [] });
  const disabled = new Set(Array.isArray(savedState?.disabled) ? savedState.disabled : []);
  const overrides = new Set(Array.isArray(savedState?.enabled) ? savedState.enabled : []);
  if (enabled) { disabled.delete(name); overrides.add(name); }
  else { disabled.add(name); overrides.delete(name); }
  writeJson(MCP_STATE, { disabled: [...disabled], enabled: [...overrides] });
  if (!enabled) registry.servers.get(name)?.stop();
}
function activeSkillsInject(registry) {
  const saved = readJson(SKILLS_STATE, { active: [] });
  const active = new Set(Array.isArray(saved?.active) ? saved.active : []);
  const content = [];
  for (const skill of registry.skills || []) {
    if (!active.has(skill.id)) continue;
    try { content.push(`### SKILL ${skill.id}\n${fs.readFileSync(skill.file, 'utf8').slice(0, 4000)}`); } catch {}
  }
  return content.length ? `ACTIVE SKILLS (follow them):\n${content.join('\n\n')}` : '';
}
function flattenFiles(workspace, limit = 600) {
  const files = [];
  const skip = new Set(['node_modules', '.git', '.nexus', '.venv', 'dist', 'build', 'out', 'target', '__pycache__']);
  function walk(dir, depth) {
    if (depth > 6 || files.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) files.push({ path: path.relative(workspace, full).replace(/\\/g, '/'), dir: false });
      else if (entry.isDirectory()) walk(full, depth + 1);
      // Do not follow symlinks when building file context.
    }
  }
  walk(workspace, 0);
  return files;
}
function resolveFiles(text, selections, files) {
  const matches = new Set(selections);
  const missing = [];
  for (const token of String(text).matchAll(/@([^\s@]+)/g)) {
    const query = token[1].replace(/\\/g, '/');
    const exact = files.find((f) => !f.dir && f.path === query);
    const suffix = files.filter((f) => !f.dir && (f.path.endsWith('/' + query) || f.path === query));
    const hit = exact || (suffix.length === 1 ? suffix[0] : null);
    if (hit) matches.add(hit.path);
    else missing.push(query);
  }
  if (matches.size > 6) missing.push('Only the first 6 files were attached');
  return { files: [...matches].slice(0, 6), missing };
}
async function fileContext(workspace, text, selections, files) {
  const { files: refs, missing } = resolveFiles(text, selections, files);
  const attached = [], blocks = [];
  for (const relative of refs) {
    const full = path.resolve(workspace, relative);
    const inside = path.relative(workspace, full);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !files.some((f) => f.path === relative)) continue;
    try {
      const stat = await fsp.lstat(full);
      if (!stat.isFile() || stat.size > 1_000_000) { missing.push(`${relative} (not a small text file)`); continue; }
      const data = await fsp.readFile(full, 'utf8');
      if (data.includes('\0')) { missing.push(`${relative} (binary file)`); continue; }
      blocks.push(`--- ${relative} ---\n${data.split('\n').slice(0, 220).join('\n').slice(0, 12000)}`);
      attached.push(relative);
    } catch { missing.push(relative); }
  }
  return {
    prompt: blocks.length ? `${text}\n\nAttached file context:\n${blocks.join('\n\n')}` : text,
    attached, missing,
  };
}
function toUiChat(c) {
  return {
    id: c.id, title: c.title, pinned: c.pinned,
    createdAt: Date.parse(c.createdAt) || Date.now(),
    updatedAt: Date.parse(c.updatedAt) || Date.now(),
    messages: (c.messages || []).map((m) => ({
      who: m.role === 'user' ? 'you' : 'nexus', text: m.content,
      time: Date.parse(m.time) || Date.now(),
    })),
  };
}
function registryMcp(registry) {
  return Object.entries(registry.defs).map(([name, def]) => ({
    name, enabled: def.enabled !== false,
    connected: registry.servers.get(name)?.state === 'ready',
    command: (Array.isArray(def.command) ? def.command : [def.url || '']).join(' '),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
function createScreen(output) {
  let previous = [], active = false;
  return {
    enter() { if (active) return; active = true; output.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H'); },
    paint(lines) {
      if (!active) return;
      let changes = '';
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== previous[i]) changes += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
      }
      if (changes) output.write(changes);
      previous = lines;
    },
    resize() { previous = []; if (active) output.write('\x1b[2J'); },
    leave() { if (active) { active = false; previous = []; output.write('\x1b[0m\x1b[?25h\x1b[?1049l'); } },
  };
}

async function tuiMode(workspace, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive NEXUS needs a terminal (TTY). Use `nexus call "prompt"` for one-shot mode.');
  }
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
  const screen = createScreen(output);
  const state = makeState({
    workspace, rows: output.rows || 24, cols: output.columns || 80,
    animation: !process.env.NEXUS_NO_ANIMATION,
    noColor: !!process.env.NO_COLOR || process.env.TERM === 'dumb',
  });
  setPresence(state, 'understanding', 'Opening workspace…');
  let closed = false, tickTimer, healthTimer, drawQueued = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const untilClosed = (promise) => Promise.race([promise, done]);
  let registry, automation, pool, chats;
  const approval = { current: null };
  let shellChild = null, currentRun = null, probeController = null, restoreAutomation = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(tickTimer); clearInterval(healthTimer);
    state.cancelRequested = true;
    currentRun?.abort();
    probeController?.abort();
    if (approval.current) { approval.current(false); approval.current = null; }
    if (shellChild) shellChild.kill();
    if (state._micProc) state._micProc.kill();
    if (state._sttProc) state._sttProc.kill();
    if (typeof input.setRawMode === 'function') input.setRawMode(false);
    input.pause();
    try { registry?.stopAll(); } catch {}
    void automation?.stop().catch(() => {});
    screen.leave();
    input.off('keypress', onKeypress);
    input.off('end', cleanup);
    output.off('resize', onResize);
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    process.off('exit', cleanup);
    finish();
  };
  function draw() {
    if (drawQueued || closed) return;
    drawQueued = true;
    setImmediate(() => {
      drawQueued = false;
      if (closed) return;
      try { screen.paint(renderToLines(state)); }
      catch (error) { cleanup(); process.stderr.write(`nexus: render error: ${error.stack || error}\n`); }
    });
  }
  function onResize() {
    state.rows = output.rows || 24;
    state.cols = output.columns || 80;
    screen.resize(); draw();
  }
  function onKeypress(str, key) {
    if (closed || !key) return;
    const { effects } = handleKey(state, { name: key.name, char: str, ctrl: key.ctrl, shift: key.shift });
    draw();
    (async () => {
      for (const fx of effects) await handleEffect(fx);
      draw();
    })().catch((e) => { setNotice(state, `Action failed: ${e.message}`); draw(); });
  }
  screen.enter();
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
  input.on('end', cleanup);
  output.on('resize', onResize);
  draw();
  try {
    pool = new ModelPool(() => {});
    registry = setupRegistry(new CapabilityRegistry({ workspace, onLog: () => {} }));
    automation = new AutomationBus({ dataDir: path.join(DATA_DIR, 'nexus-automation'), onEvent: () => {} });
    await untilClosed(automation.load().catch(() => {}));
    if (closed) return done;
    chats = new ChatStore(DATA_DIR);
    const current = await untilClosed(chats.current());
    if (closed) return done;
    state.chats = (await untilClosed(chats.list())).map(toUiChat);
    if (closed) return done;
    state.activeChatId = current.id;
    state.history = (current.messages || []).filter((m) => m.role === 'user').map((m) => m.content).reverse().slice(0, 100);
    state.mcp = registryMcp(registry);
    const savedSkills = readJson(SKILLS_STATE, { active: [] });
    const active = new Set(Array.isArray(savedSkills?.active) ? savedSkills.active : []);
    state.skills = registry.skills.map((s) => ({ name: s.id, active: active.has(s.id), description: s.description || '' }));
    state.files = flattenFiles(workspace);
    probeController = new AbortController();
    state.online = await untilClosed(lm.healthy({ signal: probeController.signal }));
    probeController = null;
    if (closed) return done;
    if (state.online) void pool.sync().catch(() => {});
    setPresence(state, 'ready');
    if (!state.online) setNotice(state, 'LM Studio is offline · start its local server to run an agent', 6000);
    readline.emitKeypressEvents(input);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('keypress', onKeypress);
    tickTimer = setInterval(() => {
      if (state.animation) { state.tickFrame++; draw(); }
      else if (state.notice && Date.now() > state.noticeUntil) { state.notice = ''; draw(); }
    }, 220);
    healthTimer = setInterval(async () => {
      if (closed || probeController) return;
      const controller = new AbortController();
      probeController = controller;
      try { state.online = await lm.healthy({ signal: controller.signal }); }
      catch { state.online = false; }
      finally { if (probeController === controller) probeController = null; }
      if (!closed) draw();
    }, 7000);
    draw();
  } catch (error) { cleanup(); throw error; }

  async function reloadChats(preferredId = state.activeChatId) {
    const list = await chats.list();
    state.chats = list.map(toUiChat);
    state.activeChatId = state.chats.some((c) => c.id === preferredId)
      ? preferredId : (await chats.current()).id;
    state.chatSelection = Math.max(0, sortedChats(state).findIndex((c) => c.id === state.activeChatId));
    state.history = (getActiveChat(state)?.messages || []).filter((m) => m.who === 'you').map((m) => m.text).reverse().slice(0, 100);
    state.historyIndex = -1;
    state.transcriptScroll = 0;
  }
  const emit = (evt) => {
    if (closed) return;
    switch (evt.type) {
      case 'phase': state.presence = 'executing'; state.presenceText = evt.text || 'Working'; break;
      case 'run-start': state.presence = 'executing'; state.presenceText = `Working · ${evt.label || 'local core'}`; break;
      case 'tool-call': addActivity(state, `▸ ${evt.name}`); break;
      case 'tool-result': if (String(evt.result).startsWith('ERROR')) addActivity(state, `! ${evt.name}: ${String(evt.result).slice(0, 100)}`); break;
      case 'plan': addActivity(state, `◈ Plan · ${(evt.steps || []).length} steps`); break;
      case 'step-done': addActivity(state, `✓ Step ${evt.step} complete`); break;
      case 'warn': setNotice(state, evt.message, 5500); break;
      case 'error': setNotice(state, evt.message, 5500); break;
      case 'assistant':
        if (state.showThinking && evt.reasoning) addActivity(state, `Reasoning: ${String(evt.reasoning).slice(0, 140)}`);
        break;
    }
    draw();
  };
  const authorize = ({ name, args }) => new Promise((resolve) => {
    state.pendingApproval = { name, detail: JSON.stringify(args || {}, null, 2).slice(0, 1000) };
    approval.current = resolve;
    draw();
  });

  async function persistTurn(chatId, user, answer) {
    const stored = await chats.appendTurn(chatId, user, answer);
    const chat = state.chats.find((c) => c.id === chatId);
    if (chat) { chat.title = stored.title; chat.updatedAt = Date.parse(stored.updatedAt); }
  }
  async function runShell(command) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const bin = isWin ? 'powershell.exe' : '/bin/sh';
      const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      shellChild = execFile(bin, args,
        { cwd: workspace, timeout: 90000, maxBuffer: 2_000_000, windowsHide: true },
        (error, stdout, stderr) => {
          shellChild = null;
          const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          resolve({ code, output: String(stdout || ''), error: String(stderr || error?.message || '') });
        });
    });
  }
  async function drainPromptQueue() {
    if (state.busy || state.stopped) return;
    const item = state.promptQueue && state.promptQueue.shift();
    if (!item) return;
    setNotice(state, state.promptQueue.length ? `Running queued prompt (${state.promptQueue.length} left)` : 'Running queued prompt');
    addTranscript(state, 'you', item.text, item.chatId || undefined);
    await runText(item.text, item.chatId || undefined, item.resources);
  }
  async function runText(text, chatId, selected) {
    if (state.busy || state.stopped) return;
    state.busy = true;
    state.cancelRequested = false;
    const controller = new AbortController();
    currentRun = controller;
    state.task = text;
    state.activityLine = '';
    setPresence(state, 'understanding');
    draw();
    try {
      let result;
      if (text.startsWith('!')) {
        const command = text.slice(1).trim();
        if (!command) throw new Error('Enter a command after ! (for example !pwd)');
        state.presence = 'executing'; state.presenceText = 'Running shell command';
        const shell = await runShell(command);
        result = { text: `$ ${command}\n${(shell.output + (shell.error ? '\n' + shell.error : '')).trim().slice(0, 16000)}\n[exit ${shell.code}]` };
      } else {
        if (!state.online) state.online = await lm.healthy({ signal: controller.signal }).catch(() => false);
        if (!state.online) throw new Error('LM Studio is offline. Start the local server and retry.');
        const { prompt, attached, missing } = await fileContext(workspace, text, selected, state.files);
        if (missing.length) setNotice(state, `Attachment not found: ${missing.slice(0, 2).join(', ')}`);
        if (attached.length) addActivity(state, `⌁ ${attached.length} file${attached.length === 1 ? '' : 's'} attached`);
        const history = (await chats.get(chatId)).messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
        const inject = activeSkillsInject(registry);
        const shouldAbort = () => closed || state.cancelRequested || state.stopped;
        const opts = { prompt, workspace, pool, emit, systemAccess: state.systemAccess,
          registry, authorize, history, inject, shouldAbort, signal: controller.signal,
          checkpointRoot: path.join(workspace, '.nexus') };
        result = state.mode === 'supervisor' || (state.mode === 'auto' && isComplex(text))
          ? await orchestrate(opts)
          : await runAgent({ ...opts, modelKey: state.forcedModel || undefined });
      }
      if (state.cancelRequested || state.stopped || result.cancelled) {
        addTranscript(state, 'nexus', '⏹ Run interrupted', chatId);
        setPresence(state, 'ready', 'Run interrupted');
      } else if (result.error) {
        addTranscript(state, 'nexus', '✗ ' + result.error, chatId);
        setPresence(state, 'error');
      } else {
        const answer = result.text || '(No response returned)';
        addTranscript(state, 'nexus', answer, chatId);
        await persistTurn(chatId, text, answer);
        setPresence(state, 'done');
        if (result.truncated) setNotice(state, 'Step limit reached · result may be incomplete');
      }
    } catch (e) {
      if (state.cancelRequested || controller.signal.aborted) {
        addTranscript(state, 'nexus', '⏹ Run interrupted', chatId);
        setPresence(state, 'ready', 'Run interrupted');
      } else {
        addTranscript(state, 'nexus', '✗ ' + e.message, chatId);
        setPresence(state, 'error', e.message);
      }
    } finally {
      state.busy = false;
      state.cancelRequested = false;
      if (currentRun === controller) currentRun = null;
      state.activityLine = '';
      draw();
      // Defer so the next queued turn starts after this run's teardown, not inside it.
      setTimeout(drainPromptQueue, 0);
      setTimeout(() => {
        if (!closed && !state.busy && state.presence !== 'listening' && !state.stopped) { setPresence(state, 'ready'); draw(); }
      }, 2300);
    }
  }
  async function halt(on) {
    state.stopped = on;
    if (on) {
      state.cancelRequested = true;
      currentRun?.abort();
      if (shellChild) shellChild.kill();
      if (approval.current) { approval.current(false); approval.current = null; state.pendingApproval = null; }
      registry.stopAll();
      restoreAutomation = !!automation.enabled;
      if (restoreAutomation) await automation.pause();
      setNotice(state, 'Execution paused · /unhalt to resume');
    } else {
      if (restoreAutomation) await automation.resume();
      restoreAutomation = false;
      setNotice(state, 'Execution resumed');
      draw();
      void drainPromptQueue();
    }
    draw();
  }
  async function confirm(chatId, name, detail, action) {
    if (state.busy) { setNotice(state, 'Finish the current run first'); return; }
    state.pendingApproval = { name, detail };
    approval.current = async (accepted) => {
      if (!accepted) { setNotice(state, 'Cancelled'); return; }
      await action(chatId);
      draw();
    };
    draw();
  }
  async function toggleMic() {
    if (state.micRecording) {
      state.micRecording = false;
      try { state._micProc?.kill('SIGINT'); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 900));
      const file = state._micFile;
      setPresence(state, 'ready');
      if (!file || !fs.existsSync(file) || fs.statSync(file).size <= 44) { setNotice(state, 'Microphone recording was empty'); return; }
      try {
        const py = state._stt.python || 'python';
        const script = state._stt.module === 'faster_whisper'
          ? "import sys; from faster_whisper import WhisperModel; m=WhisperModel('tiny.en',device='cpu'); segs,_=m.transcribe(sys.argv[1]); print(' '.join(s.text for s in segs).strip())"
          : "import sys; import whisper; m=whisper.load_model('tiny.en'); print(m.transcribe(sys.argv[1])['text'].strip())";
        const transcript = await new Promise((resolve, reject) => {
          state._sttProc = execFile(py, ['-c', script, file], { timeout: 180000, maxBuffer: 500000 }, (err, out) => {
            state._sttProc = null;
            err ? reject(err) : resolve(String(out).trim());
          });
        });
        if (transcript) {
          state.composer = [state.composer, transcript].filter(Boolean).join(' ');
          state.cursor = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(state.composer)].length;
          setNotice(state, 'Voice added to your draft');
        } else setNotice(state, 'No speech recognized');
      } catch (e) { setNotice(state, `Transcription failed: ${e.message}`); }
      return;
    }
    setPresence(state, 'understanding', 'Checking voice input…'); draw();
    const stt = await voice.sttAvailable();
    if (!stt.available) { setPresence(state, 'ready'); setNotice(state, 'Voice needs ffmpeg and Python faster-whisper (pip install faster-whisper)', 6000); return; }
    const devices = await voice.listAudioDevices();
    if (!devices.ok) { setPresence(state, 'ready'); setNotice(state, devices.error || 'ffmpeg is not available'); return; }
    const dir = path.join(workspace, '.nexus', 'audio');
    fs.mkdirSync(dir, { recursive: true });
    state._micFile = path.join(dir, `mic-${Date.now()}.wav`);
    state._stt = stt;
    const args = process.platform === 'win32'
      ? ['-y', '-f', 'dshow', '-i', `audio=${devices.devices?.[0] || 'default'}`, '-t', '60', state._micFile]
      : process.platform === 'darwin'
        ? ['-y', '-f', 'avfoundation', '-i', ':0', '-t', '60', state._micFile]
        : ['-y', '-f', 'pulse', '-i', 'default', '-t', '60', state._micFile];
    state._micProc = spawn('ffmpeg', args, { windowsHide: true, stdio: 'ignore' });
    state._micProc.on('error', (e) => { state.micRecording = false; setPresence(state, 'error'); setNotice(state, `Microphone failed: ${e.message}`); draw(); });
    state._micProc.on('exit', (code) => {
      if (!state.micRecording) return;
      state.micRecording = false;
      setPresence(state, 'ready');
      setNotice(state, `Recording ended${code ? ` (ffmpeg exit ${code})` : ''}`);
      draw();
    });
    state.micRecording = true;
    setPresence(state, 'listening', 'Recording · Ctrl+M to stop');
    draw();
  }
  async function handleEffect(fx) {
    if (closed) return;
    switch (fx.type) {
      case 'quit': cleanup(); break;
      case 'send': void runText(fx.text, fx.chatId, fx.resources); break;
      case 'interrupt':
        if (state.busy) { state.cancelRequested = true; currentRun?.abort(); if (shellChild) shellChild.kill(); setNotice(state, 'Stopping the current operation…'); }
        else setNotice(state, state.stopped ? 'Paused · /unhalt to resume' : 'No active run');
        break;
      case 'halt': await halt(true); break;
      case 'unhalt': await halt(false); break;
      case 'newChat': {
        const chat = await chats.create();
        await reloadChats(chat.id);
        newChat(state);
        setNotice(state, 'New conversation ready'); break;
      }
      case 'switchedChat': {
        const chat = await chats.switchTo(fx.chatId);
        state.history = chat.messages.filter((m) => m.role === 'user').map((m) => m.content).reverse().slice(0, 100);
        state.historyIndex = -1;
        break;
      }
      case 'renameChat': {
        const updated = await chats.rename(fx.chatId, fx.title);
        const chat = state.chats.find((c) => c.id === fx.chatId);
        if (chat) chat.title = updated.title;
        setNotice(state, 'Conversation renamed'); break;
      }
      case 'pinChat': await chats.pin(fx.chatId, fx.pinned); break;
      case 'duplicateChat': {
        const copy = await chats.duplicate(fx.chatId);
        await reloadChats(copy.id); newChat(state);
        setNotice(state, 'Conversation duplicated'); break;
      }
      case 'confirmDeleteChat': await confirm(fx.chatId, 'DELETE CONVERSATION',
        'Remove this chat from history? Project files will not be changed.',
        async (id) => { const next = await chats.delete(id); await reloadChats(next.id); state.view = 'chat'; setNotice(state, 'Conversation deleted'); }); break;
      case 'confirmClearChat': await confirm(fx.chatId, 'CLEAR MESSAGES',
        'Remove the messages in this conversation? This cannot be undone.',
        async (id) => { await chats.replaceMessages(id, []); await reloadChats(id); setNotice(state, 'Conversation cleared'); }); break;
      case 'approval': {
        const callback = approval.current;
        approval.current = null;
        if (callback) await callback(fx.approved);
        break;
      }
      case 'undo': {
        const removed = await chats.undoLastTurn(fx.chatId);
        if (removed) await reloadChats(fx.chatId);
        setNotice(state, removed ? 'Last turn removed' : 'Nothing to undo'); break;
      }
      case 'compact': {
        const chatId = fx.chatId;
        const current = await chats.get(chatId);
        if (!current.messages.length) { setNotice(state, 'Nothing to summarize'); break; }
        const controller = new AbortController();
        currentRun = controller;
        state.cancelRequested = false;
        state.busy = true; setPresence(state, 'executing', 'Summarizing conversation'); draw();
        try {
          const response = await pool.chat('reader', [
            { role: 'system', content: 'Summarize this conversation in terse bullets: decisions, files touched, next steps.' },
            { role: 'user', content: current.messages.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-16000) },
          ], null, { temperature: 0.2, max_tokens: 900, signal: controller.signal });
          if (controller.signal.aborted || state.cancelRequested) throw new Error('interrupted');
          const summary = String(response?.choices?.[0]?.message?.content || '').trim();
          if (!summary) throw new Error('Model returned an empty summary');
          await chats.replaceMessages(chatId, [{ role: 'assistant', content: 'Conversation summary:\n' + summary }]);
          await reloadChats(chatId);
          setNotice(state, 'Conversation summarized');
        } catch (e) {
          setNotice(state, controller.signal.aborted || state.cancelRequested ? 'Summarization stopped' : `Summarize failed: ${e.message}`);
        } finally {
          if (currentRun === controller) currentRun = null;
          state.cancelRequested = false;
          state.busy = false; setPresence(state, 'ready');
        }
        break;
      }
      case 'export': {
        const chat = state.chats.find((c) => c.id === fx.chatId);
        const markdown = `# ${chat.title}\n\n` + chat.messages.map((m) =>
          `## ${m.who === 'you' ? 'You' : 'Nexus'}\n\n${m.text}\n`).join('\n');
        const file = path.join(workspace, `nexus-export-${Date.now()}.md`);
        await fsp.writeFile(file, markdown);
        setNotice(state, `Exported to ${file}`); break;
      }
      case 'toggleMcp': setMcpEnabled(registry, fx.name, fx.enabled); state.mcp = registryMcp(registry); setNotice(state, `${fx.name} ${fx.enabled ? 'enabled' : 'disabled'}`); break;
      case 'disconnectMcp': setMcpEnabled(registry, fx.name, false); state.mcp = registryMcp(registry); setNotice(state, `${fx.name} disconnected`); break;
      case 'addMcp': {
        if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(fx.name || '')) throw new Error('MCP name must contain only letters, numbers, dots, dashes or underscores');
        if (registry.defs[fx.name]) throw new Error('MCP server already exists');
        const args = fx.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, '')) || [];
        if (!args.length) throw new Error('MCP command cannot be empty');
        const extra = readJson(EXTRA_MCP, { mcp: {} });
        extra.mcp ||= {};
        extra.mcp[fx.name] = { type: 'local', command: args, enabled: false };
        writeJson(EXTRA_MCP, extra);
        registry.defs[fx.name] = extra.mcp[fx.name];
        registry.servers.set(fx.name, new McpServer(fx.name, registry.defs[fx.name], () => {}));
        state.mcp = registryMcp(registry);
        setNotice(state, `Added ${fx.name} · disabled until enabled`); break;
      }
      case 'inspectMcp': {
        state.busy = true; setPresence(state, 'executing', `Inspecting ${fx.name}`); draw();
        try {
          const tools = await registry.inspect(fx.name);
          state.mcp = registryMcp(registry);
          state.view = 'chat';
          addTranscript(state, 'nexus', `${fx.name} · ${tools.length} tools\n` +
            tools.slice(0, 30).map((t) => `▸ ${t.name} — ${t.description || ''}`).join('\n'));
        } catch (e) { setNotice(state, `MCP inspect failed: ${e.message}`); }
        finally { state.busy = false; setPresence(state, 'ready'); }
        break;
      }
      case 'toggleSkill': {
        writeJson(SKILLS_STATE, { active: state.skills.filter((s) => s.active).map((s) => s.name) });
        setNotice(state, `${fx.name} ${fx.active ? 'active' : 'inactive'}`); break;
      }
      case 'configureModel': {
        if (!fx.value || fx.value === 'auto') { state.forcedModel = null; setNotice(state, 'Model routing: automatic'); break; }
        try { pool.spec(fx.value); state.forcedModel = fx.value; setNotice(state, `Pinned profile: ${fx.value}`); }
        catch (e) { setNotice(state, e.message); }
        break;
      }
      case 'workspace': setNotice(state, `Workspace: ${workspace} · change with NEXUS_WORKSPACE before launch`, 7000); break;
      case 'armSystem': setNotice(state, fx.armed ? 'SYSTEM armed · full machine access' : 'SYSTEM disarmed'); break;
      case 'toggleMic': await toggleMic(); break;
      default: break;
    }
    draw();
  }
  return done;
}

module.exports = { tuiMode, createScreen, flattenFiles, resolveFiles, fileContext, activeSkillsInject };
