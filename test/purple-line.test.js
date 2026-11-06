const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { PurpleLine } = require('../core/purple-line');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-purple-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'purple@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Purple Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'test.js'), `const fs=require('fs');\nconst v = fs.existsSync('status.txt') ? fs.readFileSync('status.txt','utf8').trim() : '';\nif (v === 'ok') { console.log('pass'); process.exit(0); } else { console.error('fail: status.txt != ok'); process.exit(1); }\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
  return dir;
}

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-purple-data-'));

test('cycle detects failing suite and proposes without touching main when no agent is configured', async () => {
  const repo = makeRepo();
  const line = new PurpleLine({ dataDir: dataDir(), repoRoot: repo });
  const r = await line.cycleOnce({ goal: 'make the suite green' });
  assert.strictEqual(r.status, 'proposed', JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(r.worktree, 'purple-proposal.md')), 'proposal written in the worktree');
  assert.ok(!fs.existsSync(path.join(repo, 'status.txt')), 'main repo untouched');
});

test('fix lands in isolated worktree; main stays untouched; issue recorded', async () => {
  const repo = makeRepo();
  const data = dataDir();
  const line = new PurpleLine({
    dataDir: data,
    repoRoot: repo,
    agentFn: async ({ repo: wt }) => {
      fs.writeFileSync(path.join(wt, 'status.txt'), 'ok\n');
      return { ok: true, summary: 'wrote status.txt=ok' };
    },
  });
  const r = await line.cycleOnce({ goal: 'make the suite green' });
  assert.strictEqual(r.status, 'done', JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(r.worktree, 'status.txt')), 'worktree contains the fix');
  assert.ok(!fs.existsSync(path.join(repo, 'status.txt')), 'main repo untouched');
  const issues = fs.readFileSync(path.join(data, 'purple-issues.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(issues.length, 1);
  assert.match(issues[0], /proposed-green/);
});

test('failed fix is rolled back and recorded as rejected', async () => {
  const repo = makeRepo();
  const data = dataDir();
  const line = new PurpleLine({
    dataDir: data,
    repoRoot: repo,
    agentFn: async ({ repo: wt }) => {
      fs.writeFileSync(path.join(wt, 'status.txt'), 'wrong\n');
      return { ok: true, summary: 'tried but wrong' };
    },
  });
  const r = await line.cycleOnce({ goal: 'make the suite green' });
  assert.strictEqual(r.status, 'rejected', JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(repo, 'status.txt')), 'main repo untouched');
  const dir = path.join(data, 'worktrees');
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.strictEqual(leftovers.length, 0, 'worktree removed after rollback');
});

test('halt file stops the cycle before any change', async () => {
  const repo = makeRepo();
  const data = dataDir();
  const line = new PurpleLine({ dataDir: data, repoRoot: repo });
  await line.halt();
  const r = await line.cycleOnce({ goal: 'anything' });
  assert.strictEqual(r.status, 'halted');
  await line.clearHalt();
  assert.strictEqual(await line.halted(), false);
});

test('green suite reports idle with zero edits', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'status.txt'), 'ok\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'make green'], { cwd: repo });
  const line = new PurpleLine({ dataDir: dataDir(), repoRoot: repo });
  const r = await line.cycleOnce({ goal: 'anything' });
  assert.strictEqual(r.status, 'idle');
});
