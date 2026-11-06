'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const { ModelPool } = require('./core/pool');
const { runAgent } = require('./core/agent');
const { orchestrate, isComplex } = require('./core/orchestrator');
const { CapabilityRegistry } = require('./core/inherit');
const { ConversationStore, recentHistory } = require('./core/conversations');
const lm = require('./core/lmstudio');
const { snapshot: resourcesSnapshot } = require('./core/resources');
const { buildManifest } = require('./core/capability-manifest');
const { AutomationBus } = require('./core/automation');
const { PurpleLine } = require('./core/purple-line');

let win = null;
let workspace = '';
let systemAccess = true;
let conversations;
let halted = false;
const interrupts = new Map();
let automation = null;
function conversationStore() {
  if (!conversations) conversations = new ConversationStore(app.getPath('userData'));
  return conversations;
}
const pool = new ModelPool((evt) => send('agent:event', evt));

const registry = new CapabilityRegistry({
  onLog: (msg) => {
    console.log('[cap]', msg);
    send('agent:event', { type: 'cap-log', message: msg });
  },
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function authorizeTool({ name, args }) {
  if (!win || win.isDestroyed()) return false;
  let detail;
  try { detail = JSON.stringify(args || {}, null, 2); } catch { return false; }
  // Do not approve an opaque command or MCP request whose decisive arguments
  // cannot be shown in the confirmation dialog.
  if (detail.length > 4000 && (name === 'run_command' || /^mcp/i.test(name))) return false;
  if (detail.length > 4000) detail = detail.slice(0, 4000) + '\n… (arguments truncated; approval applies to the full action)';
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Deny', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Nexus action approval',
    message: `Allow ${name}?`,
    detail: `${detail}\n\nThis action may modify files, run programs, or access external services. Allow only if you trust it.`,
  });
  return result.response === 1;
}

async function ensureWorkspace() {
  if (workspace) return workspace;
  const def = path.join(app.getPath('documents'), 'NexusWorkspace');
  await fs.mkdir(def, { recursive: true });
  workspace = def;
  return workspace;
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(__dirname, 'assets', 'nexus-symbol.png'),
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'Nexus',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Surface renderer faults on the terminal — otherwise they are invisible.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message}  (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', JSON.stringify(details));
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[load failed]', code, desc);
  });
}

app.whenReady().then(async () => {
  // Headless-friendly smoke mode: load the UI, capture a screenshot, verify the
  // brand renders, exit 0/1. Used by `npm run smoke` to prove the desktop app boots.
  const smoke = process.env.NEXUS_SMOKE === '1';
  if (smoke) {
    app.whenReady().then(() => {
      // createWindow runs below; attach the smoke hook once the window exists
      const attach = () => {
        if (!win) return setTimeout(attach, 200);
        win.webContents.once('did-finish-load', () => {
          setTimeout(async () => {
            let code = 1;
            try {
              try { win.show(); win.focus(); } catch {}
              let img = null;
              if (typeof win.webContents.takeScreenshot === 'function') {
                img = await win.webContents.takeScreenshot();
              }
              if (!img || img.isEmpty()) {
                img = await win.webContents.capturePage();
              }
              const png = img.toPNG();
              const out = path.join(app.getPath('userData'), 'smoke.png');
              await fs.writeFile(out, png);
              console.log(`[smoke] pngBytes=${png.length}`);
              const title = await win.webContents.executeJavaScript('document.title');
              const marker = await win.webContents.executeJavaScript("document.querySelector('.brand-name') ? 'brand-ok' : 'missing'");
              console.log(`[smoke] title=${title} marker=${marker} png=${out}`);
              code = (title === 'NEXUS' && marker === 'brand-ok') ? 0 : 1;
            } catch (e) {
              console.error('[smoke] failed:', e && e.message);
            }
            app.exit(code);
          }, 2500);
        });
      };
      attach();
    });
  }
  automation = new AutomationBus({
    dataDir: path.join(app.getPath('userData'), 'automation-data'),
    onEvent: (evt) => send('agent:event', evt),
  });
  try { await automation.load(); } catch (e) { console.error('[automation] load failed:', e.message); }
  await ensureWorkspace();
  createWindow();

  // TTL reaper: evict idle specialists so VRAM frees up on its own.
  setInterval(() => {
    pool.reap().then((gone) => {
      if (gone.length) send('agent:event', { type: 'pool', action: 'reaped', keys: gone });
    }).catch((error) => send('agent:event', { type: 'warn', message: `Idle-model cleanup failed: ${error.message}` }));
  }, 60_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- IPC
ipcMain.handle('app:init', async () => {
  const ws = await ensureWorkspace();
  let models = [];
  let up = false;
  try {
    models = await lm.listModels();
    up = true;
    await pool.sync();
  } catch {}

  // Discover inherited capabilities without starting programs or network connections.
  registry.workspace = ws;
  try {
    registry.discover();
  } catch (e) {
    console.error('[cap] discover failed:', e.message);
  }

  return {
    workspace: ws,
    serverUp: up,
    systemAccess,
    models: models.map((m) => ({ key: m.key, type: m.type, params: m.params_string, ctx: m.max_context_length })),
    pool: await pool.status(),
    capabilities: registry.status(),
    history: await conversationStore().read(ws).catch(() => []),
  };
});

ipcMain.handle('workspace:choose', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (!res.canceled && res.filePaths[0]) {
    workspace = res.filePaths[0];
    pool.idCache.clear();
    registry.workspace = workspace;
    registry.discover();
    send('agent:event', { type: 'workspace', path: workspace });
  }
  return workspace;
});

ipcMain.handle('history:list', async () => conversationStore().read(await ensureWorkspace()));
ipcMain.handle('history:clear', async () => { await conversationStore().clear(await ensureWorkspace()); return { ok: true }; });

ipcMain.handle('workspace:open', async () => {
  await shell.openPath(workspace);
  return true;
});

ipcMain.handle('pool:status', async () => {
  await pool.sync();
  return { ...(await pool.status()), serverUp: await lm.healthy() };
});

ipcMain.handle('system:state', async () => ({ systemAccess }));

ipcMain.handle('mcp:status', async () => registry.status());

ipcMain.handle('mcp:inspect', async (_e, server) => {
  const current = registry.servers.get(server);
  if ((!current || current.state !== 'ready') && !(await authorizeTool({ name: 'start MCP server', args: { server } }))) {
    throw new Error('MCP server start not approved');
  }
  const tools = await registry.inspect(server);
  return { server, tools };
});

ipcMain.handle('mcp:call', async (_e, { server, tool, args }) => {
  if (!(await authorizeTool({ name: 'MCP tool', args: { server, tool, args } }))) throw new Error('MCP tool call not approved');
  const out = await registry.callRaw(server, tool, args || {});
  return { server, tool, result: String(out).slice(0, 20_000) };
});

ipcMain.handle('mcp:start', async (_e, server) => {
  if (!(await authorizeTool({ name: 'start MCP server', args: { server } }))) throw new Error('MCP server start not approved');
  await registry.ensure(server);
  return registry.status();
});

ipcMain.handle('skill:list', async () => (registry.skills || []).map((s) => ({ id: s.id, name: s.name, description: s.description })));

ipcMain.handle('skill:read', async (_e, id) => {
  const hit = (registry.skills || []).find((s) => s.id === id || s.name === id);
  if (!hit) return { error: `no skill "${id}"` };
  return { id: hit.id, name: hit.name, text: await fs.readFile(hit.file, 'utf8') };
});

ipcMain.handle('system:set', async (_e, on) => {
  systemAccess = !!on;
  send('agent:event', { type: 'system', on: systemAccess });
  return { systemAccess };
});

ipcMain.handle('pool:load', async (_e, key) => {
  await pool.load(key);
  return pool.status();
});

ipcMain.handle('pool:unload', async (_e, key) => {
  await pool.unload(key);
  return pool.status();
});

ipcMain.handle('system:halt', async () => {
  halted = true;
  interrupts.clear();
  try { registry.stopAll(); } catch {}
  if (automation) await automation.pause();
  send('agent:event', { type: 'halt', message: 'emergency stop' });
  return { halted: true };
});

ipcMain.handle('system:resume', async () => {
  halted = false;
  return { halted: false };
});

ipcMain.handle('chat:cancel', async (_e, runId) => {
  if (runId) interrupts.set(String(runId), true);
  return { ok: true };
});

ipcMain.handle('resources:snapshot', async () => resourcesSnapshot());

ipcMain.handle('capabilities:build', async () => {
  const ws = await ensureWorkspace();
  const { manifest, file } = await buildManifest({ workspace: ws, measure: false });
  return { file, servers: manifest.servers.length, skills: manifest.skills.length, measured: manifest.measured };
});

ipcMain.handle('purple:run', async (_e, goal) => {
  const ws = await ensureWorkspace();
  const line = new PurpleLine({
    dataDir: path.join(app.getPath('userData'), 'purple'),
    repoRoot: ws,
    onEvent: (evt) => send('agent:event', { type: 'purple', ...evt }),
  });
  return line.cycleOnce({ goal: String(goal || 'make the test suite pass') });
});

ipcMain.handle('automation:list', async () => (automation ? automation.list() : []));
ipcMain.handle('automation:pause', async () => (automation ? automation.pause() : false));
ipcMain.handle('automation:resume', async () => (automation ? automation.resume() : false));

ipcMain.handle('chat:send', async (_e, { prompt, modelKey, runId, mode }) => {
  if (!prompt || !prompt.trim()) return { error: 'empty prompt' };
  if (halted) return { error: 'emergency stop engaged — release it (STOP button) before running again' };
  const emit = (evt) => send('agent:event', evt);
  const ws = await ensureWorkspace();
  try {
    const store = conversationStore();
    const saved = await store.read(ws).catch((error) => {
      emit({ type: 'warn', message: `Could not read local conversation history: ${error.message}` });
      return [];
    });
    const history = recentHistory(saved);
    await store.append(ws, 'user', prompt).catch((error) => {
      emit({ type: 'warn', message: `Could not save local conversation: ${error.message}` });
    });
    // supervisor = one AI directing the others; direct = single agent
    const useSupervisor = mode === 'supervisor' || (mode !== 'direct' && isComplex(prompt) && !modelKey);

    const result = useSupervisor
      ? await orchestrate({ prompt, workspace: ws, pool, emit, systemAccess, registry, authorize: authorizeTool, history })
      : await runAgent({ prompt, modelKey: modelKey || undefined, workspace: ws, pool, emit, runId, systemAccess, registry, authorize: authorizeTool, history, shouldAbort: () => interrupts.get(runId) === true });
    interrupts.delete(runId);
    if (!result.error && !result.truncated && result.text) {
      await store.append(ws, 'assistant', result.text).catch((error) => {
        emit({ type: 'warn', message: `Could not save local response: ${error.message}` });
      });
    }
    return result;
  } catch (e) {
    emit({ type: 'error', message: e.message, runId });
    return { error: e.message };
  }
});

ipcMain.handle('file:list', async () => {
  const { executeTool } = require('./core/tools');
  return executeTool('list_dir', { path: '.' }, { workspace: await ensureWorkspace() });
});

ipcMain.handle('file:read', async (_e, p) => {
  const { executeTool } = require('./core/tools');
  return executeTool('read_file', { path: p, limit: 800 }, { workspace: await ensureWorkspace() });
});
