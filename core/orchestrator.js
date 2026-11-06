'use strict';

/**
 * Orchestrator — one supervisor AI that directs the other AIs.
 *
 * Hard constraint on this machine: only ONE model fits in VRAM at a time.
 * So the supervisor cannot co-host helpers. It works by:
 *
 *   1. PLAN      on the planner model
 *   2. DISPATCH  one helper at a time; the pool swaps models underneath
 *   3. HANDOFF   each helper returns a brief, not a transcript
 *   4. SYNTHESISE on the coder model
 *
 * State lives in this process, never in a model's KV cache — so a model swap
 * never loses the thread. That is the whole trick.
 */

const { runAgent } = require('./agent');
const { IndependentVerifier, ParallelExecutor, PurpleCycle } = require('./orchestration');

const PLAN_PROMPT = `You are the supervisor of a small local AI team.
Break the user's request into the FEWEST independent steps that can each be handed to one helper.

Available helpers:
- scout     : fast search/read/summarise. Use for locating code and reading many files.
- reader    : long-context reading of big files and diffs.
- planner   : design and multi-step reasoning about approach.
- coder     : writes and edits code. Use for any change to files.
- escalation: slow, strong reasoning. Only for genuinely hard problems.

Return ONLY JSON, no prose, no markdown fence:
{"steps":[{"agent":"scout","task":"one sentence instruction"}]}

Rules:
- 1 step if the request is simple. Never invent steps that add no value.
- "coder" must be the agent for any step that modifies files.
- Steps run in order; each receives the briefs of the steps before it.
- Max 5 steps.`;

function isComplex(prompt) {
  const p = String(prompt || '');
  const words = p.trim().split(/\s+/).length;
  const multi = /(\band\b.*\band\b)|(\bthen\b)|(\bfirst\b.*\bsecond\b)|(\bmultiple\b)|(\ball files\b)|(\bthroughout\b)/i.test(p);
  return words > 28 || multi;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const VALID = new Set(['scout', 'reader', 'planner', 'coder', 'escalation']);

async function makePlan(prompt, pool, emit, history = [], signal = null) {
  emit({ type: 'phase', phase: 'plan', text: 'supervisor is planning' });

  let raw = '';
  try {
    // Do not race an uncancellable model request against a timer: the
    // abandoned planner could keep its pool lease and block later work.
    // LM Studio's own request timeout governs the request lifecycle.
    const res = await pool.chat(
      'planner',
      [
        { role: 'system', content: PLAN_PROMPT },
        ...history,
        { role: 'user', content: prompt },
      ],
      null,
      { temperature: 0.1, max_tokens: 700, signal }
    );
    raw = res?.choices?.[0]?.message?.content || '';
  } catch (e) {
    if (!signal?.aborted) emit({ type: 'warn', message: 'planner unavailable: ' + e.message });
    return null;
  }

  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) {
    emit({ type: 'warn', message: 'planner returned no usable plan — falling back to direct run' });
    return null;
  }

  const steps = parsed.steps
    .filter((s) => s && s.task && String(s.task).trim())
    .slice(0, 5)
    .map((s, i) => ({
      id: i + 1,
      agent: VALID.has(String(s.agent)) ? String(s.agent) : 'scout',
      task: String(s.task).trim(),
    }));

  if (!steps.length) return null;
  emit({ type: 'plan', steps });
  return steps;
}

async function orchestrate({ prompt, workspace, pool, emit, maxBrief = 900, systemAccess = false, registry = null, authorize = null, history = [], inject = '', shouldAbort = null, checkpointRoot = null, signal = null }) {
  const cancelled = () => !!signal?.aborted || (typeof shouldAbort === 'function' && shouldAbort());
  const stopped = () => ({ cancelled: true, orchestrated: true, text: '' });
  if (cancelled()) return stopped();
  const plan = await makePlan(prompt, pool, emit, history, signal);
  if (cancelled()) return stopped();

  if (!plan) {
    // Simple request: one agent, no ceremony.
    return runAgent({ prompt, workspace, pool, emit, systemAccess, registry, authorize, history, inject, shouldAbort, checkpointRoot, signal });
  }

  const briefs = [];

  for (const step of plan) {
    if (cancelled()) return stopped();
    emit({
      type: 'phase',
      phase: 'dispatch',
      text: `step ${step.id}/${plan.length} → ${step.agent}`,
      agent: step.agent,
      task: step.task,
    });

    const briefPrompt = [
      `Overall goal:\n${prompt}`,
      history.length ? `\nRecent conversation context:\n${history.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-8000)}` : '',
      briefs.length
        ? `\nWhat earlier helpers already established:\n${briefs.map((b) => `- [${b.agent}] ${b.brief}`).join('\n')}`
        : '',
      `\nYour step (${step.id}/${plan.length}): ${step.task}`,
      `\nWhen done, reply with a compact brief of what you found or changed. Max 6 bullet points.`,
    ].join('\n');

    try {
      const out = await runAgent({
        prompt: briefPrompt,
        modelKey: step.agent,
        workspace,
        pool,
        emit,
        systemAccess,
        registry,
        authorize,
        inject,
        shouldAbort,
        signal,
        checkpointRoot,
        maxSteps: 14,
      });
      if (out.cancelled || cancelled()) return stopped();
      if (out.error) throw new Error(out.error);
      if (out.truncated) throw new Error('agent reached its step limit without completing');
      const brief = (out.text || '(no output)').slice(0, maxBrief);
      briefs.push({ agent: step.agent, task: step.task, brief });
      emit({ type: 'step-done', step: step.id, agent: step.agent, brief });
    } catch (e) {
      const error = `step ${step.id} (${step.agent}) failed: ${e.message}`;
      emit({ type: 'error', message: error });
      briefs.push({ agent: step.agent, task: step.task, brief: `FAILED: ${e.message}` });
      // Later steps may depend on this result; do not report partial work as complete.
      return { error, orchestrated: true, plan, briefs };
    }
  }

  // Final synthesis runs on the coder, which is the strongest model we have.
  if (cancelled()) return stopped();
  emit({ type: 'phase', phase: 'synthesise', text: 'supervisor is writing the answer' });

  const synthPrompt = [
    `The user asked:\n${prompt}`,
    `\nYour team reported:`,
    ...briefs.map((b) => `\n[${b.agent}] ${b.task}\n${b.brief}`),
    `\nWrite the final answer for the user. Be short and concrete.`,
    `If anything failed, say so plainly instead of pretending it worked.`,
  ].join('\n');

  const final = await runAgent({
    prompt: synthPrompt,
    modelKey: 'coder',
    workspace,
    pool,
    emit,
    systemAccess,
    registry,
    authorize,
    history,
    inject,
    shouldAbort,
    signal,
    checkpointRoot,
    maxSteps: 8,
  });

  if (final.cancelled || cancelled()) return stopped();

  // Independent verification step (best-effort, non-blocking).
  const verifier = new IndependentVerifier([
    { name: 'no-error', fn: async () => ({ ok: !final.error, evidence: final.error || 'ok' }) },
    { name: 'has-output', fn: async () => ({ ok: !!final.text, evidence: final.text ? 'text present' : 'empty' }) },
  ]);
  const verification = await verifier.verify({ final, briefs });
  emit({ type: 'verify', passed: verification.passed, results: verification.results });

  return { ...final, orchestrated: true, plan, briefs, verification };
}

module.exports = { orchestrate, makePlan, isComplex };
