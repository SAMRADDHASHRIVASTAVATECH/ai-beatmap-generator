'use strict';

/**
 * Nexus model registry.
 * `match` is resolved against LM Studio's GET /api/v1/models `key` field.
 * Only one model can be resident at a time on a 4 GB GPU — the pool enforces it.
 */

const REGISTRY = {
  scout: {
    match: 'qwen3.5-2b',
    label: 'Qwen3.5-2B',
    role: 'Fast scouts: read, grep, summarise, test-triage. Runs 4 subagents.',
    diskGb: 1.27,
    context_length: 16384,
    slots: 4,
    priority: 40,
    pinned: false,
    vision: true,
  },
  coder: {
    match: 'qwen3-4b-instruct-2507',
    label: 'Qwen3-4B-2507',
    role: 'Main agent. Writes and edits code.',
    diskGb: 2.5,
    context_length: 16384,
    slots: 1,
    priority: 90,
    pinned: true,
    vision: false,
    offload_kv_cache_to_gpu: false,
  },
  planner: {
    match: 'ministral-3-3b-instruct-2512',
    label: 'Ministral-3B',
    role: 'Multi-step planning and native tool calling.',
    diskGb: 2.15,
    context_length: 32768,
    slots: 1,
    priority: 80,
    pinned: false,
    vision: true,
  },
  reader: {
    match: 'lfm3-vl-2b',
    label: 'LFM3-VL-2B',
    role: '128K-context reader: big files, diffs, screenshots.',
    diskGb: 1.1,
    context_length: 65536,
    slots: 1,
    priority: 60,
    pinned: false,
    vision: true,
  },
  escalation: {
    match: 'rnj-1-instruct',
    label: 'rnj-1 8B',
    role: 'Hard reasoning after repeated failure. CPU offload, slow.',
    diskGb: 5.11,
    context_length: 16384,
    slots: 1,
    priority: 30,
    pinned: false,
    vision: false,
    offload_kv_cache_to_gpu: false,
  },
  embedder: {
    match: 'nomic-embed-text',
    label: 'nomic-embed',
    role: 'Repo embeddings. CPU only.',
    diskGb: 0.15,
    context_length: 2048,
    slots: 1,
    priority: 20,
    pinned: false,
    vision: false,
    cpu_only: true,
  },
};

const POLICY = {
  max_resident: 1,
  vram_floor_mb: 350,
  idle_ttl_seconds: 900,
};

module.exports = { REGISTRY, POLICY, LMSTUDIO_BASE: process.env.LMSTUDIO_BASE || 'http://127.0.0.1:1234' };
