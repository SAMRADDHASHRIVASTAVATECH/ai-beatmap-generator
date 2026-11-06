'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('original Nexus chat IPC still dispatches direct and supervisor runs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ipc-'));
  const handlers = new Map();
  const originalLoad = Module._load;
  let directOptions;
  let supervisorOptions;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          whenReady: () => new Promise(() => {}),
          on: () => {},
          getPath: () => tmp,
        },
        BrowserWindow: {},
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        dialog: {},
        shell: {},
      };
    }
    if (request === './core/agent' && parent?.filename.endsWith(`${path.sep}main.js`)) {
      return { runAgent: async (options) => { directOptions = options; return { text: 'direct' }; } };
    }
    if (request === './core/orchestrator' && parent?.filename.endsWith(`${path.sep}main.js`)) {
      return {
        isComplex: () => false,
        orchestrate: async (options) => { supervisorOptions = options; return { text: 'supervisor' }; },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require('../main');
    const send = handlers.get('chat:send');
    assert.equal(typeof send, 'function');
    assert.deepEqual(await send(null, { prompt: 'hello', mode: 'direct', runId: 'run1' }), { text: 'direct' });
    assert.equal(directOptions.prompt, 'hello');
    assert.equal(directOptions.runId, 'run1');
    assert.deepEqual(await send(null, { prompt: 'plan', mode: 'supervisor' }), { text: 'supervisor' });
    assert.equal(supervisorOptions.prompt, 'plan');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
