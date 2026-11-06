'use strict';

/**
 * Weight-space experiments — the on-demand path.
 *
 * Wraps core/weight-edit/edit_weights.py, which edits a small network's weights
 * directly and verifies the edit by measurement (no gradients, no optimizer).
 * Background: "Sparks of Weight-Space Programming", MIT CSAIL, 2 Nov 2026 —
 * a blog post, not peer-reviewed. Its "weights only" claim held on nets of
 * ~17k-172k parameters; every real-language-model experiment used code
 * execution plus batches of practice problems. This module is that second
 * thing, and it says so instead of overselling.
 *
 * Rules enforced here, not by convention:
 *   - nothing runs without approve === true AND a written reason
 *   - one experiment at a time (a lock file inside the experiment dir)
 *   - base model files are never written; outputs are delta files
 *   - every run is appended to the experiment registry with its real metrics
 *   - promotion needs a named approver and measured evidence
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ExperimentRegistry } = require('./experiments');

const PY = path.join(__dirname, 'weight-edit', 'edit_weights.py');

function registryFor(workspace) {
  return new ExperimentRegistry(path.join(path.resolve(workspace), '.nexus'));
}

function newId() {
  return `wedit_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function runPython(args, { cwd, timeoutMs = 30 * 60 * 1000, onLine = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn('python', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = String(d);
      stdout += s;
      for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line);
    });
    child.stderr.on('data', (d) => {
      const s = String(d);
      stderr += s;
      for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error: e.message, killed });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

/** Honest capability report — whatever ismissing is named, not hidden. */
async function probe() {
  const checks = [
    ['python', ['-c', 'import sys; print(sys.version.split()[0])']],
    ['torch', ['-c', 'import torch; print(torch.__version__)']],
    ['transformers', ['-c', 'import transformers; print(transformers.__version__)']],
    ['safetensors', ['-c', 'import safetensors; print(safetensors.__version__)']],
    ['unsloth', ['-c', 'import unsloth; print(unsloth.__version__)']],
  ];
  const out = {};
  await Promise.all(checks.map(async ([name, args]) => {
    const r = await runPython(args, { timeoutMs: 45000 });
    out[name] = r.code === 0 ? String(r.stdout).trim() : null;
  }));
  const missing = Object.entries(out).filter(([, v]) => !v).map(([k]) => k);
  return {
    ...out,
    // The synthetic loop needs torch only; the hf path needs all four.
    synthetic_ready: !!out.python && !!out.torch,
    hf_ready: !!(out.python && out.torch && out.transformers && out.safetensors),
    missing,
    on_demand_only: true,
  };
}

/**
 * Create an experiment directory with its config. Nothing is executed here.
 * `mode: 'synthetic'` repairs a deliberately crippled small MLP (fast, real
 * numbers). `mode: 'hf'` targets a local causal-LM directory.
 */
async function scaffold({ workspace, mode = 'synthetic', modelDir = null, name = '', config = {} } = {}) {
  if (!['synthetic', 'hf'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (mode === 'hf' && !modelDir) throw new Error('hf mode needs modelDir (a local model directory)');

  const reg = registryFor(workspace);
  const id = newId();
  const dir = path.join(reg.dir, id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const cfg = {
    id,
    mode,
    name: name || id,
    model_dir: modelDir || null,
    max_edit_fraction: Number(config.maxEditFraction) || 0.0002,
    scan_layers: Number(config.scanLayers) || 4,
    max_new_tokens: Number(config.maxNewTokens) || 48,
    prompts: Array.isArray(config.prompts) ? config.prompts : undefined,
    dim: Number(config.dim) || 64,
    hidden: Number(config.hidden) || 48,
    classes: Number(config.classes) || 6,
    init_scale: Number(config.initScale) || 0.005,
    budget_evals: Number(config.budgetEvals) || 240,
    seed: Number(config.seed) || 1234,
    base_weights_read_only: true,
    createdAt: new Date().toISOString(),
  };
  const cfgPath = path.join(dir, 'edit.json');
  await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  await reg.record({
    id,
    kind: 'weight',
    baseModel: modelDir || 'synthetic-mlp',
    description: `weight edit (${mode}) — ${cfg.name}`,
    status: 'proposed',
    notes: `experiment dir ${dir}`,
  });

  return { id, dir, config: cfg };
}

/** Run an experiment. Refuses unless explicitly approved with a reason. */
async function run({ workspace, id, approve = false, reason = '', timeoutMs = 30 * 60 * 1000, onLine = () => {} } = {}) {
  if (approve !== true) {
    return { ok: false, refused: true, error: 'experiments are on demand only: pass approve:true and a reason' };
  }
  if (!String(reason).trim()) {
    return { ok: false, refused: true, error: 'a written reason is required to run an experiment' };
  }
  if (!id) return { ok: false, error: 'id required' };

  const reg = registryFor(workspace);
  const dir = path.join(reg.dir, id);
  const cfgPath = path.join(dir, 'edit.json');
  if (!fs.existsSync(cfgPath)) return { ok: false, error: `no experiment ${id}` };

  const lock = path.join(dir, '.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch { return { ok: false, error: 'this experiment is already running' }; }

  const logPath = path.join(dir, 'run.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const tee = (line) => { logStream.write(line + '\n'); onLine(line); };

  try {
    const started = Date.now();
    tee(`=== run ${new Date().toISOString()} by reason: ${reason}`);
    const r = await runPython([PY, '--config', cfgPath], { cwd: dir, timeoutMs, onLine: tee });

    const resultLine = String(r.stdout).split(/\r?\n/).filter((l) => l.startsWith('RESULT ')).pop();
    let result = null;
    if (resultLine) {
      try { result = JSON.parse(resultLine.slice(7)); } catch {}
    }
    const ok = r.code === 0 && !!result;

    await reg.record({
      id: `${id}__run_${Date.now().toString(36)}`,
      kind: 'weight',
      baseModel: 'see edit.json',
      description: `run of ${id}`,
      status: ok && result.ok ? 'verified' : 'rejected',
      scores: result && result.after ? { val: result.after.val ?? result.after.repetition } : null,
      baselineScores: result && result.before ? { val: result.before.val ?? result.before.repetition } : null,
      notes: JSON.stringify({
        reason,
        seconds: result ? result.seconds : null,
        error: result ? result.error : (r.killed ? 'timeout' : String(r.stderr).slice(-400)),
        params_touched: result ? result.params_touched : null,
        fraction_touched: result ? result.fraction_touched : null,
      }),
    });

    tee(`=== done in ${Math.round((Date.now() - started) / 100) / 10}s ok=${ok}`);
    return {
      ok,
      id,
      dir,
      log: logPath,
      seconds: result ? result.seconds : null,
      result,
      error: ok ? null : (r.killed ? 'timed out' : String(r.stderr).trim().split('\n').pop() || 'no result'),
    };
  } finally {
    logStream.end();
    try { fs.unlinkSync(lock); } catch {}
  }
}

async function list({ workspace } = {}) {
  const reg = registryFor(workspace);
  const all = await reg.list({ kind: 'weight' });
  return all;
}

async function promote({ workspace, id, approvedBy, reason = '' } = {}) {
  if (!approvedBy) throw new Error('promotion requires an explicit approver name');
  const reg = registryFor(workspace);
  return reg.promote(id, { approvedBy, reason });
}

module.exports = { probe, scaffold, run, list, promote, registryFor };
