'use strict';

const { REGISTRY } = require('./config');

/**
 * Picks a model profile for a turn. Cheap heuristics first — a 2B classifier
 * round-trip costs more than it saves at this size.
 */
function route(prompt, ctx = {}) {
  const p = String(prompt || '').toLowerCase();
  const failures = ctx.failures || 0;
  // Intelligent selection from measured benchmarks when provided.
  if (ctx.benchmarkStore && Array.isArray(ctx.availableKeys) && ctx.availableKeys.length) {
    const best = ctx.benchmarkStore.select(ctx.taskType || 'general', ctx.availableKeys);
    if (best) return { key: best, why: 'benchmark-selected' };
  }

  if (failures >= 2) {
    return { key: 'escalation', why: `${failures} failed attempts -> escalation tier` };
  }
  if (/\b(plan|architect|design|break down|steps|approach)\b/.test(p) && p.length < 400) {
    return { key: 'planner', why: 'planning language detected' };
  }
  if (/\b(summaris|summariz|explain (this|the) (file|code|repo)|large file|whole repo|entire file|read through)\b/.test(p)) {
    return { key: 'reader', why: 'long-context read detected' };
  }
  if (/\b(find|where is|search|locate|which file|grep)\b/.test(p)) {
    return { key: 'scout', why: 'search/locate intent' };
  }
  return { key: ctx.forceKey || 'coder', why: ctx.forceKey ? 'manual override' : 'default coder' };
}

function spec(key) {
  return REGISTRY[key] || REGISTRY.coder;
}

module.exports = { route, spec };
