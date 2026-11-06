'use strict';

// NEXUS TUI: a single-column, keyboard-first terminal interface. Rendering and
// input handling stay pure so small terminals and modal flows can be tested.
const { PromptQueue } = require('./prompt-queue');
const C = {
  black: [9, 19, 30], navy: [20, 46, 73], steel: [57, 108, 143],
  blue: [112, 183, 217], ivory: [244, 242, 235], grey: [200, 209, 214],
  muted: [119, 145, 160], green: [127, 198, 165], amber: [234, 187, 112],
  red: [230, 122, 125], white: [255, 255, 255],
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const fg = (rgb) => `\x1b[38;2;${rgb.join(';')}m`;
const bg = (rgb) => `\x1b[48;2;${rgb.join(';')}m`;

// Model output, file names and pasted text are not trusted terminal sequences.
function clean(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (text) => segmenter
  ? [...segmenter.segment(String(text))].map((part) => part.segment)
  : [...String(text)];
const wide = /[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1ffff}]/u;
function glyphWidth(glyph) {
  if (!glyph || glyph === '\n') return 0;
  if (wide.test(glyph) || /[\u{1f1e6}-\u{1f1ff}]{2}/u.test(glyph) || glyph.includes('\ufe0f')) return 2;
  if (/^[\p{Mark}\u200c\u200d]+$/u.test(glyph)) return 0;
  return 1;
}
function cellWidth(value) {
  return graphemes(String(value).replace(ansi, '')).reduce((n, g) => n + glyphWidth(g), 0);
}
function clip(value, width) {
  if (width <= 0) return '';
  const chars = graphemes(clean(value));
  let used = 0, out = '';
  for (const g of chars) {
    const n = glyphWidth(g);
    if (used + n > width) break;
    used += n;
    out += g;
  }
  return out;
}
function truncate(value, width) {
  const text = clean(value).replace(/\n/g, ' ');
  return cellWidth(text) <= width ? text : clip(text, Math.max(0, width - 1)) + (width > 0 ? '…' : '');
}
function fitAnsi(value, width, fill = C.black) {
  const pieces = String(value).split(/(\x1b\[[0-?]*[ -/]*[@-~])/g);
  let used = 0, output = '';
  for (const piece of pieces) {
    if (piece.startsWith('\x1b[')) { if (used < width) output += piece; continue; }
    for (const g of graphemes(piece)) {
      const n = glyphWidth(g);
      if (used + n > width) break;
      used += n;
      output += g;
    }
    if (used >= width) break;
  }
  return output + bg(fill) + ' '.repeat(Math.max(0, width - used)) + RESET;
}
const row = (content, width, fill = C.black) => bg(fill) + fitAnsi(content, width, fill);
function center(content, width) {
  return ' '.repeat(Math.max(0, Math.floor((width - cellWidth(content)) / 2))) + content;
}
function joinLR(left, right, width) {
  const room = width - cellWidth(right) - 1;
  if (room < 8) return truncate(left, width);
  return clip(left, room) + ' '.repeat(Math.max(1, width - cellWidth(clip(left, room)) - cellWidth(right))) + right;
}
function wrap(text, width) {
  if (width < 1) return [''];
  const lines = [];
  for (const paragraph of clean(text).split('\n')) {
    const chars = graphemes(paragraph);
    if (!chars.length) { lines.push(''); continue; }
    let start = 0;
    while (start < chars.length) {
      let end = start, used = 0, space = -1;
      while (end < chars.length && used + glyphWidth(chars[end]) <= width) {
        used += glyphWidth(chars[end]);
        if (chars[end] === ' ') space = end;
        end++;
      }
      if (end === start) end++; // overwide glyph in a one-column terminal
      const breakAt = end < chars.length && space > start + (end - start) / 3 ? space : end;
      lines.push(chars.slice(start, breakAt).join('').trimEnd());
      start = breakAt;
      while (chars[start] === ' ') start++;
    }
  }
  return lines.length ? lines : [''];
}
function sortedChats(state) {
  return [...state.chats].sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
    (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}
function filteredChats(state) {
  return sortedChats(state).filter((chat) => chat.title.toLowerCase().includes(state.chatFilter.toLowerCase()));
}
function fuzzyScore(query, value) {
  const q = query.toLowerCase().trim(), v = value.toLowerCase();
  if (!q) return 0;
  if (v.startsWith(q)) return 100 - v.length / 100;
  if (v.includes(q)) return 70 - v.indexOf(q) / 100;
  let j = 0, score = 0;
  for (let i = 0; i < v.length && j < q.length; i++) {
    if (v[i] !== q[j]) continue;
    score += i === 0 || '/ -'.includes(v[i - 1]) ? 2 : 1;
    j++;
  }
  return j === q.length ? score : -1;
}
const commands = [
  ['/new', 'New conversation'], ['/chats', 'Browse conversations'],
  ['/rename', 'Rename conversation'], ['/pin', 'Pin or unpin conversation'],
  ['/duplicate', 'Duplicate conversation'], ['/delete', 'Delete conversation'],
  ['/clear', 'Clear messages'], ['/undo', 'Remove last turn'],
  ['/compact', 'Summarize conversation'], ['/export', 'Export as Markdown'],
  ['/attach', 'Browse and attach workspace files'],
  ['/mcp', 'Manage MCP servers'], ['/skill', 'Manage skills'],
  ['/mode', 'Switch auto / supervisor / direct'], ['/model', 'Pin a model profile'],
  ['/thinking', 'Show or hide reasoning'], ['/motion', 'Toggle animations'],
  ['/ws', 'Show workspace'], ['/halt', 'Pause execution'],
  ['/unhalt', 'Resume execution'], ['/queue', 'List or remove queued prompts'],
  ['/help', 'Command reference'], ['/quit', 'Exit Nexus'],
].map(([command, description]) => ({ command, description }));
function filteredCommands(state) {
  return state.paletteCommands.map((item, index) => ({ ...item, index,
    score: fuzzyScore(state.paletteFilter, item.command + ' ' + item.description) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
function filteredFiles(state) {
  return (state.files || []).filter((file) => !file.dir &&
    fuzzyScore(state.fileFilter, file.path) >= 0);
}

function makeState(opts = {}) {
  const initial = { id: 'session-1', title: 'New conversation', createdAt: Date.now(),
    updatedAt: Date.now(), pinned: false, messages: [] };
  const queue = new PromptQueue();
  return {
    promptQueue: queue,
    cols: opts.cols ?? 100, rows: opts.rows ?? 34,
    workspace: opts.workspace || process.cwd(),
    view: 'chat', presence: 'ready', presenceText: 'Ready when you are',
    presenceStarted: Date.now(), tickFrame: 0, online: false,
    systemAccess: false, armedAt: 0, stopped: false, busy: false,
    cancelRequested: false, animation: opts.animation ?? true,
    mode: 'auto', modes: ['auto', 'supervisor', 'direct'], showThinking: false,
    chats: opts.chats && opts.chats.length ? opts.chats : [initial],
    activeChatId: opts.activeChatId || opts.chats?.[0]?.id || initial.id,
    composer: '', cursor: 0, history: [], historyIndex: -1, historyDraft: '',
    transcriptScroll: 0, files: opts.files || [], attachments: [],
    mcp: opts.mcp || [], skills: opts.skills || [],
    paletteCommands: commands, paletteFilter: '', paletteSelection: 0,
    chatSelection: 0, mcpSelection: 0, skillSelection: 0, fileSelection: 0,
    chatFilter: '', chatSearch: false, mcpFilter: '', mcpSearch: false,
    skillFilter: '', fileFilter: '',
    prompt: null, promptValue: '', promptCursor: 0, promptData: null,
    pendingApproval: null, notice: '', noticeUntil: 0,
    activity: [], activityLine: '', task: '',
    config: { showPresence: true, showHints: true, ...opts.config },
    ...opts,
  };
}
const getActiveChat = (s) => s.chats.find((c) => c.id === s.activeChatId) || s.chats[0];
function addTranscript(state, who, text, chatId = state.activeChatId) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (chat) {
    chat.messages.push({ who: who === 'you' ? 'you' : 'nexus', text: clean(text), time: Date.now() });
    if (chatId === state.activeChatId) state.transcriptScroll = 0;
  }
  return state;
}
function addActivity(state, text) {
  state.activityLine = clean(text);
  state.activity.push({ text: state.activityLine, time: Date.now() });
  if (state.activity.length > 80) state.activity.shift();
  return state;
}
function setNotice(state, text, duration = 4000) {
  state.notice = clean(text);
  state.noticeUntil = Date.now() + duration;
}
function setPresence(state, presence, text) {
  state.presence = presence;
  state.presenceText = clean(text || ({
    ready: 'Ready when you are', understanding: 'Understanding your request',
    executing: 'Working on your request', listening: 'Listening',
    done: 'Response complete', error: 'Something needs your attention',
  }[presence] || 'Ready'));
  state.presenceStarted = Date.now();
}
const effect = (type, data = {}) => ({ type, ...data });
function newChat(state) {
  state.view = 'chat';
  state.composer = '';
  state.cursor = 0;
  state.attachments = [];
  state.transcriptScroll = 0;
  return state;
}
function deleteCurrentChat(state) {
  state.chats = state.chats.filter((c) => c.id !== state.activeChatId);
  state.activeChatId = state.chats[0]?.id || '';
  state.view = 'chat';
  return state;
}
function openView(state, view) {
  state.view = view;
  if (view === 'chats') {
    state.chatFilter = ''; state.chatSearch = false;
    state.chatSelection = Math.max(0, sortedChats(state).findIndex((c) => c.id === state.activeChatId));
  }
  if (view === 'mcp') { state.mcpFilter = ''; state.mcpSearch = false; state.mcpSelection = 0; }
  if (view === 'palette') { state.paletteFilter = ''; state.paletteSelection = 0; }
  if (view === 'files') { state.fileFilter = ''; state.fileSelection = 0; }
  if (view === 'skills') { state.skillFilter = ''; state.skillSelection = 0; }
  return state;
}
function closeView(state) {
  state.view = 'chat';
  state.prompt = null;
  return state;
}
function openPrompt(state, type, value = '', data = null) {
  state.prompt = type;
  state.promptValue = value;
  state.promptCursor = graphemes(value).length;
  state.promptData = data;
}
const mutationCommands = new Set(['/new', '/rename', '/pin', '/duplicate', '/delete', '/clear', '/undo', '/compact']);
function commandAction(state, command, effects) {
  const [name, ...args] = clean(command).trim().split(/\s+/);
  const argument = args.join(' ');
  const chat = getActiveChat(state);
  if (state.busy && mutationCommands.has(name.toLowerCase())) {
    setNotice(state, 'Wait for the current run before changing conversations');
    return;
  }
  switch (name.toLowerCase()) {
    case '/new': effects.push(effect('newChat')); closeView(state); break;
    case '/chats': openView(state, 'chats'); break;
    case '/rename': if (chat) openPrompt(state, 'rename', chat.title, { chatId: chat.id }); break;
    case '/pin': if (chat) { chat.pinned = !chat.pinned; effects.push(effect('pinChat', { chatId: chat.id, pinned: chat.pinned })); setNotice(state, chat.pinned ? 'Conversation pinned' : 'Conversation unpinned'); } break;
    case '/duplicate': if (chat) effects.push(effect('duplicateChat', { chatId: chat.id })); break;
    case '/delete': if (chat) effects.push(effect('confirmDeleteChat', { chatId: chat.id })); break;
    case '/clear': if (chat) effects.push(effect('confirmClearChat', { chatId: chat.id })); break;
    case '/undo': if (chat) effects.push(effect('undo', { chatId: chat.id })); break;
    case '/compact': if (chat) effects.push(effect('compact', { chatId: chat.id })); break;
    case '/export': if (chat) effects.push(effect('export', { chatId: chat.id })); break;
    case '/attach': openView(state, 'files'); break;
    case '/mcp': openView(state, 'mcp'); break;
    case '/skill': openView(state, 'skills');
      if (argument) state.skillFilter = argument;
      break;
    case '/mode': {
      state.mode = state.modes.includes(argument) ? argument
        : state.modes[(state.modes.indexOf(state.mode) + 1) % state.modes.length];
      setNotice(state, `Mode: ${state.mode}`);
      break;
    }
    case '/model': effects.push(effect('configureModel', { value: argument })); break;
    case '/thinking': state.showThinking = !state.showThinking; setNotice(state, `Reasoning ${state.showThinking ? 'visible' : 'hidden'}`); break;
    case '/motion': state.animation = !state.animation; setNotice(state, `Animation ${state.animation ? 'on' : 'off'}`); break;
    case '/ws': effects.push(effect('workspace')); break;
    case '/halt': state.stopped = true; effects.push(effect('halt')); break;
    case '/unhalt': state.stopped = false; effects.push(effect('unhalt')); break;
    case '/help': openView(state, 'palette'); break;
    case '/queue': {
      if (!argument) {
        const list = state.promptQueue.list();
        setNotice(state, list.length
          ? `Queued ${list.length}: ${list.map((i) => `${i.n}. ${i.text.slice(0, 30)}`).join('  |  ')}`
          : 'No queued prompts');
        break;
      }
      if (/^clear$/i.test(argument)) {
        state.promptQueue.clear();
        setNotice(state, 'Queue cleared');
        break;
      }
      const rm = /^rm\s+(\d+)$/i.exec(argument);
      if (rm) {
        const removed = state.promptQueue.remove(rm[1]);
        setNotice(state, removed ? `Removed #${rm[1]}: ${removed.text.slice(0, 48)}` : `No queued prompt #${rm[1]}`);
        break;
      }
      setNotice(state, 'Usage: /queue  ·  /queue rm N  ·  /queue clear');
      break;
    }
    case '/quit': effects.push(effect('quit')); break;
    default: setNotice(state, `Unknown command: ${name} · try /help`);
  }
}
function sendMessage(state, effects) {
  const message = state.composer.trim();
  if (!message) return;
  if (message.startsWith('/')) {
    commandAction(state, message, effects);
    state.composer = ''; state.cursor = 0;
    return;
  }
  if (state.stopped) {
    setNotice(state, 'Execution paused — use /unhalt');
    return;
  }
  if (state.busy) {
    state.promptQueue.enqueue(message, state.attachments, { chatId: state.activeChatId });
    state.composer = ''; state.cursor = 0; state.attachments = [];
    setNotice(state, `Queued ${state.promptQueue.length} — ${state.promptQueue.list().slice(-2).map((i) => i.n + '. ' + i.text.slice(0, 28)).join(' · ')}  (/queue to manage)`);
    return;
  }
  const resources = state.attachments.slice();
  addTranscript(state, 'you', message);
  state.history.unshift(message);
  if (state.history.length > 100) state.history.pop();
  state.historyIndex = -1;
  state.historyDraft = '';
  state.composer = ''; state.cursor = 0; state.attachments = [];
  effects.push(effect('send', { text: message, chatId: state.activeChatId, resources, mode: state.mode }));
  setPresence(state, 'understanding');
}
function promptKey(state, name, char, ctrl, effects) {
  if (name === 'escape') { state.prompt = null; return; }
  if (ctrl && name === 'u') { state.promptValue = ''; state.promptCursor = 0; return; }
  if (ctrl && name === 'a') { state.promptCursor = 0; return; }
  if (ctrl && name === 'e') { state.promptCursor = graphemes(state.promptValue).length; return; }
  if (name === 'enter') {
    const value = state.promptValue.trim();
    if (state.prompt === 'rename' && value) {
      const chatId = state.promptData?.chatId;
      const chat = state.chats.find((c) => c.id === chatId);
      if (chat) chat.title = value;
      effects.push(effect('renameChat', { chatId, title: value }));
    } else if (state.prompt === 'addMcp' && value) {
      openPrompt(state, 'addMcpCommand', '', { name: value }); return;
    } else if (state.prompt === 'addMcpCommand' && value) {
      effects.push(effect('addMcp', { name: state.promptData?.name, command: value }));
    }
    state.prompt = null; state.promptValue = ''; state.promptData = null;
    return;
  }
  const chars = graphemes(state.promptValue), i = state.promptCursor;
  if (name === 'backspace' && i > 0) { chars.splice(i - 1, 1); state.promptCursor--; }
  else if (name === 'delete') chars.splice(i, 1);
  else if (name === 'left') state.promptCursor = Math.max(0, i - 1);
  else if (name === 'right') state.promptCursor = Math.min(chars.length, i + 1);
  else if (name === 'home') state.promptCursor = 0;
  else if (name === 'end') state.promptCursor = chars.length;
  else if (char && !ctrl) { chars.splice(i, 0, char); state.promptCursor += graphemes(char).length; }
  state.promptValue = chars.join('');
}
function handleKey(state, key = {}) {
  const effects = [];
  // Node's readline reports a real terminal Enter as "return" (LF is "enter").
  const rawName = String(key.name || '').toLowerCase();
  const name = rawName === 'return' ? 'enter' : rawName;
  const ctrl = !!key.ctrl, shift = !!key.shift;
  const char = !ctrl && key.char && !/[\x00-\x1f\x7f\x9f]/.test(key.char) ? clean(key.char) : '';
  if (ctrl && name === 'c') { effects.push(effect('quit')); return { state, effects }; }
  if (state.pendingApproval) {
    if (name === 'y' || char.toLowerCase() === 'y' || name === 'enter') {
      effects.push(effect('approval', { approved: true })); state.pendingApproval = null;
    } else if (name === 'n' || char.toLowerCase() === 'n' || name === 'escape' || (ctrl && name === 'x')) {
      if (ctrl && name === 'x') effects.push(effect('interrupt'));
      effects.push(effect('approval', { approved: false })); state.pendingApproval = null;
    }
    return { state, effects };
  }
  if (state.prompt) { promptKey(state, name, char, ctrl, effects); return { state, effects }; }
  if (ctrl && name === 'x') { effects.push(effect('interrupt')); return { state, effects }; }
  if (ctrl && name === 's') {
    if (state.busy) { setNotice(state, 'Change SYSTEM access after the current run'); return { state, effects }; }
    if (state.systemAccess) { state.systemAccess = false; state.armedAt = 0; effects.push(effect('armSystem', { armed: false })); setNotice(state, 'SYSTEM disarmed'); }
    else if (state.armedAt && Date.now() - state.armedAt < 3000) {
      state.systemAccess = true; state.armedAt = 0; effects.push(effect('armSystem', { armed: true })); setNotice(state, 'SYSTEM armed · full machine access');
    } else { state.armedAt = Date.now(); setNotice(state, 'Press Ctrl+S again to arm SYSTEM (3 seconds)'); }
    return { state, effects };
  }
  if (ctrl && name === 'p') { openView(state, 'palette'); return { state, effects }; }
  if (ctrl && name === 'n') { commandAction(state, '/new', effects); return { state, effects }; }
  if (ctrl && name === 'm') { effects.push(effect('toggleMic')); return { state, effects }; }
  if (ctrl && name === 'u' && state.view === 'chat') { state.composer = ''; state.cursor = 0; return { state, effects }; }
  if (name === 'escape') {
    if (state.view !== 'chat') closeView(state);
    else if (state.busy) effects.push(effect('interrupt'));
    else if (state.composer) { state.composer = ''; state.cursor = 0; }
    return { state, effects };
  }
  if (state.view === 'mcp') {
    const list = state.mcp.filter((item) => item.name.toLowerCase().includes(state.mcpFilter.toLowerCase()));
    if (name === 'up') state.mcpSelection = Math.max(0, state.mcpSelection - 1);
    else if (name === 'down') state.mcpSelection = Math.min(list.length - 1, state.mcpSelection + 1);
    else if (name === 'space' || char === ' ') {
      const item = list[state.mcpSelection];
      if (item) { item.enabled = !item.enabled; effects.push(effect('toggleMcp', { name: item.name, enabled: item.enabled })); }
    } else if (char === '/') { state.mcpSearch = !state.mcpSearch; if (state.mcpSearch) { state.mcpFilter = ''; state.mcpSelection = 0; } }
    else if (state.mcpSearch && name === 'backspace') { state.mcpFilter = graphemes(state.mcpFilter).slice(0, -1).join(''); state.mcpSelection = 0; }
    else if (state.mcpSearch && char) { state.mcpFilter += char; state.mcpSelection = 0; }
    else if (char.toLowerCase() === 'a') openPrompt(state, 'addMcp');
    else if (char.toLowerCase() === 'x') {
      const item = list[state.mcpSelection];
      if (item) { item.enabled = false; item.connected = false; effects.push(effect('disconnectMcp', { name: item.name })); }
    } else if (name === 'enter') {
      const item = list[state.mcpSelection]; if (item) effects.push(effect('inspectMcp', { name: item.name }));
    }
    return { state, effects };
  }
  if (state.view === 'skills') {
    const list = state.skills.filter((s) => s.name.toLowerCase().includes(state.skillFilter.toLowerCase()));
    if (name === 'up') state.skillSelection = Math.max(0, state.skillSelection - 1);
    else if (name === 'down') state.skillSelection = Math.min(list.length - 1, state.skillSelection + 1);
    else if (name === 'enter' || name === 'space' || char === ' ') {
      const item = list[state.skillSelection];
      if (item) { item.active = !item.active; effects.push(effect('toggleSkill', { name: item.name, active: item.active })); }
    } else if (name === 'backspace') { state.skillFilter = graphemes(state.skillFilter).slice(0, -1).join(''); state.skillSelection = 0; }
    else if (char === '/') { state.skillFilter = ''; state.skillSelection = 0; }
    else if (char) { state.skillFilter += char; state.skillSelection = 0; }
    return { state, effects };
  }
  if (state.view === 'chats') {
    const list = filteredChats(state), chat = list[state.chatSelection];
    if (name === 'up') state.chatSelection = Math.max(0, state.chatSelection - 1);
    else if (name === 'down') state.chatSelection = Math.min(list.length - 1, state.chatSelection + 1);
    else if (name === 'enter' && chat) {
      if (state.busy) setNotice(state, 'Finish the current run before switching chats');
      else { state.activeChatId = chat.id; closeView(state); state.transcriptScroll = 0; effects.push(effect('switchedChat', { chatId: chat.id })); }
    } else if (char === '/') { state.chatSearch = !state.chatSearch; if (state.chatSearch) { state.chatFilter = ''; state.chatSelection = 0; } }
    else if (state.chatSearch && name === 'backspace') { state.chatFilter = graphemes(state.chatFilter).slice(0, -1).join(''); state.chatSelection = 0; }
    else if (state.chatSearch && char) { state.chatFilter += char; state.chatSelection = 0; }
    else if (char.toLowerCase() === 'r' && chat && !state.busy) openPrompt(state, 'rename', chat.title, { chatId: chat.id });
    else if (char.toLowerCase() === 'p' && chat && !state.busy) {
      chat.pinned = !chat.pinned; effects.push(effect('pinChat', { chatId: chat.id, pinned: chat.pinned }));
      state.chatSelection = Math.max(0, filteredChats(state).findIndex((c) => c.id === chat.id));
    } else if (char.toLowerCase() === 'd' && chat && !state.busy) effects.push(effect('confirmDeleteChat', { chatId: chat.id }));
    else if (char.toLowerCase() === 'n') commandAction(state, '/new', effects);
    return { state, effects };
  }
  if (state.view === 'palette') {
    const list = filteredCommands(state);
    if (name === 'up') state.paletteSelection = Math.max(0, state.paletteSelection - 1);
    else if (name === 'down') state.paletteSelection = Math.min(list.length - 1, state.paletteSelection + 1);
    else if (name === 'enter' && list[state.paletteSelection]) {
      state.view = 'chat'; commandAction(state, list[state.paletteSelection].command, effects);
    } else if (name === 'backspace') { state.paletteFilter = graphemes(state.paletteFilter).slice(0, -1).join(''); state.paletteSelection = 0; }
    else if (char) { state.paletteFilter += char; state.paletteSelection = 0; }
    return { state, effects };
  }
  if (state.view === 'files') {
    const list = filteredFiles(state), file = list[state.fileSelection];
    if (name === 'up') state.fileSelection = Math.max(0, state.fileSelection - 1);
    else if (name === 'down') state.fileSelection = Math.min(list.length - 1, state.fileSelection + 1);
    else if ((name === 'enter' || name === 'space' || char === ' ') && file) {
      const i = state.attachments.indexOf(file.path);
      if (i >= 0) state.attachments.splice(i, 1);
      else state.attachments.push(file.path);
      if (name === 'enter') closeView(state);
    } else if (name === 'backspace') { state.fileFilter = graphemes(state.fileFilter).slice(0, -1).join(''); state.fileSelection = 0; }
    else if (char) { state.fileFilter += char; state.fileSelection = 0; }
    return { state, effects };
  }
  if (name === 'enter') {
    if (shift) { const chars = graphemes(state.composer); chars.splice(state.cursor, 0, '\n'); state.composer = chars.join(''); state.cursor++; }
    else sendMessage(state, effects);
    return { state, effects };
  }
  if (name === 'tab') {
    state.mode = state.modes[(state.modes.indexOf(state.mode) + 1) % state.modes.length];
    setNotice(state, `Mode: ${state.mode}`);
    effects.push(effect('modeChanged', { mode: state.mode }));
    return { state, effects };
  }
  if (name === 'pageup') { state.transcriptScroll += Math.max(3, state.rows - 12); return { state, effects }; }
  if (name === 'pagedown') { state.transcriptScroll = Math.max(0, state.transcriptScroll - Math.max(3, state.rows - 12)); return { state, effects }; }
  if (name === 'up' && state.history.length && state.cursor === graphemes(state.composer).length) {
    if (state.historyIndex < 0) state.historyDraft = state.composer;
    state.historyIndex = Math.min(state.history.length - 1, state.historyIndex + 1);
    state.composer = state.history[state.historyIndex]; state.cursor = graphemes(state.composer).length;
    return { state, effects };
  }
  if (name === 'down' && state.historyIndex >= 0) {
    state.historyIndex--;
    state.composer = state.historyIndex < 0 ? state.historyDraft : state.history[state.historyIndex];
    state.cursor = graphemes(state.composer).length;
    return { state, effects };
  }
  const chars = graphemes(state.composer), i = state.cursor;
  if (ctrl && name === 'a') state.cursor = 0;
  else if (ctrl && name === 'e') state.cursor = chars.length;
  else if (ctrl && name === 'w' && i > 0) {
    let start = i;
    while (start > 0 && /\s/.test(chars[start - 1])) start--;
    while (start > 0 && !/\s/.test(chars[start - 1])) start--;
    chars.splice(start, i - start);
    state.cursor = start;
  }
  else if (name === 'left') state.cursor = Math.max(0, i - 1);
  else if (name === 'right') state.cursor = Math.min(chars.length, i + 1);
  else if (name === 'home') state.cursor = 0;
  else if (name === 'end') state.cursor = chars.length;
  else if (name === 'backspace' && i > 0) { chars.splice(i - 1, 1); state.cursor--; }
  else if (name === 'delete') chars.splice(i, 1);
  else if (char) { chars.splice(i, 0, ...graphemes(char)); state.cursor += graphemes(char).length; }
  state.composer = chars.join('');
  if (state.historyIndex >= 0 && (name === 'backspace' || name === 'delete' || char)) state.historyIndex = -1;
  return { state, effects };
}

// ─────────────────────────── rendering
const spinners = ['◐', '◓', '◑', '◒'];
function renderHeader(state) {
  const w = state.cols;
  const logo = `${fg(C.blue)}◈ ${BOLD}${fg(C.ivory)}N E X U S${RESET}`;
  const link = state.online ? `${fg(C.green)}●${RESET} ${fg(C.grey)}LOCAL LINK${RESET}`
    : `${fg(C.amber)}○${RESET} ${fg(C.grey)}LM STUDIO OFFLINE${RESET}`;
  const title = truncate(getActiveChat(state)?.title || 'New conversation', Math.max(8, Math.floor(w / 2)));
  const label = w < 54 ? `${logo}  ${link}` : joinLR('  ' + logo, link + '  ', w);
  if (state.rows < 13) return [row(label, w)];
  const workspace = truncate(state.workspace.replace(/\\/g, '/'), Math.max(12, w < 70 ? 22 : Math.floor(w / 3)));
  const meta = `${fg(C.muted)}  ${workspace}${RESET}${fg(C.steel)}  /  ${RESET}${fg(C.ivory)}${title}${RESET}`;
  const status = `${fg(state.systemAccess ? C.amber : C.green)}${state.systemAccess ? '⚡ SYSTEM' : '◇ SAFE'}${RESET}   ${fg(C.grey)}${state.mode.toUpperCase()}${RESET}  `;
  const parts = [row(label, w), row(joinLR(meta, status, w), w)];
  const pulse = state.animation && (state.busy || state.micRecording);
  const at = pulse ? (state.tickFrame * 2) % Math.max(1, w) : w;
  const rail = fg(C.navy) + '─'.repeat(at) + (pulse ? fg(C.blue) + '━━' + fg(C.navy) : '') + '─'.repeat(Math.max(0, w - at - 2));
  parts.push(row(rail, w));
  return parts;
}
function renderPresence(state) {
  const w = state.cols;
  const working = state.busy || state.micRecording || state.presence === 'understanding';
  const accent = state.presence === 'error' ? C.red : state.presence === 'done' ? C.green
    : state.presence === 'listening' ? C.amber : working ? C.blue : C.steel;
  const spinner = working && state.animation ? spinners[state.tickFrame % spinners.length]
    : working ? '◉' : state.animation ? ['◈', '◇'][Math.floor(state.tickFrame / 6) % 2] : '◈';
  const lead = `  ${fg(accent)}${spinner}${RESET}  ${fg(C.ivory)}${truncate(state.activityLine && working ? state.activityLine : state.presenceText, Math.max(5, w - 30))}${RESET}`;
  const time = working ? `${Math.floor((Date.now() - state.presenceStarted) / 1000)}s` : state.stopped ? 'PAUSED' : 'READY';
  return [row(joinLR(lead, fg(C.muted) + time + RESET + '  ', w), w)];
}
const messageCache = new WeakMap();
function messageLines(message, width) {
  const text = clean(message.text), cached = messageCache.get(message);
  if (cached && cached.width === width && cached.text === text) return cached.lines;
  const isYou = message.who === 'you';
  const name = isYou ? 'YOU' : 'NEXUS';
  const label = `  ${fg(isYou ? C.blue : C.green)}${BOLD}${name}${RESET}`;
  const lines = [label];
  for (const segment of wrap(text, Math.max(1, width - 7))) {
    lines.push(`  ${fg(isYou ? C.steel : C.green)}│${RESET}  ${fg(C.ivory)}${segment}${RESET}`);
  }
  lines.push('');
  messageCache.set(message, { width, text, lines });
  return lines;
}
function renderTranscript(state, height = Math.max(0, state.rows - 10)) {
  const w = state.cols;
  if (height <= 0) return [];
  const chat = getActiveChat(state), messages = chat?.messages || [];
  const active = messages.length ? `${messages.length} messages` : 'new session';
  const title = joinLR(`${fg(C.steel)}  CONVERSATION${RESET}  ${fg(C.muted)}· ${active}${RESET}`,
    state.transcriptScroll ? `${fg(C.amber)}↑ older${RESET}  ` : '', w);
  if (height === 1) return [row(title, w)];
  const space = height - 1;
  let output = [row(title, w)];
  if (!messages.length) {
    // The compact chain-shaped brand mark keeps the original NEXUS identity
    // without reserving half the terminal for a splash screen.
    const mark = space >= 11 && w >= 50 ? [
      `${fg(C.steel)}    ▄██▄     ▄██▄    ${RESET}`,
      `${fg(state.animation && Math.floor(state.tickFrame / 5) % 2 ? C.blue : C.steel)}  ▟██▀▀██▄▄▄██▀▀██▙  ${RESET}`,
      `${fg(C.steel)}   ▀██▄▄█▀▀▀█▄▄██▀   ${RESET}`,
      '',
    ] : [];
    const content = [
      '', ...mark,
      `${fg(C.blue)}${state.animation ? ['◈', '◇'][Math.floor(state.tickFrame / 6) % 2] : '◈'}${RESET}  ${BOLD}${fg(C.ivory)}N E X U S${RESET}`,
      `${fg(C.muted)}Your local workspace companion${RESET}`, '',
      `${fg(C.grey)}Ask a question, attach @file, or run !command${RESET}`,
      `${fg(C.muted)}Ctrl+P for commands  ·  Tab to switch modes${RESET}`,
    ];
    const top = Math.max(0, Math.floor((space - content.length) / 2));
    for (let i = 0; i < space; i++) {
      const text = content[i - top];
      output.push(row(text ? center(text, w) : '', w));
    }
    return output;
  }
  // Take only the visible tail. Wrapping is cached per message, so animations
  // do not repeatedly reflow old model output.
  const wanted = space + Math.max(0, state.transcriptScroll);
  let count = 0, tail = [];
  for (let i = messages.length - 1; i >= 0 && count < wanted + space; i--) {
    const lines = messageLines(messages[i], w);
    tail = lines.concat(tail);
    count += lines.length;
  }
  const maxScroll = Math.max(0, tail.length - space);
  state.transcriptScroll = Math.min(state.transcriptScroll, maxScroll);
  const end = tail.length - state.transcriptScroll;
  const visible = tail.slice(Math.max(0, end - space), end);
  output = output.concat(Array(Math.max(0, space - visible.length)).fill(row('', w)));
  output.push(...visible.map((part) => row(part, w)));
  return output.slice(0, height);
}
function editorRows(value, cursor, width, maxRows, placeholder) {
  const glyphs = graphemes(clean(value)), lines = [[]];
  let col = 0, cursorLine = 0;
  for (let i = 0; i <= glyphs.length; i++) {
    if (i === cursor) cursorLine = lines.length - 1;
    if (i === glyphs.length) break;
    const g = glyphs[i];
    if (g === '\n') {
      if (i === cursor) lines[lines.length - 1].push({ g: ' ', cursor: true });
      lines.push([]); col = 0; continue;
    }
    const n = glyphWidth(g);
    if (col + n > width) { lines.push([]); col = 0; if (i === cursor) cursorLine = lines.length - 1; }
    lines[lines.length - 1].push({ g, cursor: i === cursor });
    col += n;
  }
  if (cursor === glyphs.length) {
    if (col >= width) lines.push([]);
    lines[lines.length - 1].push({ g: ' ', cursor: true });
  }
  const start = Math.min(Math.max(0, cursorLine - maxRows + 1), Math.max(0, lines.length - maxRows));
  const visible = lines.slice(start, start + maxRows);
  return visible.map((items, index) => {
    if (!glyphs.length && index === 0) return bg(C.blue) + ' ' + bg(C.navy) + fg(C.muted) + ' ' + placeholder;
    return items.map(({ g, cursor: current }) => current
      ? bg(C.blue) + fg(C.black) + g + bg(C.navy) + fg(C.ivory)
      : g).join('');
  });
}
function renderComposer(state) {
  const w = state.cols;
  const maxRows = state.rows >= 28 ? 3 : 1;
  const chosen = state.attachments.slice(0, 2).join(', ');
  const attachedNames = truncate(chosen, Math.max(8, Math.floor(w / 3))) +
    (state.attachments.length > 2 ? ` +${state.attachments.length - 2}` : '');
  const meta = state.attachments.length
    ? `  ${fg(C.blue)}⌁ ${attachedNames}${RESET}   ${fg(C.muted)}Enter send  ·  Shift+Enter newline${RESET}`
    : `  ${fg(C.muted)}Enter send  ·  Shift+Enter newline  ·  @file attach  ·  !cmd shell${RESET}`;
  const head = joinLR(`  ${fg(C.blue)}╭─${RESET} ${BOLD}${fg(C.ivory)}ASK NEXUS${RESET}`,
    `${fg(C.muted)}${state.busy ? 'WORKING' + (state.animation ? '.'.repeat(state.tickFrame % 4) : '') : state.mode.toUpperCase()}${RESET}  `, w);
  const input = editorRows(state.composer, state.cursor, Math.max(2, w - 7), maxRows,
    'Ask anything about your workspace…');
  return [row(head, w), ...input.map((value) => row(`  ${fg(C.blue)}▏${RESET}${bg(C.navy)}${fg(C.ivory)}  ${value}`, w, C.navy)), row(meta, w)];
}
function renderUnderRow(state) {
  const mcp = state.mcp.filter((m) => m.enabled).length;
  const skills = state.skills.filter((s) => s.active).length;
  const queued = state.promptQueue ? state.promptQueue.length : 0;
  const tail = queued ? `    ${fg(C.amber)}${queued} QUEUED  /queue${RESET}` : '';
  return [row(`  ${fg(C.steel)}◈ MCP ${mcp}${RESET}    ${fg(C.steel)}✧ SKILLS ${skills}${RESET}    ${fg(C.muted)}Ctrl+P commands${RESET}}${tail}`, state.cols)];
}
function renderFooter(state) {
  const w = state.cols;
  if (!state.config.showHints) return [];
  let text;
  if (state.notice && Date.now() < state.noticeUntil) text = `${fg(C.amber)}  ◇ ${truncate(state.notice, Math.max(1, w - 5))}${RESET}`;
  else if (state.pendingApproval) text = `${fg(C.amber)}  Y approve  ·  N deny  ·  Ctrl+X stop${RESET}`;
  else if (state.view !== 'chat') text = `${fg(C.muted)}  ◈  Ctrl+P commands    Esc back    Ctrl+C quit${RESET}`;
  else text = `${fg(C.muted)}  Ctrl+P commands   Ctrl+N new   Ctrl+X stop   PgUp scroll   Ctrl+C quit${RESET}`;
  return [row(text, w)];
}
function listPanel(state, height, title, filter, entries, selection, hint, renderItem) {
  const w = state.cols;
  if (height < 1) return [];
  const output = [row(`  ${fg(C.blue)}${BOLD}${title}${RESET}  ${fg(C.muted)}· ${entries.length} items${RESET}`, w)];
  if (height === 1) return output;
  output.push(row(`  ${fg(C.muted)}SEARCH${RESET}  ${fg(C.ivory)}${truncate(filter || 'type to filter…', Math.max(4, w - 13))}${RESET}`, w, C.navy));
  const slots = Math.max(0, height - 3);
  const offset = Math.min(Math.max(0, selection - Math.floor(slots / 2)), Math.max(0, entries.length - slots));
  if (!entries.length && slots) output.push(row(`  ${fg(C.muted)}Nothing found — try another search${RESET}`, w));
  else for (const [index, item] of entries.slice(offset, offset + slots).entries()) {
    const selected = offset + index === selection;
    const marker = selected ? `${fg(C.blue)}▸${RESET}` : ' ';
    output.push(row(`  ${marker} ${renderItem(item, selected, w)}`, w, selected ? C.navy : C.black));
  }
  while (output.length < height - 1) output.push(row('', w));
  if (height >= 3) output.push(row(`  ${fg(C.muted)}${truncate(hint, Math.max(1, w - 4))}${RESET}`, w));
  return output.slice(0, height);
}
function renderPaletteOverlay(state, height = state.rows - 6) {
  const list = filteredCommands(state);
  return listPanel(state, height, 'COMMANDS', state.paletteFilter, list, state.paletteSelection,
    '↑↓ navigate   Enter run   Esc close', (item, selected, w) =>
      `${fg(selected ? C.ivory : C.blue)}${item.command}${RESET}` +
      `  ${fg(C.muted)}${truncate(item.description, Math.max(0, w - cellWidth(item.command) - 9))}${RESET}`);
}
function renderChatsOverlay(state, height = state.rows - 6) {
  const list = filteredChats(state);
  return listPanel(state, height, 'CONVERSATIONS', state.chatSearch ? state.chatFilter + '▏' : state.chatFilter || 'press / to search…', list, state.chatSelection,
    'Enter open   R rename   P pin   D delete   / search   N new', (chat, selected, w) =>
      `${fg(chat.pinned ? C.amber : C.muted)}${chat.pinned ? '◆' : '○'}${RESET} ` +
      `${fg(selected ? C.ivory : C.grey)}${truncate(chat.title, Math.max(6, w - 24))}${RESET}` +
      (chat.id === state.activeChatId ? `${fg(C.green)}  · CURRENT${RESET}` : ''));
}
function renderMcpOverlay(state, height = state.rows - 6) {
  const list = state.mcp.filter((item) => item.name.toLowerCase().includes(state.mcpFilter.toLowerCase()));
  return listPanel(state, height, 'MCP CONNECTIONS', state.mcpSearch ? state.mcpFilter + '▏' : state.mcpFilter || 'press / to search…', list, state.mcpSelection,
    'Space toggle   Enter inspect   A add   X disconnect   / search', (item, selected, w) =>
      `${fg(selected ? C.ivory : C.grey)}${truncate(item.name, Math.max(5, w - 25))}${RESET} ` +
      `${fg(item.enabled ? C.green : C.muted)}${item.enabled ? '● ENABLED' : '○ DISABLED'}${RESET}` +
      (item.connected ? `${fg(C.blue)}  · LIVE${RESET}` : ''));
}
function renderSkillsOverlay(state, height = state.rows - 6) {
  const list = state.skills.filter((s) => s.name.toLowerCase().includes(state.skillFilter.toLowerCase()));
  return listPanel(state, height, 'SKILLS', state.skillFilter, list, state.skillSelection,
    'Space / Enter toggle   Type to filter   / reset', (item, selected, w) =>
      `${fg(item.active ? C.green : C.muted)}${item.active ? '●' : '○'}${RESET} ` +
      `${fg(selected ? C.ivory : C.grey)}${truncate(item.name, Math.max(4, Math.floor(w / 3)))}${RESET}` +
      `  ${fg(C.muted)}${truncate(item.description || '', Math.max(0, Math.floor(w / 2)))}${RESET}`);
}
function renderFilesOverlay(state, height = state.rows - 6) {
  const list = filteredFiles(state);
  return listPanel(state, height, 'ATTACH FILE', state.fileFilter, list, state.fileSelection,
    'Enter attach & close   Space multi-select   Esc return', (file, selected, w) =>
      `${fg(state.attachments.includes(file.path) ? C.green : C.muted)}${state.attachments.includes(file.path) ? '●' : '○'}${RESET} ` +
      `${fg(selected ? C.ivory : C.grey)}${truncate(file.path, Math.max(4, w - 8))}${RESET}`);
}
function renderApprovalOverlay(state, height = state.rows - 5) {
  const w = state.cols, approval = state.pendingApproval || {};
  if (height < 10) {
    const compact = [
      `${fg(C.amber)}◈ PERMISSION REQUIRED${RESET}`,
      `${fg(C.ivory)}${truncate(approval.name || 'Confirm action', Math.max(1, w - 4))}${RESET}`,
      ...wrap(approval.detail || '', Math.max(1, w - 4)).slice(0, Math.max(0, height - 3)).map((part) => fg(C.grey) + part + RESET),
    ];
    while (compact.length < height - 1) compact.push('');
    compact.push(`${fg(C.green)}[Y] APPROVE${RESET}   ${fg(C.red)}[N] DENY${RESET}`);
    return compact.slice(0, height).map((part) => row(center(part, w), w));
  }
  const content = [
    '', `${fg(C.amber)}◈  PERMISSION REQUIRED${RESET}`, '',
    `${fg(C.ivory)}${truncate(approval.name || 'Confirm action', Math.max(1, w - 6))}${RESET}`, '',
    ...wrap(approval.detail || '', Math.max(1, w - 10)).slice(0, Math.max(1, height - 9)).map((part) => fg(C.grey) + part + RESET),
    '', `${fg(C.green)}[ Y ] APPROVE${RESET}     ${fg(C.red)}[ N ] DENY${RESET}`, '',
  ];
  const offset = Math.max(0, Math.floor((height - content.length) / 2));
  return Array.from({ length: height }, (_, i) => row(content[i - offset] ? center(content[i - offset], w) : '', w));
}
function renderPrompt(state) {
  const w = state.cols;
  const label = {
    rename: 'RENAME CONVERSATION', addMcp: 'NEW MCP SERVER NAME',
    addMcpCommand: 'MCP SERVER COMMAND (executable and arguments)',
  }[state.prompt] || 'INPUT';
  const chars = graphemes(clean(state.promptValue).replace(/\n/g, ' ')), cursor = Math.max(0, Math.min(state.promptCursor, chars.length));
  let start = 0;
  const room = Math.max(2, w - 8);
  while (start < cursor && cellWidth(chars.slice(start, cursor).join('')) >= room) start++;
  const value = (start ? '…' : '') + chars.slice(start, cursor).join('') +
    fg(C.blue) + '▏' + fg(C.ivory) + chars.slice(cursor).join('');
  return [
    row(`  ${fg(C.blue)}${label}${RESET}`, w),
    row(`  ${fg(C.ivory)}>  ${value}${RESET}`, w, C.navy),
    row(`  ${fg(C.muted)}Enter confirm   Esc cancel${RESET}`, w),
  ];
}
function renderToLines(state) {
  // Always budget the composer and footer first, even on a 12-row terminal.
  const w = Math.max(1, Number(state.cols) || 80), h = Math.max(1, Number(state.rows) || 24);
  const oldCols = state.cols; state.cols = w;
  const header = renderHeader(state);
  const presence = h >= 16 && state.config.showPresence ? renderPresence(state) : [];
  const footer = h >= 6 ? renderFooter(state) : [];
  const bottom = state.pendingApproval ? [] : state.prompt ? renderPrompt(state)
    : state.view === 'chat' ? [...renderComposer(state), ...(h >= 22 && w >= 60 ? renderUnderRow(state) : [])] : [];
  const available = Math.max(0, h - header.length - presence.length - bottom.length - footer.length);
  const body = state.pendingApproval ? renderApprovalOverlay(state, available)
    : state.view === 'palette' ? renderPaletteOverlay(state, available)
    : state.view === 'chats' ? renderChatsOverlay(state, available)
    : state.view === 'mcp' ? renderMcpOverlay(state, available)
    : state.view === 'skills' ? renderSkillsOverlay(state, available)
    : state.view === 'files' ? renderFilesOverlay(state, available)
    : renderTranscript(state, available);
  state.cols = oldCols;
  let lines = [...header, ...presence, ...body, ...bottom, ...footer];
  if (lines.length > h) lines = [...lines.slice(0, Math.max(0, h - bottom.length - footer.length)), ...bottom, ...footer];
  while (lines.length < h) lines.splice(Math.max(0, lines.length - footer.length), 0, row('', w));
  return lines.slice(0, h).map((line) => state.noColor ? line.replace(ansi, '') : line);
}

module.exports = {
  makeState, renderToLines, handleKey, addTranscript, addActivity, setPresence, setNotice,
  newChat, deleteCurrentChat, openView, closeView, getActiveChat, sortedChats,
  commands, colors: C, clean, cellWidth, filteredFiles, filteredCommands,
  renderHeader, renderPresence, renderTranscript, renderComposer, renderUnderRow, renderFooter,
  renderMcpOverlay, renderSkillsOverlay, renderChatsOverlay, renderPaletteOverlay, renderApprovalOverlay,
  renderFilesOverlay, renderPrompt,
};
