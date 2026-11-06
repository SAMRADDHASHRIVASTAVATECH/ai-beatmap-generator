'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { executeTool } = require('../core/tools');

test('run_command executes a shell command inside the workspace', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-shell-'));
  try {
    const command = process.platform === 'win32' ? 'echo nexus-shell-test' : "printf 'nexus-shell-test'";
    const output = await executeTool('run_command', { command }, { workspace: dir, systemAccess: false });
    assert.equal(output.trim(), 'nexus-shell-test');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
