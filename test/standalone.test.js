'use strict';

// End-to-end exercise of the existing Nexus agent and pool, with a fake local
// LM Studio server and a clean HOME that has never had OpenCode installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repo = path.join(__dirname, '..');

test('Nexus agent works without an OpenCode install using local model API', { timeout: 30000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-standalone-'));
  const workspace = path.join(temp, 'workspace');
  await fs.mkdir(workspace);
  let loaded = false;
  let completions = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const send = (body, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/api/v1/models') {
        return send({ models: [{ key: 'qwen3-4b-instruct-2507', loaded_instances: loaded ? [{ id: 'mock-instance' }] : [] }] });
      }
      if (req.method === 'POST' && req.url === '/api/v1/models/load') {
        loaded = true;
        return send({ instance_id: 'mock-instance' });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.model, 'qwen3-4b-instruct-2507');
        completions++;
        if (completions === 1) {
          return send({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'nexus standalone' }) } }] } }] });
        }
        return send({ choices: [{ message: { role: 'assistant', content: 'Created hello.txt.' } }] });
      }
      return send({ error: 'not found' }, 404);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const script = `
      const { ModelPool } = require('./core/pool');
      const { runAgent } = require('./core/agent');
      const { CapabilityRegistry } = require('./core/inherit');
      const registry = new CapabilityRegistry({ workspace: process.env.TEST_WORKSPACE });
      registry.discover();
      const pool = new ModelPool();
      runAgent({ prompt: 'Create a file', modelKey: 'coder', workspace: process.env.TEST_WORKSPACE,
        pool, registry, emit: () => {}, authorize: async () => true }).then(result => {
          if (result.error || result.text !== 'Created hello.txt.') throw new Error(JSON.stringify(result));
          if (registry.status().servers.length !== 0) throw new Error('unexpected MCP configuration');
          console.log('standalone agent passed');
        }).catch(err => { console.error(err); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: temp,
        USERPROFILE: temp,
        TEST_WORKSPACE: workspace,
        LMSTUDIO_BASE: `http://127.0.0.1:${server.address().port}`,
        NEXUS_SKILL_PATHS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, output);
    assert.match(output, /standalone agent passed/);
    assert.equal(completions, 2);
    assert.equal(await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8'), 'nexus standalone');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
