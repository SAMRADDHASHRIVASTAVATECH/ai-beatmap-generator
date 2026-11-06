'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  init: () => ipcRenderer.invoke('app:init'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyClear: () => ipcRenderer.invoke('history:clear'),

  poolStatus: () => ipcRenderer.invoke('pool:status'),
  poolLoad: (key) => ipcRenderer.invoke('pool:load', key),
  poolUnload: (key) => ipcRenderer.invoke('pool:unload', key),

  systemState: () => ipcRenderer.invoke('system:state'),
  systemSet: (on) => ipcRenderer.invoke('system:set', on),

  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpInspect: (server) => ipcRenderer.invoke('mcp:inspect', server),
  mcpCall: (server, tool, args) => ipcRenderer.invoke('mcp:call', { server, tool, args }),
  mcpStart: (server) => ipcRenderer.invoke('mcp:start', server),
  skillList: () => ipcRenderer.invoke('skill:list'),
  skillRead: (id) => ipcRenderer.invoke('skill:read', id),

  send: (prompt, modelKey, runId, mode) => ipcRenderer.invoke('chat:send', { prompt, modelKey, runId, mode }),

  listFiles: () => ipcRenderer.invoke('file:list'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),

  emergencyStop: () => ipcRenderer.invoke('system:halt'),
  systemResume: () => ipcRenderer.invoke('system:resume'),
  cancelChat: (runId) => ipcRenderer.invoke('chat:cancel', runId),
  resourcesSnapshot: () => ipcRenderer.invoke('resources:snapshot'),
  capabilitiesBuild: () => ipcRenderer.invoke('capabilities:build'),
  purpleRun: (goal) => ipcRenderer.invoke('purple:run', goal),
  automationList: () => ipcRenderer.invoke('automation:list'),
  automationPause: () => ipcRenderer.invoke('automation:pause'),
  automationResume: () => ipcRenderer.invoke('automation:resume'),

  onEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
});
