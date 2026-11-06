'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { assertLocalBase } = require('../core/lmstudio');

test('accepts only loopback model endpoints', () => {
  for (const url of ['http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234']) {
    assert.doesNotThrow(() => assertLocalBase(url), url);
  }
  for (const url of [
    'https://api.example.com',
    'http://192.168.1.2:1234',
    'http://localhost.example.com',
    'http://127.0.0.1@api.example.com',
    'http://user:pass@localhost:1234',
    'http://localhost:1234/api',
    'file:///tmp/test',
    'not a url',
  ]) {
    assert.throws(() => assertLocalBase(url), /LMSTUDIO_BASE/, url);
  }
});

test('refuses a nonlocal endpoint before calling fetch', () => {
  const script = `
    global.fetch = () => { throw new Error('fetch must not be called'); };
    require('./core/lmstudio').listModels().then(
      () => { process.exitCode = 1; },
      err => { if (!/LMSTUDIO_BASE/.test(err.message)) process.exitCode = 2; }
    );`;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, LMSTUDIO_BASE: 'https://api.example.com' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
});

test('local requests do not follow redirects', async () => {
  const previous = global.fetch;
  let options;
  global.fetch = async (_url, opts) => {
    options = opts;
    return { ok: true, text: async () => '{"models":[]}' };
  };
  try {
    const { listModels } = require('../core/lmstudio');
    assert.deepEqual(await listModels(), []);
    assert.equal(options.redirect, 'error');
  } finally {
    global.fetch = previous;
  }
});
