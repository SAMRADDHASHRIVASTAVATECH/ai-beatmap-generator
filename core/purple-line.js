'use strict';

/**
 * Purple-line autonomous engineering cycle.
 *
 *   PLAN -> IMPLEMENT -> BUILD -> RUN -> OBSERVE -> DIAGNOSE -> FIX -> TEST -> VERIFY
 *
 * Runs independently of the main app: given a repo, it tests, diagnoses
 * failures, proposes a fix (or applies one inside an isolated git worktree on
 * its own branch), re-tests, and either keeps the worktree for review or
 * removes it and records the attempt. An emergency halt file stops the cycle
 * between every step.
 *
 * `agentFn` performs the actual editing. Default: propose-only (writes
 * proposal.md, changes nothing). Pass agentFn (e.g. wired to runAgent with a
 * local model) to let it implement fixes. Tests inject a fake agentFn.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const FIX_FILE = '.purple-halt';   // create this file to stop all autonomous work

function defaultExec(cmd, args, opts = {}) {
  const isWinScript = process.platform === 'win32' && /^(npm|npx)$/.test(cmd);
  const real = isWinScript ? cmd + '.cmd' : cmd;
  const base = { windowsHide: true, timeout: 600000, shell: isWinScript };
  return new Promise((resolve) => {
    execFile(real, args, { ...base, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0, stdout, stderr, error: err ? String(err.message || err) : null });
    });
  });
}

async function pathExists(p) { try { await fs.access(p); return true; } catch { return false; } }

class PurpleLine {
  constructor({ dataDir, repoRoot, execFn = null, agentFn = null, onEvent = () => {} } = {}) {
    this.dataDir = dataDir;
    this.repoRoot = path.resolve(repoRoot);
    this.exec = execFn || defaultExec;
    this.agentFn = agentFn;               // ({ repo, failure, goal }) => { ok, summary }
    this.onEvent = onEvent;
    this.haltFile = path.join(dataDir, FIX_FILE);
    this.issuesFile = path.join(dataDir, 'purple-issues.jsonl');
  }

  async halted() { return pathExists(this.haltFile); }

  async halt() {
    await fs.mkdir(path.dirname(this.haltFile), { recursive: true });
    await fs.writeFile(this.haltFile, new Date().toISOString());
    return true;
  }

  async clearHalt() { await fs.rm(this.haltFile, { force: true }); return true; }

  async recordIssue(entry) {
    await fs.mkdir(path.dirname(this.issuesFile), { recursive: true });
    await fs.appendFile(this.issuesFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  }

  async runTests(cwd) {
    const r = await this.exec('npm', ['test'], { cwd });
    return { ok: r.code === 0, code: r.code, output: String(r.stdout || '') + String(r.stderr || '') };
  }

  async git(args, cwd) {
    return this.exec('git', args, { cwd: cwd || this.repoRoot });
  }

  /**
   * One autonomous pass. Never touches the main worktree: all edits happen in
   * an isolated worktree on a purple/<id> branch.
   */
  async cycleOnce({ goal = 'make the test suite pass' } = {}) {
    if (await this.halted()) return { status: 'halted', reason: 'emergency halt file present' };

    // --- OBSERVE: what is broken right now?
    this.onEvent({ step: 'OBSERVE', repo: this.repoRoot });
    const before = await this.runTests(this.repoRoot);
    if (before.ok) {
      await this.recordIssue({ status: 'no-issue', goal, evidence: 'test suite green at start' });
      return { status: 'idle', reason: 'no worthwhile task: suite is green', tests: before };
    }
    const failure = before.output;
    this.onEvent({ step: 'DIAGNOSE', failurePreview: failure.slice(-2000) });

    // --- Back up state: clean git worktree on its own branch
    const id = `purple${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const wt = path.join(this.dataDir, 'worktrees', id);
    const branch = `purple/${id}`;
    const isGit = (await this.git(['rev-parse', '--is-inside-work-tree'])).code === 0;
    if (!isGit) return { status: 'refused', reason: 'repository is not a git worktree; refusing autonomous changes' };
    const add = await this.git(['worktree', 'add', '-b', branch, wt, 'HEAD']);
    if (add.code !== 0) return { status: 'refused', reason: `worktree creation failed: ${String(add.stderr || add.error).slice(0, 300)}` };

    // --- IMPLEMENT (agent) inside the worktree only
    let agentResult = { ok: true, summary: 'propose-only mode: no changes applied' };
    if (this.agentFn) {
      try {
        agentResult = await this.agentFn({ repo: wt, failure, goal });
      } catch (e) {
        agentResult = { ok: false, summary: `agent threw: ${String(e.message || e).slice(0, 300)}` };
      }
    } else {
      const proposal = [
        '# Purple-line proposal',
        `Goal: ${goal}`,
        '',
        '## Failing output (tail)',
        '```',
        failure.slice(-4000),
        '```',
        '',
        '## Suggested next steps',
        '- Reproduce locally: npm test',
        '- Identify the first failing assertion in the output above',
        '- Patch minimally, re-run npm test, keep the diff small',
      ].join('\n');
      await fs.writeFile(path.join(wt, 'purple-proposal.md'), proposal, 'utf8');
      await this.recordIssue({ status: 'proposed', goal, branch, worktree: wt,
        evidence: 'propose-only mode: diagnosis written to purple-proposal.md; no code changed' });
      return { status: 'proposed', id, branch, worktree: wt, proposal: path.join(wt, 'purple-proposal.md') };
    }
    if (await this.halted()) {
      await this.git(['worktree', 'remove', '--force', wt]);
      return { status: 'halted', reason: 'halt requested mid-cycle; worktree removed', id };
    }

    // --- TEST inside the worktree
    const after = await this.runTests(wt);
    if (after.ok) {
      await this.recordIssue({ status: 'proposed-green', goal, branch, worktree: wt, agent: agentResult.summary, evidence: 'tests green inside purple worktree' });
      return { status: 'done', id, branch, worktree: wt, agent: agentResult, tests: after };
    }

    // --- Rollback: discard the worktree, never touch main
    await this.git(['worktree', 'remove', '--force', wt]);
    await this.recordIssue({ status: 'rejected', goal, branch, evidence: 'tests still red inside worktree; rolled back', agent: agentResult.summary });
    return { status: 'rejected', id, branch, agent: agentResult, tests: after };
  }

  /** Repeat up to maxCycles times, stopping early on halt or idle. */
  async cycle({ goal, maxCycles = 1 } = {}) {
    const results = [];
    for (let i = 0; i < maxCycles; i++) {
      const r = await this.cycleOnce({ goal });
      results.push(r);
      if (r.status === 'idle' || r.status === 'halted' || r.status === 'refused') break;
      if (r.status === 'done') break; // one green fix per cycle is enough
    }
    return results;
  }
}

module.exports = { PurpleLine, FIX_FILE };
