#!/usr/bin/env node
'use strict';

/** NEXUS CLI — interactive TUI, one-shot local agent and legacy Electron GUI. */
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ModelPool } = require('./core/pool');
const { runAgent } = require('./core/agent');
const { orchestrate, isComplex } = require('./core/orchestrator');
const { CapabilityRegistry } = require('./core/inherit');
const lm = require('./core/lmstudio');
const { tuiMode, activeSkillsInject } = require('./core/tui-runtime');

function usage() {
  console.log(`
  ◈ NEXUS — local agent workspace

  nexus                      interactive terminal UI
  nexus <prompt…>            one-shot agent request
  nexus call <prompt…>       same, explicitly
  nexus experiment status    what weight-edit tooling this machine has
  nexus experiment run <id> --approve "reason"
                             run one weight experiment (on demand only)
  nexus gui                  legacy Electron UI
  nexus help                 this reference

  Inside the TUI:
    Enter send  ·  Shift+Enter newline  ·  Tab mode  ·  / slash commands
    @file attach context  ·  !cmd local shell  ·  Ctrl+P command search
    Ctrl+N new chat  ·  Ctrl+X stop run  ·  Ctrl+C quit
    Ctrl+S twice arm SYSTEM  ·  Ctrl+S again disarm

  Workspace: current directory (override with NEXUS_WORKSPACE).
  For reduced motion set NEXUS_NO_ANIMATION=1; for plain color set NO_COLOR=1.
`);
}

async function callMode(prompt, workspace) {
  const colors = process.stderr.isTTY
    ? { dim: '\x1b[2m', cyan: '\x1b[36m', mag: '\x1b[35m', yel: '\x1b[33m', red: '\x1b[31m', grn: '\x1b[32m', rst: '\x1b[0m', b: '\x1b[1m' }
    : Object.fromEntries(['dim', 'cyan', 'mag', 'yel', 'red', 'grn', 'rst', 'b'].map((key) => [key, '']));
  const C = colors, started = Date.now();
  const emit = (evt) => {
    switch (evt.type) {
      case 'run-start': process.stderr.write(`${C.cyan}◆${C.rst} ${C.b}core${C.rst} ${evt.label} ${C.dim}· ${evt.why}${C.rst}\n`); break;
      case 'tool-call': process.stderr.write(`${C.mag}▸${C.rst} ${evt.name} ${C.dim}${JSON.stringify(evt.args).slice(0, 140)}${C.rst}\n`); break;
      case 'tool-result':
        if (/^ERROR/.test(String(evt.result))) process.stderr.write(`${C.red}✗${C.rst} ${String(evt.result).slice(0, 200)}\n`);
        break;
      case 'plan': process.stderr.write(`${C.yel}◈${C.rst} plan: ${(evt.steps || []).map((s) => s.text || s.task || s).slice(0, 8).join(' → ')}\n`); break;
      case 'warn': process.stderr.write(`${C.yel}!${C.rst} ${evt.message}\n`); break;
      case 'error': process.stderr.write(`${C.red}✗${C.rst} ${evt.message}\n`); break;
    }
  };
  if (!await lm.healthy()) {
    console.error(`${C.red}✗${C.rst} LM Studio is offline at ${lm.BASE}. Start its local server first.`);
    return 2;
  }
  const pool = new ModelPool(emit);
  const registry = new CapabilityRegistry({ workspace, onLog: () => {} });
  registry.discover();
  await pool.sync().catch(() => {});
  const inject = activeSkillsInject(registry);
  try {
    const opts = { prompt, workspace, pool, emit, systemAccess: true,
      registry, authorize: async () => true, history: [], inject };
    const result = isComplex(prompt)
      ? await orchestrate(opts)
      : await runAgent({ ...opts, checkpointRoot: path.join(workspace, '.nexus') });
    if (result.error) { console.error(`${C.red}✗${C.rst} fault: ${result.error}`); return 1; }
    process.stderr.write(`\n${C.grn}✓${C.rst} done in ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`);
    console.log(result.text || '(no output)');
    return 0;
  } catch (e) {
    console.error(`${C.red}✗${C.rst} fault: ${e.message}`);
    return 1;
  } finally {
    registry.stopAll();
  }
}

process.env.PYTHONIOENCODING ||= 'utf-8';
(async () => {
  const args = process.argv.slice(2);
  const first = (args[0] || '').toLowerCase();
  const workspace = path.resolve(process.env.NEXUS_WORKSPACE || process.cwd());
  if (!args.length) { await tuiMode(workspace); process.exit(0); }
  if (['help', '--help', '-h'].includes(first)) { usage(); return; }
  if (['version', '--version', '-v'].includes(first)) { console.log(`nexus v${require('./package.json').version}`); return; }
  if (first === 'experiment' || first === 'exp') {
    const we = require('./core/weight-edit');
    const action = (args[1] || 'status').toLowerCase();
    const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
    try {
      if (action === 'status') { console.log(JSON.stringify(await we.probe(), null, 2)); return; }
      if (action === 'list') { console.log(JSON.stringify(await we.list({ workspace }), null, 2)); return; }
      if (action === 'scaffold') {
        const made = await we.scaffold({
          workspace,
          mode: flag('mode') || 'synthetic',
          modelDir: flag('model'),
          name: flag('name') || '',
        });
        console.log(`scaffolded ${made.id}\n  ${made.dir}\nnothing was run.`);
        return;
      }
      if (action === 'run') {
        const id = args[2];
        const reason = flag('reason') || '';
        if (!flag('approve') && !args.includes('--yes')) {
          console.error('refusing: pass --approve "<reason>" — weight experiments are on demand only');
          process.exitCode = 2; return;
        }
        const out = await we.run({ workspace, id, approve: true, reason: reason || 'cli run', onLine: (l) => console.log(l) });
        console.log(JSON.stringify(out.result || out, null, 2).slice(0, 4000));
        process.exitCode = out.ok ? 0 : 1;
        return;
      }
      usage(); process.exitCode = 2;
    } catch (e) {
      console.error(`experiment: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (first === 'gui') {
    let bin = null;
    try { const e = require('electron'); bin = typeof e === 'string' ? e : null; } catch {}
    if (!bin) { console.error('electron is not installed'); process.exitCode = 2; return; }
    const child = spawn(bin, [__dirname], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => { process.exitCode = code ?? 0; });
    return;
  }
  // The orb was removed; say so instead of burning a model call on the word.
  if (first === 'orb' || first === 'headless') {
    console.error('  the orb HUD was removed. Use `nexus` for the terminal UI, or `nexus <prompt>` for one-shot.');
    process.exitCode = 2;
    return;
  }
  const prompt = first === 'call' ? args.slice(1).join(' ') : args.join(' ');
  if (!prompt.trim()) { usage(); process.exitCode = 2; return; }
  process.exitCode = await callMode(prompt.trim(), workspace);
})().catch((e) => {
  console.error(`nexus: ${e.message}`);
  process.exitCode = 2;
});
