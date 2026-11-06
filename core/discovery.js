'use strict';

/**
 * Model discovery for LM Studio (loopback only).
 *
 * Authoritative source: GET /api/v1/models (type, publisher, architecture,
 * quantization, size_bytes, max_context_length, vision, trained_for_tool_use,
 * reasoning, loaded_instances). Cross-checked against /v1/models for liveness.
 *
 * Optional live probes per model: health (1-token), tool-calling, JSON output
 * and vision. Each probe is bounded; results are cached under .nexus/ so the
 * agent does not pay to re-measure every boot.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const lm = require('./lmstudio');

function formatBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const caps = e.capabilities || {};
  return {
    id: String(e.key || e.id || ''),
    displayName: String(e.display_name || e.key || e.id || ''),
    type: String(e.type || 'unknown'),           // llm | embedding
    runtime: 'LM Studio',                         // only local provider we trust
    provider: String(e.publisher || 'unknown'),
    architecture: e.architecture || null,
    params: e.params_string || null,
    quantization: e.quantization ? e.quantization.name : (typeof e.quantization === 'string' ? e.quantization : null),
    quantBits: e.quantization && e.quantization.bits_per_weight != null ? e.quantization.bits_per_weight : null,
    sizeBytes: Number.isFinite(e.size_bytes) ? e.size_bytes : null,
    sizeHuman: formatBytes(e.size_bytes),
    contextLength: Number.isFinite(e.max_context_length) ? e.max_context_length : null,
    format: e.format || null,
    vision: Boolean(caps.vision),
    trainedForToolUse: caps.trained_for_tool_use === true ? true : (caps.trained_for_tool_use === false ? false : null),
    reasoning: caps.reasoning ? { allowed: caps.reasoning.allowed_options || [], default: caps.reasoning.default || null } : null,
    loaded: Array.isArray(e.loaded_instances) ? e.loaded_instances.length > 0 : false,
    maxContextNote: 'max_context_length is the load-time ceiling; effective window depends on launch flags',
  };
}

async function discover({ withLiveness = true } = {}) {
  const list = await lm.listModels();               // /api/v1/models
  const models = (Array.isArray(list) ? list : []).map(normalizeEntry).filter((m) => m && m.id);
  let liveIds = null;
  if (withLiveness) {
    try {
      const live = await lm.req('GET', '/v1/models', null, 15000);
      liveIds = new Set((live?.data || []).map((m) => m.id));
    } catch {
      liveIds = null; // discovery still works; liveness unknown
    }
  }
  for (const m of models) {
    m.listedByV1 = liveIds ? liveIds.has(m.id) : null;   // server-side presence check
    m.healthy = null;                                    // filled by probe()
  }
  const byType = models.reduce((acc, m) => { (acc[m.type] ||= []).push(m); return acc; }, {});
  return {
    measuredAt: new Date().toISOString(),
    count: models.length,
    byType,
    models,
  };
}

// ---- live probes (opt-in; load the models) ----

const TINY_PNG =
  'data:image/png;base64,' +
  Buffer.from(
    // 1x1 white PNG
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ).toString('base64');

async function probeModel(model, { timeoutMs = 120000 } = {}) {
  const out = { id: model.id, ok: false, healthMs: null, toolCalling: null, jsonOutput: null, visionAccepted: null, error: null };
  if (model.type === 'embedding') {
    try {
      const t0 = Date.now();
      await lm.embed(model.id, ['ping']);
      out.ok = true;
      out.healthMs = Date.now() - t0;
    } catch (e) {
      out.error = String(e.message || e).slice(0, 200);
    }
    return out;
  }
  // 1) plain health
  try {
    const t0 = Date.now();
    const r = await lm.chat({ model: model.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 });
    out.healthMs = Date.now() - t0;
    out.ok = Boolean(r?.choices?.[0]);
    if (!out.ok) out.error = 'empty completion';
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
    return out;
  }
  // 2) tool calling
  try {
    const r = await lm.chat({
      model: model.id,
      messages: [{ role: 'user', content: 'What time is it? Use the get_time tool.' }],
      temperature: 0,
      max_tokens: 256,
      tools: [{ type: 'function', function: { name: 'get_time', description: 'Get the current time', parameters: { type: 'object', properties: {}, required: [] } } }],
    });
    const tc = r?.choices?.[0]?.message?.tool_calls || [];
    out.toolCalling = tc.length > 0;
  } catch {
    out.toolCalling = false;
  }
  // 3) structured (JSON) output — LM Studio has no response_format passthrough,
  // so ask for JSON in plain text (what real local agents do) and parse it.
  try {
    const r = await lm.chat({
      model: model.id,
      messages: [{ role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok": true}' }],
      temperature: 0,
      max_tokens: 64,
    });
    const text = String(r?.choices?.[0]?.message?.content || '')
      .replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    JSON.parse(text);
    out.jsonOutput = true;
  } catch {
    out.jsonOutput = false;
  }
  // 4) vision acceptance (only for vision-capable models)
  if (model.vision) {
    try {
      const r = await lm.chat({
        model: model.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this image? Answer with one word.' }, { type: 'image_url', image_url: { url: TINY_PNG } }] }],
        temperature: 0,
        max_tokens: 8,
      });
      out.visionAccepted = Boolean(r?.choices?.[0]);
    } catch {
      out.visionAccepted = false;
    }
  }
  return out;
}

async function probeAll(models, { onProgress = () => {} } = {}) {
  const results = [];
  for (const m of models) {
    onProgress(m.id);
    try {
      results.push(await probeModel(m));
    } catch (e) {
      results.push({ id: m.id, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }
  return results;
}

module.exports = { discover, normalizeEntry, formatBytes, probeModel, probeAll, TINY_PNG };
