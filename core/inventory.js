'use strict';

/** Normalize only metadata reported by LM Studio; missing capabilities remain unknown. */
function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.key === 'string' ? raw.key : typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const positive = (v) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  const type = typeof raw.type === 'string' ? raw.type : null;
  const instances = Array.isArray(raw.loaded_instances) ? raw.loaded_instances : [];
  return {
    id,
    runtime: 'LM Studio',
    type,
    architecture: raw.architecture ?? null,
    quantization: typeof raw.quantization === 'string' ? raw.quantization : raw.quantization?.name ?? null,
    parameters: raw.params_string ?? null,
    sizeBytes: positive(raw.size_bytes ?? raw.size),
    maxContextLength: positive(raw.max_context_length),
    loadedInstances: instances.map((v) => ({ id: v.id == null ? null : String(v.id) })),
    // These must not be guessed from model names. They can be filled by future
    // reproducible evaluations or explicit server metadata.
    capabilities: { tools: null, vision: null, reasoning: null, coding: null, structuredOutput: null },
  };
}

function normalizeInventory(models) {
  const found = new Map();
  for (const item of Array.isArray(models) ? models : []) {
    const entry = normalizeModel(item);
    if (entry && !found.has(entry.id)) found.set(entry.id, entry);
  }
  return [...found.values()];
}

module.exports = { normalizeModel, normalizeInventory };
