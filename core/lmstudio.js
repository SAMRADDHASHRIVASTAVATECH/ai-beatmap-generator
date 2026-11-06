'use strict';

const { LMSTUDIO_BASE } = require('./config');

const BASE = LMSTUDIO_BASE.replace(/\/+$/, '');

// The model backend must be LM Studio on this machine, not a cloud provider.
// This restriction applies to model requests only, not shell, web or MCP tools.
function assertLocalBase(base = BASE) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error('LMSTUDIO_BASE must be a valid loopback HTTP URL');
  }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('LMSTUDIO_BASE must be a loopback HTTP URL (localhost, 127.0.0.1, or ::1) without credentials or a path');
  }
}

async function req(method, path, body, timeoutMs = 900000, signal = null) {
  assertLocalBase();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method,
      // Do not allow a local endpoint to redirect model data to a remote host.
      redirect: 'error',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function listModels({ signal = null } = {}) {
  const j = await req('GET', '/api/v1/models', null, 15000, signal);
  return j.models || j.data || [];
}

async function loadModel(model, opts = {}) {
  return req('POST', '/api/v1/models/load', { model, ...opts });
}

async function unloadModel(instanceId, model) {
  try {
    return await req('POST', '/api/v1/models/unload', { instance_id: instanceId }, 120000);
  } catch (e) {
    if (!model) throw e;
    return req('POST', '/api/v1/models/unload', { model }, 120000);
  }
}

async function chat(body, { signal = null } = {}) {
  return req('POST', '/v1/chat/completions', { stream: false, ...body }, 900000, signal);
}

async function embed(model, input) {
  const j = await req('POST', '/v1/embeddings', { model, input }, 300000);
  return (j.data || []).map((d) => d.embedding);
}

async function healthy({ signal = null } = {}) {
  try {
    await listModels({ signal });
    return true;
  } catch {
    return false;
  }
}

module.exports = { req, listModels, loadModel, unloadModel, chat, embed, healthy, assertLocalBase, BASE };
