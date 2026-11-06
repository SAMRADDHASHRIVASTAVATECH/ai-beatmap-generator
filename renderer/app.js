'use strict';

const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const activity = $('activity');
const input = $('input');
const sendBtn = $('sendBtn');

let busy = false;
let currentRunId = null;
let activeTab = 'cores';
let capState = { servers: [], skills: 0, toolCount: 0, skillList: [] };
let poolCount = 0;

// =================================================================== helpers
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function atBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
}
function scrollMaybe() {
  if (atBottom()) transcript.scrollTop = transcript.scrollHeight;
}
function addActivity(text, kind = '') {
  const row = el('div', 'ev ' + kind, text);
  activity.appendChild(row);
  activity.scrollTop = activity.scrollHeight;
  while (activity.children.length > 300) activity.removeChild(activity.firstChild);
}
function clearEmpty() {
  const e = transcript.querySelector('.empty');
  if (e) e.remove();
}
function setState(text, kind = '') {
  const s = $('stateLine');
  s.textContent = text;
  s.className = 'foot-note state ' + kind;
}

// =================================================================== transcript
function addUser(text) {
  clearEmpty();
  const m = el('div', 'msg user');
  m.appendChild(el('div', 'who', 'OPERATOR'));
  m.appendChild(el('div', 'body', text));
  transcript.appendChild(m);
  scrollMaybe();
}

function addAssistant(text, depth = 0) {
  clearEmpty();
  const m = el('div', 'msg assistant' + (depth ? ' sub' : ''));
  m.appendChild(el('div', 'who', depth ? `HELPER · LINK ${depth}` : 'NEXUS'));
  m.appendChild(el('div', 'body', text));
  transcript.appendChild(m);
  scrollMaybe();
}

function addTool(name, args, result, depth = 0) {
  clearEmpty();
  const isErr = String(result || '').startsWith('ERROR');
  const box = el('div', 'tool' + (isErr ? ' err' : '') + (depth ? ' sub' : ''));
  const head = el('div');
  head.appendChild(el('span', 'name', name));
  const argStr = JSON.stringify(args || {});
  head.appendChild(document.createTextNode(' ' + (argStr.length > 170 ? argStr.slice(0, 170) + 'â€¦' : argStr)));
  box.appendChild(head);
  if (result) {
    const pre = el('div', '', String(result).slice(0, 1600));
    pre.style.marginTop = '4px';
    pre.style.color = isErr ? 'var(--red)' : 'var(--dim)';
    box.appendChild(pre);
  }
  transcript.appendChild(box);
  scrollMaybe();
}

function addSys(text, kind = '') {
  clearEmpty();
  transcript.appendChild(el('div', 'sys ' + kind, text));
  scrollMaybe();
}

function addPlan(steps) {
  clearEmpty();
  const box = el('div', 'plan');
  box.appendChild(el('div', 'plan-head', `MISSION PLAN · ${steps.length} PHASE${steps.length > 1 ? 'S' : ''}`));
  for (const s of steps) {
    const row = el('div', 'plan-step');
    row.appendChild(el('span', 'plan-n', String(s.id).padStart(2, '0')));
    row.appendChild(el('span', 'plan-agent', s.agent.toUpperCase()));
    row.appendChild(el('span', 'plan-task', s.task));
    box.appendChild(row);
  }
  transcript.appendChild(box);
  scrollMaybe();
}

function addPhase(text) {
  clearEmpty();
  transcript.appendChild(el('div', 'phase', String(text).toUpperCase()));
  scrollMaybe();
}

function addStepDone(step, agent, brief) {
  const box = el('div', 'brief');
  box.appendChild(el('div', 'brief-head', `PHASE ${step} · ${String(agent).toUpperCase()} · BRIEF`));
  box.appendChild(el('div', 'brief-body', brief));
  transcript.appendChild(box);
  scrollMaybe();
}

function addTodos(items) {
  clearEmpty();
  const old = transcript.querySelector('.todos');
  if (old) old.remove();
  if (!items.length) return;
  const box = el('div', 'todos');
  box.appendChild(el('div', 'todos-head', `TASK LIST · ${items.filter((t) => t.status === 'done').length}/${items.length}`));
  const mark = { pending: 'â—‹', in_progress: 'â–¸', done: 'âœ“', blocked: 'âœ—' };
  for (const t of items) {
    const row = el('div', 'todo ' + t.status);
    row.appendChild(el('span', 'mark', mark[t.status] || 'â—‹'));
    row.appendChild(el('span', '', t.task + (t.note ? ' â€” ' + t.note : '')));
    box.appendChild(row);
  }
  transcript.appendChild(box);
  scrollMaybe();
}

// =================================================================== cores panel
function renderPool(pool) {
  if (!pool) return;
  $('serverStat').textContent = pool.serverUp === false ? 'DOWN' : 'ONLINE';
  $('serverStat').style.color = pool.serverUp === false ? 'var(--red)' : 'var(--cy)';
  $('vramStat').textContent = pool.freeVramMb >= 0 ? `${pool.freeVramMb} MB` : 'N/A';
  $('vramStat').style.color = pool.freeVramMb >= 0 && pool.freeVramMb < 300 ? 'var(--gold)' : 'var(--cy)';

  const res = pool.resident || [];
  $('residentStat').textContent = res.length ? res.map((r) => r.label.toUpperCase()).join(' + ') : 'NONE';
  poolCount = (pool.inventory || []).length;
  if (activeTab === 'cores') $('tabTag').textContent = String(poolCount).padStart(2, '0');

  const sel = $('modelSel');
  const selected = sel.value;
  sel.replaceChildren();
  const automatic = el('option', '', 'auto route');
  automatic.value = '';
  sel.appendChild(automatic);
  for (const m of pool.models || []) {
    if (m.key === 'embedder' || /embed/i.test(m.type || '')) continue;
    const option = el('option', '', `${m.label}${m.available ? '' : ' (unavailable)'}`);
    option.value = m.key;
    option.disabled = !m.available;
    sel.appendChild(option);
  }
  if ([...sel.options].some((o) => o.value === selected && !o.disabled)) sel.value = selected;

  const list = $('poolList');
  list.innerHTML = '';
  for (const m of pool.models || []) {
    const card = el('div', 'core' + (m.resident ? ' on' : ''));
    card.appendChild(el('div', 'nm', m.label));
    card.appendChild(el('div', 'st', m.resident ? 'RESIDENT' : !m.available ? 'UNAVAILABLE' : m.pinned ? 'PINNED' : 'STANDBY'));
    card.appendChild(el('div', 'rl', m.role));
    const bars = el('div', 'bars');
    for (let i = 0; i < 8; i++) bars.appendChild(el('i'));
    card.appendChild(bars);

    const btns = el('div', 'btns');
    const bLoad = el('button', '', m.resident ? 'RELOAD' : 'LOAD');
    bLoad.disabled = !m.available;
    bLoad.onclick = async () => {
      bLoad.disabled = true;
      bLoad.textContent = 'â€¦';
      try {
        renderPool(await window.nexus.poolLoad(m.key));
      } catch (e) {
        addActivity('load failed: ' + e.message, 'err');
        bLoad.disabled = false;
        bLoad.textContent = 'LOAD';
      }
    };
    const bUnload = el('button', '', 'EJECT');
    bUnload.onclick = async () => {
      try { renderPool(await window.nexus.poolUnload(m.key)); }
      catch (e) { addActivity('eject failed: ' + e.message, 'err'); }
    };
    btns.appendChild(bLoad);
    btns.appendChild(bUnload);
    card.appendChild(btns);
    list.appendChild(card);
  }
}

async function refreshPool() {
  try {
    renderPool(await window.nexus.poolStatus());
  } catch (e) {
    addActivity('pool status failed: ' + e.message, 'err');
  }
}

// =================================================================== capabilities
function renderCapabilities(cap, skills = null) {
  if (!cap) return;
  capState = { ...cap, skillList: skills || capState.skillList || [] };
  const servers = cap.servers || [];
  const ready = servers.filter((s) => s.state === 'ready').length;
  const tools = Number(cap.toolCount || 0);
  const skillCount = Number(cap.skills || capState.skillList.length || 0);

  $('capServers').textContent = `${ready}/${servers.length}`;
  $('capTools').textContent = String(tools);
  $('capSkills').textContent = String(skillCount);
  $('toolStat').textContent = String(tools);
  $('toolStat').style.color = tools > 0 ? 'var(--cy)' : 'var(--dim)';

  $('capLine').innerHTML = `<b>${servers.length}</b> mcp servers · <b>${tools}</b> tools · <b>${skillCount}</b> skills · <b>${ready}</b> warm`;

  if (activeTab === 'caps') $('tabTag').textContent = String(tools);

  const list = $('serverList');
  list.innerHTML = '';
  const order = { ready: 0, starting: 1, idle: 2, error: 3 };
  for (const s of [...servers].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.name.localeCompare(b.name))) {
    const row = el('div', `srv ${s.state}`, '');
    row.appendChild(el('span', 'sname', s.name));
    row.appendChild(el('span', 'scount', s.tools ? String(s.tools) : '·'));
    row.appendChild(el('span', 'sdot', ''));
    row.title = `${s.name}\nstate: ${s.state}\ntools: ${s.tools}\n${s.command}`;
    row.onclick = () => loadServer(s.name);
    list.appendChild(row);
  }

  const sk = $('skillList');
  sk.innerHTML = '';
  const list_s = capState.skillList || [];
  if (!list_s.length) {
    sk.appendChild(el('div', 'skill-item', '(none found)'));
  } else {
    for (const s of list_s.slice(0, 300)) {
      const row = el('div', 'skill-item', s.id);
      row.title = s.description || s.name;
      row.onclick = async () => {
        try {
          const r = await window.nexus.skillRead(s.id);
          if (r.error) return addActivity(r.error, 'err');
          clearEmpty();
          const box = el('div', 'tool');
          box.appendChild(el('span', 'name', 'skill · ' + r.id));
          const pre = el('div', '', String(r.text).slice(0, 3000));
          pre.style.marginTop = '4px';
          box.appendChild(pre);
          transcript.appendChild(box);
          scrollMaybe();
        } catch (e) {
          addActivity('skill read failed: ' + e.message, 'err');
        }
      };
      sk.appendChild(row);
    }
  }
}

async function loadServer(name) {
  addActivity(`starting ${name}â€¦`);
  try {
    renderCapabilities(await window.nexus.mcpStart(name));
    const r = await window.nexus.mcpInspect(name);
    addActivity(`${name}: ${r.tools.length} tools`, 'ok');
  } catch (e) {
    addActivity(`${name}: ${e.message}`, 'err');
  }
}

async function refreshCaps() {
  try {
    const cap = await window.nexus.mcpStatus();
    let skills = capState.skillList || [];
    if (!skills.length) {
      try {
        skills = await window.nexus.skillList();
      } catch {}
    }
    renderCapabilities(cap, skills);
  } catch (e) {
    addActivity('capability read failed: ' + e.message, 'err');
  }
}

function setTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === name);
  $('tabCores').classList.toggle('hidden', name !== 'cores');
  $('tabCaps').classList.toggle('hidden', name !== 'caps');
  $('tabTel').classList.toggle('hidden', name !== 'tel');
  if (name === 'cores') $('tabTag').textContent = String(poolCount).padStart(2, '0');
  if (name === 'caps') $('tabTag').textContent = String(capState.toolCount || 0);
  if (name === 'tel') $('tabTag').textContent = String(document.querySelectorAll('.activity .ev').length);
  if (name === 'caps') refreshCaps();
}

// =================================================================== directory
async function refreshFiles() {
  const tree = $('fileTree');
  tree.innerHTML = '<em>scanningâ€¦</em>';
  try {
    const out = await window.nexus.listFiles();
    tree.innerHTML = '';
    if (!out || out === '(empty)') {
      tree.innerHTML = '<em>workspace is empty</em>';
      return;
    }
    for (const line of out.split('\n').slice(0, 600)) {
      const isDir = line.endsWith('/');
      const row = el('div', 'row' + (isDir ? ' dir' : ''), line);
      if (!isDir) {
        row.onclick = async () => {
          const content = await window.nexus.readFile(line);
          clearEmpty();
          const box = el('div', 'tool');
          box.appendChild(el('span', 'name', line));
          const pre = el('div', '', String(content).slice(0, 4000));
          pre.style.marginTop = '4px';
          box.appendChild(pre);
          transcript.appendChild(box);
          scrollMaybe();
        };
      }
      tree.appendChild(row);
    }
  } catch (e) {
    tree.innerHTML = '<em>could not scan: ' + e.message + '</em>';
  }
}

// =================================================================== send
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'WORKING';
  input.value = '';

  addUser(text);
  currentRunId = 'run_' + Date.now().toString(36);
  const force = $('modelSel').value || undefined;
  const mode = $('modeSel').value || 'auto';
  addActivity(`exec ${force ? force : mode}: ${text.slice(0, 60)}`);
  setState('WORKING', 'work');
  hud.target = 0.92;

  try {
    const res = await window.nexus.send(text, force, currentRunId, mode);
    if (res && res.error) {
      addSys('fault: ' + res.error, 'err');
      setState('FAULT', 'fault');
    } else {
      setState('IDLE');
    }
  } catch (e) {
    addSys('fault: ' + e.message, 'err');
    setState('FAULT', 'fault');
  } finally {
    busy = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'EXECUTE';
    hud.target = 0.2;
    refreshPool();
    refreshFiles();
  }
}

// =================================================================== events
window.nexus.onEvent((evt) => {
  switch (evt.type) {
    case 'run-start':
      addActivity(`core ${evt.label} · ${evt.why}`);
      setState(evt.depth ? `HELPER ${evt.depth} ACTIVE` : 'THINKING', 'work');
      hud.target = 0.8;
      break;
    case 'plan':
      addPlan(evt.steps || []);
      addActivity(`plan accepted · ${(evt.steps || []).length} phase(s)`);
      break;
    case 'phase':
      addPhase(evt.text || evt.phase);
      addActivity(`phase ${evt.phase}`);
      hud.pulse = 1;
      break;
    case 'step-done':
      addStepDone(evt.step, evt.agent, evt.brief || '');
      addActivity(`phase ${evt.step} complete (${evt.agent})`, 'ok');
      break;
    case 'assistant':
      addAssistant(evt.text, evt.depth || 0);
      break;
    case 'tool-call':
      addActivity(`exec ${evt.name}`);
      hud.pulse = 1;
      break;
    case 'tool-result':
      addTool(evt.name, {}, evt.result, evt.depth || 0);
      break;
    case 'run-done':
      addActivity(`core idle · ${evt.steps} cycle(s)`, 'ok');
      break;
    case 'warn':
      addSys('warn: ' + evt.message);
      addActivity('warn: ' + evt.message);
      break;
    case 'error':
      addSys('fault: ' + evt.message, 'err');
      addActivity(evt.message, 'err');
      setState('FAULT', 'fault');
      hud.fault = 1;
      break;
    case 'pool':
      if (evt.action === 'load-done') addActivity(`${evt.label} resident in ${evt.seconds}s`, 'ok');
      else if (evt.action === 'evict') addActivity(`eject ${evt.key}`);
      else if (evt.action === 'load-start') addActivity(`spin-up ${evt.label}â€¦`);
      else if (evt.action === 'reaped') addActivity(`reap ${evt.keys.join(', ')}`);
      else if (evt.action === 'load-error') addActivity(`spin-up failed: ${evt.error}`, 'err');
      refreshPool();
      break;
    case 'todos':
      addTodos(evt.items || []);
      break;
    case 'capabilities':
      addActivity(`surface: ${evt.servers} mcp servers · ${evt.nativeTools} native tools · ${evt.skills} skills`);
      break;
    case 'cap-log':
      addActivity(evt.message);
      if (/ready|tools/i.test(evt.message || '')) refreshCaps();
      break;
    case 'system':
      applySystemState(evt.on);
      break;
    case 'workspace':
      $('wsBtn').textContent = evt.path;
      $('wsBtn').title = evt.path;
      refreshFiles();
      break;
  }
});

// =================================================================== HUD canvas
const hud = { energy: 0.16, target: 0.16, pulse: 0, fault: 0, t: 0 };
const canvas = $('hud');
const ctx = canvas.getContext('2d');
let cw = 0, ch = 0, cx = 0, cy = 0;

function resizeHud() {
  const dpr = window.devicePixelRatio || 1;
  cw = window.innerWidth;
  ch = window.innerHeight;
  canvas.width = Math.floor(cw * dpr);
  canvas.height = Math.floor(ch * dpr);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx = cw / 2;
  cy = ch * 0.46;
}

function ring(r, from, to, width, alpha, color) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, from, to);
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function frame(now) {
  const t = now / 1000;
  hud.t = t;
  hud.energy += (hud.target - hud.energy) * 0.045;
  hud.pulse *= 0.94;
  hud.fault *= 0.965;

  ctx.clearRect(0, 0, cw, ch);

  const R = Math.min(cw, ch) * 0.33;
  const e = hud.energy;
  const hot = hud.fault > 0.05;
  const base = hot ? '255, 95, 86' : '69, 230, 255';

  // core halo
  const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 1.35);
  g.addColorStop(0, `rgba(${base}, ${0.10 + e * 0.16})`);
  g.addColorStop(0.45, `rgba(${base}, ${0.035 + e * 0.05})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);

  // crosshair
  ctx.globalAlpha = 0.10 + e * 0.10;
  ctx.strokeStyle = `rgb(${base})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - R * 1.5, cy); ctx.lineTo(cx - R * 0.35, cy);
  ctx.moveTo(cx + R * 0.35, cy); ctx.lineTo(cx + R * 1.5, cy);
  ctx.moveTo(cx, cy - R * 1.5); ctx.lineTo(cx, cy - R * 0.35);
  ctx.moveTo(cx, cy + R * 0.35); ctx.lineTo(cx, cy + R * 1.5);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // outer dashed ring
  ctx.setLineDash([2, 9]);
  ring(R * 1.22, t * 0.10, t * 0.10 + Math.PI * 2, 1, 0.30, `rgb(${base})`);
  ctx.setLineDash([]);

  // ticks
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2 + t * 0.05;
    const long = i % 8 === 0;
    const r1 = R * 1.10;
    const r2 = r1 + (long ? 9 : 4);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.strokeStyle = `rgb(${base})`;
    ctx.globalAlpha = long ? 0.30 + e * 0.25 : 0.10;
    ctx.lineWidth = long ? 1.2 : 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // rotating arcs
  ring(R * 0.96, -t * 0.55, -t * 0.55 + Math.PI * 0.55, 1.6, 0.42 + e * 0.3, `rgb(${base})`);
  ring(R * 0.96, -t * 0.55 + Math.PI, -t * 0.55 + Math.PI * 1.35, 1.6, 0.25 + e * 0.2, `rgb(${base})`);
  ring(R * 0.74, t * 0.9, t * 0.9 + Math.PI * 0.3, 1.2, 0.30 + e * 0.35, `rgb(${base})`);
  ring(R * 0.74, t * 0.9 + Math.PI, t * 0.9 + Math.PI * 1.18, 1.2, 0.20, `rgb(${base})`);

  // inner pulsing ring
  const pr = R * 0.30 + Math.sin(t * 2.1) * 4 + e * 6;
  ring(pr, 0, Math.PI * 2, 1, 0.35 + e * 0.3, `rgb(${base})`);
  ring(pr * 0.72, 0, Math.PI * 2, 1, 0.18, `rgb(${base})`);

  // core
  const coreR = 7 + e * 7 + hud.pulse * 10;
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
  cg.addColorStop(0, 'rgba(255,255,255,0.95)');
  cg.addColorStop(0.35, `rgba(${base},0.85)`);
  cg.addColorStop(1, `rgba(${base},0)`);
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 3, 0, Math.PI * 2);
  ctx.fill();

  // orbiting nodes
  for (let i = 0; i < 3; i++) {
    const a = t * (0.5 + i * 0.22) + (i * Math.PI * 2) / 3;
    const rr = R * (0.86 + i * 0.12);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    ctx.beginPath();
    ctx.arc(x, y, 1.8 + e * 1.6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${base}, ${0.55 + e * 0.4})`;
    ctx.fill();
  }

  requestAnimationFrame(frame);
}

// =================================================================== clock
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// =================================================================== system switch
function applySystemState(on) {
  const b = $('sysBtn');
  b.textContent = 'SYSTEM ACCESS · ' + (on ? 'ON' : 'OFF');
  b.className = 'sys-toggle ' + (on ? 'on' : 'off');
  hud.target = on ? 0.28 : 0.16;
}

function wireSystemButton() {
  $('sysBtn').addEventListener('click', async () => {
    const on = !$('sysBtn').classList.contains('on');
    if (on) {
      const ok = window.confirm(
        'FULL SYSTEM ACCESS\n\n' +
          'The agent will be able to read and write any file on this machine, ' +
          'run any command outside the workspace, and launch applications.\n\n' +
          'Destructive operations (format, diskpart, registry wipe) stay blocked.\n\n' +
          'Enable?'
      );
      if (!ok) return;
    }
    const res = await window.nexus.systemSet(on);
    applySystemState(res.systemAccess);
    addSys(
      on
        ? 'system access ARMED â€” the agent can now reach the whole machine'
        : 'system access disarmed â€” back to workspace sandbox'
    );
    addActivity(on ? 'system access armed' : 'system access disarmed', on ? '' : 'ok');
  });
}

// =================================================================== boot
const BOOT_LINES = [
  'NEXUS · LOCAL NEURAL CORE · MARK IV',
  '> registry ...................... 6 model cores indexed',
  '> lm studio @ 127.0.0.1:1234 ....',
  '> vram governor ................. armed (1 resident, hot-swap)',
  '> builtin toolchain ............. fs · shell · glob · grep · web · patch · todos · task',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bootSequence(info) {
  const log = $('bootLog');
  for (const line of BOOT_LINES) {
    log.textContent += line + '\n';
    await sleep(105);
  }
  const cap = info.capabilities;
  if (cap) {
    log.textContent += `> inherited mcp ................. ${cap.servers.length} servers\n`;
    await sleep(90);
    log.textContent += `> inherited skills .............. ${cap.skills}\n`;
    await sleep(90);
    log.textContent += `> live tools .................... ${cap.toolCount} reached\n`;
    await sleep(90);
  }
  log.textContent += info.serverUp
    ? `> link established .............. ${info.models.length} models visible\nNEXUS ONLINE.`
    : '> LINK FAILED â€” start LM Studio: lms server start\nNEXUS DEGRADED.';
  log.textContent += '\n';
  await sleep(480);
  $('boot').classList.add('done');
}

// =================================================================== init
async function boot() {
  resizeHud();
  requestAnimationFrame(frame);
  window.addEventListener('resize', resizeHud);
  tickClock();
  setInterval(tickClock, 1000);
  wireSystemButton();

  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  }

  const info = await window.nexus.init();
  $('wsBtn').textContent = info.workspace;
  $('wsBtn').title = info.workspace;
  renderPool({ ...info.pool, serverUp: info.serverUp });
  applySystemState(!!info.systemAccess);
  if (info.capabilities) renderCapabilities(info.capabilities);
  for (const message of (info.history || []).slice(-100)) {
    if (message.role === 'user') addUser(message.content);
    else if (message.role === 'assistant') addAssistant(message.content);
  }

  if (!info.serverUp) {
    addSys('LM Studio is not answering on 127.0.0.1:1234 â€” run: lms server start', 'err');
    setState('LINK DOWN', 'fault');
  } else {
    addActivity(`${info.models.length} cores visible · link up`, 'ok');
    setState('STANDBY');
  }

  refreshFiles();
  refreshCaps();
  bootSequence(info).catch(() => $('boot').classList.add('done'));
  // safety: never let the boot overlay trap the UI
  setTimeout(() => $('boot').classList.add('done'), 6000);
}

$('wsBtn').addEventListener('click', async () => {
  if (busy) { addActivity('Wait for the current run before changing workspace.'); return; }
  const previous = $('wsBtn').title;
  const p = await window.nexus.chooseWorkspace();
  $('wsBtn').textContent = p;
  $('wsBtn').title = p;
  if (p !== previous) {
    transcript.replaceChildren();
    try {
      for (const message of (await window.nexus.historyList()).slice(-100)) {
        if (message.role === 'user') addUser(message.content);
        else if (message.role === 'assistant') addAssistant(message.content);
      }
    } catch (e) { addSys('Could not load conversation history: ' + e.message, 'err'); }
  }
  refreshFiles();
});
$('refreshFiles').addEventListener('click', refreshFiles);
sendBtn.addEventListener('click', send);
$('newChatBtn').addEventListener('click', () => {
  transcript.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = '<h1>NEXUS</h1><p>local neural core · mark iv</p><p class="hint">type a request below — or drag a file in</p>';
  transcript.appendChild(empty);
  setState('ready');
});
$('clearChatBtn').addEventListener('click', async () => {
  await window.nexus.historyClear();
  transcript.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = '<h1>NEXUS</h1><p>local neural core · mark iv</p><p class="hint">chat history deleted</p>';
  transcript.appendChild(empty);
  setState('ready');
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('modeSel').addEventListener('change', () => {
  $('routeHint').textContent = 'mode: ' + $('modeSel').value;
});
$('modelSel').addEventListener('change', () => {
  const v = $('modelSel').value;
  $('routeHint').textContent = v ? 'core: ' + v : 'auto route';
});

boot();
setInterval(refreshPool, 15000);
setInterval(() => { if (activeTab === 'caps') refreshCaps(); }, 20000);

// =================================================================== emergency stop
let emergencyHalted = false;
async function toggleHalt() {
  const b = $('haltBtn');
  if (!emergencyHalted) {
    if (!window.confirm('EMERGENCY STOP\n\nKill every agent run, MCP server, automation task and purple-line work locally?\n\nNo data leaves this machine; processes are terminated.')) return;
    await window.nexus.emergencyStop();
    emergencyHalted = true;
    b.textContent = '■ HALTED — CLICK TO RESUME';
    b.classList.add('halted');
    setState('HALTED', 'fault');
    addSys('EMERGENCY STOP engaged — agents, MCP servers and automation stopped.', 'err');
    addActivity('emergency stop', 'err');
    return;
  }
  await window.nexus.systemResume();
  emergencyHalted = false;
  b.textContent = '■ STOP';
  b.classList.remove('halted');
  setState('STANDBY');
  addSys('emergency stop released. Automation remains paused until re-enabled.');
  addActivity('emergency stop released', 'ok');
}
$('haltBtn').addEventListener('click', toggleHalt);
