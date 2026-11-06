'use strict';

const { SCHEMAS, SYSTEM_SCHEMAS, EXTRA_SCHEMAS, executeTool } = require('./tools');
const { route, spec } = require('./router');
const { executeWithApproval } = require('./approval');
const { CheckpointStore, LongTermMemory } = require('./memory');
const { loadManifest, renderPromptSection } = require('./capability-manifest');
const { SandboxPolicy } = require('./sandbox');
const { PermissionManager } = require('./permissions');

const MAX_DEPTH = 2;
/** A 4-bit 4B model cannot hold 600 tool schemas. Native MCP tools are capped;
 *  the rest stay reachable through mcp_catalog / mcp_inspect / mcp_call. */
const MAX_NATIVE_MCP_TOOLS = 40;

function systemPrompt(workspace, agentKey, systemAccess = false, registry = null, modelSpec = null, extraSections = '') {
  const s = modelSpec || spec(agentKey);
  const caps = registry
    ? (() => {
        const st = registry.status();
        const ready = st.servers.filter((x) => x.state === 'ready').length;
        return `Capabilities on this machine: ${st.servers.length} configured MCP servers (${ready} warm, ${st.toolCount} tools live) and ${st.skills} skills.
- mcp_catalog lists every configured server (ready or on-demand) and tool count. mcp_inspect <server> shows exact argument schemas.
- ANY configured server starts on demand — including ones marked disabled in the config: call mcp_start <server>, or just call its tool directly; it boots on first use. Do not claim a server is unavailable just because it is disabled in the config.
- Your tool list includes native MCP tools shaped mcp_<server>_<tool>. Call them directly; if a name is rejected, run mcp_inspect <server> and retry with the exact name. Never stop at a naming mistake.
- skill with no argument lists every skill; skill <id> loads that skill's full instructions. Read the skill first, then follow it.
- mcp_call runs any tool by server/tool name when the native name fails.
- MCP tools do not require user approval; execute them freely. Everything is local — nothing leaves this machine unless the invoked tool itself does so by design.
- Anything a tool can do, you can do. Never tell the user something is impossible before checking mcp_catalog, skills and mcp_inspect.`;
      })()
    : '';
  return `You are Nexus, the local agent controlling this machine on ${s.label}.
Workspace root: ${workspace}
${
  systemAccess
    ? `SYSTEM ACCESS: ON. You may use absolute paths anywhere on this machine, run commands from the user's home directory, launch apps with open_path, and inspect the machine with system_info. Changes outside the workspace affect the real machine.`
    : `SYSTEM ACCESS: OFF. Paths stay inside the workspace root and commands run there. If a task genuinely needs the wider machine, say so once and tell the user to arm SYSTEM in the footer — then do the part you can.`
}

${caps}
${
  registry && registry.projectContext
    ? `\nStanding instructions inherited from this machine and this workspace (follow them):\n${registry.projectContext}\n`
    : ''
}
${extraSections ? '\n' + extraSections + '\n' : ''}
Rules:
- Use available file, shell, web, MCP and skill tools where appropriate. Be honest about errors, limitations, and incomplete work; never claim a tool or operation succeeded without checking.
- When the user asks to open, launch, play or navigate to something, use open_path or an MCP tool when allowed. If system access is OFF, respect workspace boundaries and request approval for wider access.
- Inspect before you change. Use read_file / list_dir / glob / grep. Never guess file contents.
- To change existing code use edit_file with a unique old_string, or apply_patch for several files at once. Use write_file only for new files.
- After editing, run the project's checks (npm test, tsc --noEmit, eslint) when they exist.
- If a tool returns ERROR, read it and adapt. Never repeat the identical failing call.
- If a tool name is rejected, use the suggestions in the error or mcp_inspect, then retry with the real name. Never stop at the first naming mistake.
- Keep replies short and factual. State what you did.
- Weight experiments (the 'experiment' tool, direct weight editing) are ON DEMAND ONLY. Never start one, scaffold one, or "try" one unless the user explicitly asked for it in this turn. Pass approve:true only after that explicit request. Base weights are never modified in place.
- Use task to delegate independent work when useful. Subagent tasks currently run sequentially and may require model swaps.
- For multi-step work, call todo_write so progress is visible, then work through it.`;
}

function msgText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join('');
  return '';
}

async function runAgent(opts) {
  const {
    prompt,
    modelKey,
    workspace,
    pool,
    emit,
    depth = 0,
    maxSteps = 20,
    routeCtx = {},
    systemAccess = false,
    registry = null,
    authorize = null,
    history = [],
    shouldAbort = null,
    signal = null,
    inject = '',
  } = opts;

  const runId = opts.runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const checkpointRoot = opts.checkpointRoot || (process.env.NEXUS_DATA_DIR ? process.env.NEXUS_DATA_DIR : null);
  const checkpoints = checkpointRoot ? new CheckpointStore(checkpointRoot) : null;
  const sandbox = opts.sandbox || (opts.workspace ? new SandboxPolicy({ workspace: opts.workspace, allowSystem: !!opts.systemAccess, allowNetwork: true }) : null);
  const chosen = modelKey ? { key: modelKey, why: 'explicit' } : route(prompt, routeCtx);
  let key = chosen.key;

  const selectedSpec = typeof pool.spec === 'function' ? pool.spec(key) : spec(key);
  emit({ type: 'run-start', runId, modelKey: key, label: selectedSpec.label, why: chosen.why, depth });

  // Teach the harness everything this machine can do. The section is either a
  // persisted manifest (npm run capabilities) or a live compact build; either
  // way it carries the decision tree, the server list and the skill index.
  let capabilitySection = '';
  if (registry) {
    try {
      const manifest = await loadManifest(workspace);
      const budget = Number(process.env.NEXUS_CAPABILITY_BUDGET) || 6000;
      if (manifest) {
        capabilitySection = renderPromptSection(manifest, { charBudget: budget });
      } else {
        const st = registry.status();
        capabilitySection = renderPromptSection({
          servers: (st.servers || []).map((s) => ({ name: s.name, enabled: s.enabled !== false, onDemand: s.onDemand, description: '' })),
          skills: (registry.skills || []).map((sk) => ({ id: sk.id, description: sk.description })),
        }, { charBudget: budget });
      }
    } catch (e) {
      emit({ type: 'warn', runId, message: `capability section build failed: ${e.message}` });
    }
  }

  // Proven tool chains from memory — reuse what already worked here.
  let playbookSection = '';
  const memory = checkpointRoot ? new LongTermMemory(checkpointRoot) : null;
  if (memory) {
    try {
      await memory.load(workspace);
      const hits = memory.search(prompt, { limit: 6, workspace })
        .filter((m) => (m.tags || []).includes('playbook'))
        .slice(0, 3);
      if (hits.length) {
        playbookSection = 'Proven chains on this machine — reuse these shapes:\n' +
          hits.map((m) => `- ${String(m.content).replace(/\n/g, ' | ').slice(0, 400)}`).join('\n');
      }
    } catch (e) {
      emit({ type: 'warn', runId, message: `playbook load failed: ${e.message}` });
    }
  }

  const availableProfiles = pool.idCache instanceof Map
    ? [...pool.idCache.entries()].map(([profile, id]) => `${profile}: ${id}`) : [];
  const extraModels = pool.discovered instanceof Map
    ? [...pool.discovered.entries()].filter(([, s]) => s.available && !/embed/i.test(s.type || '')).map(([name]) => name) : [];
  const modelContext = [...availableProfiles, ...extraModels].slice(0, 30);
  const extraSections = [capabilitySection, playbookSection, inject].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: systemPrompt(workspace, key, systemAccess, registry, selectedSpec, extraSections) +
      (modelContext.length ? `\n\nLocal model choices reported by LM Studio (capabilities are not verified):\n${modelContext.join('\n')}` : '') },
    ...history.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string'),
    { role: 'user', content: prompt },
  ];

  const native = registry ? registry.schemas().slice(0, MAX_NATIVE_MCP_TOOLS) : [];
  const tools = [
    ...SCHEMAS,
    ...EXTRA_SCHEMAS,
    ...(systemAccess ? SYSTEM_SCHEMAS : []),
    ...native,
  ];
  if (native.length) {
    emit({ type: 'capabilities', nativeTools: native.length, servers: registry.servers.size, skills: (registry.skills || []).length });
  }

  let errors = 0;
  let finalText = '';
  let errorNudged = false;
  const usedTools = [];
  const maybeRecordPlaybook = async () => {
    if (!memory || errors >= 3) return;
    const interesting = usedTools.filter((n) => /^(mcp[_-]|skill$|run_command$|task$|consult$|open_path$)/.test(n));
    if (!interesting.length) return;
    try {
      await memory.store(workspace, 'note',
        `Task: ${String(prompt).slice(0, 200)}\nChain: ${interesting.join(' -> ')}`, ['playbook']);
    } catch {}
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted || (typeof shouldAbort === 'function' && shouldAbort())) {
      emit({ type: 'run-done', runId, steps: step - 1, depth, cancelled: true });
      await maybeRecordPlaybook();
      return { runId, text: finalText, cancelled: true };
    }
    let res;
    try {
      res = await pool.chat(key, messages, tools, { temperature: 0.2, max_tokens: 2048, signal });
    } catch (e) {
      if (signal?.aborted || (typeof shouldAbort === 'function' && shouldAbort())) {
        emit({ type: 'run-done', runId, steps: step - 1, depth, cancelled: true });
        return { runId, text: finalText, cancelled: true };
      }
      emit({ type: 'error', runId, message: e.message });
      return { runId, text: finalText, error: e.message };
    }

    if (signal?.aborted || (typeof shouldAbort === 'function' && shouldAbort())) {
      emit({ type: 'run-done', runId, steps: step - 1, depth, cancelled: true });
      return { runId, text: finalText, cancelled: true };
    }
    const msg = res?.choices?.[0]?.message || {};
    messages.push(msg);

    const text = msgText(msg);
    if (text) {
      finalText = text;
      const reasoning = msg.reasoning_content || (msg.reasoning && String(msg.reasoning)) || null;
      emit({ type: 'assistant', runId, text, depth, reasoning });
    }

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      emit({ type: 'run-done', runId, steps: step, depth });
      await maybeRecordPlaybook();
      return { runId, text: finalText };
    }

    // Parse every call up front so read-only work can run concurrently.
    const parsed = calls.map((call) => {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        args = {};
      }
      return { id: call.id, name: call.function?.name || 'unknown', args };
    });

    const READ_ONLY = new Set([
      'read_file',
      'list_dir',
      'grep',
      'glob',
      'system_info',
      'open_path',
      'webfetch',
      'todo_read',
      'mcp_catalog',
      'mcp_inspect',
      'skill',
    ]);
    const ctxFor = () => ({
      workspace,
      pool,
      emit,
      depth,
      runId,
      systemAccess,
      registry,
      authorize,
      sandbox,
      permissions: registry ? new PermissionManager(registry.permissions || {}) : null,
      spawnSubagent: async (a) => {
        if (depth >= MAX_DEPTH) return 'ERROR: subagent depth limit reached';
        const sub = await runAgent({
          prompt: a.prompt,
          modelKey: a.agent || 'scout',
          workspace,
          pool,
          emit,
          depth: depth + 1,
          maxSteps: 12,
          systemAccess,
          registry,
          authorize,
          shouldAbort,
          signal,
          inject,
        });
        if (sub.cancelled) return 'ERROR: subagent interrupted';
        if (sub.error) return `ERROR: subagent ${a.agent || 'scout'} failed: ${sub.error}`;
        if (sub.truncated) return `ERROR: subagent ${a.agent || 'scout'} reached its step limit without completing`;
        return `[${a.description}] ${sub.text || '(no output)'}`;
      },
    });

    const runOne = async (p) => {
      emit({ type: 'tool-call', runId, name: p.name, args: p.args, depth });
      try {
        return String((await executeWithApproval(p.name, p.args, ctxFor(), executeTool)) ?? '');
      } catch (e) {
        return `ERROR: ${e.message}`;
      }
    };

    // Batch consecutive read-only calls: they are independent, and the pool can
    // serve several in flight at once thanks to multi-slot models.
    const outcomes = new Array(parsed.length);
    for (let i = 0; i < parsed.length; ) {
      if (signal?.aborted || (typeof shouldAbort === 'function' && shouldAbort())) {
        emit({ type: 'run-done', runId, steps: step - 1, depth, cancelled: true });
        return { runId, text: finalText, cancelled: true };
      }
      if (READ_ONLY.has(parsed[i].name)) {
        let j = i;
        while (j < parsed.length && READ_ONLY.has(parsed[j].name)) j++;
        const batch = parsed.slice(i, j);
        for (const p of batch) emit({ type: 'tool-call', runId, name: p.name, args: p.args, depth });
        const res = await Promise.all(
          batch.map(async (p) => {
            try {
              return String((await executeWithApproval(p.name, p.args, ctxFor(), executeTool)) ?? '');
            } catch (e) {
              return `ERROR: ${e.message}`;
            }
          })
        );
        res.forEach((r, k) => { outcomes[i + k] = r; });
        i = j;
      } else {
        outcomes[i] = await runOne(parsed[i]);
        i++;
      }
    }

    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      usedTools.push(p.name);
      const str = outcomes[i] ?? '';
      if (str.startsWith('ERROR')) errors += 1;
      else errors = 0;

      emit({ type: 'tool-result', runId, name: p.name, result: str.slice(0, 3000), depth });
      messages.push({ role: 'tool', tool_call_id: p.id, content: str });

      // Trim runaway transcripts so a small-context model keeps working.
      if (messages.length > 40) {
        const head = messages.slice(0, 2);
        const tail = messages.slice(-30);
        messages.length = 0;
        messages.push(...head, { role: 'system', content: '(earlier messages trimmed to fit context)' }, ...tail);
      }
    }

    // One corrective nudge on the first failure of a run. Placed after the tool
    // replies so it never sits between an assistant tool_call and its result.
    if (errors > 0 && !errorNudged) {
      errorNudged = true;
      messages.push({
        role: 'system',
        content:
          'A tool above returned ERROR. Do not repeat the same call. Read the exact error text, fix the argument, path or approach it names, then retry once. ' +
          'If the target genuinely does not exist, verify that with a listing before telling the user that.',
      });
    }

    if (errors >= 3) {
      if (key !== 'escalation') {
        emit({
          type: 'warn',
          runId,
          message: '3 consecutive tool errors — escalating to the strongest core',
        });
        key = 'escalation';
        errors = 0;
        emit({ type: 'run-start', runId, modelKey: key, label: spec(key).label, why: 'escalation tier', depth });
        messages.push({
          role: 'system',
          content:
            'ESCALATION. The attempts above failed repeatedly. Diagnose the real cause from the error text, then use a different approach. ' +
            'Never repeat an identical failing call. If a tool or path genuinely does not exist, verify with a listing or mcp_catalog before saying so.',
        });
        continue;
      }
      emit({ type: 'warn', runId, message: 'repeated tool errors — stopping' });
      break;
    }
  }

  await maybeRecordPlaybook();
  emit({ type: 'run-done', runId, steps: maxSteps, depth, truncated: true });
  return { runId, text: finalText, truncated: true };
}

module.exports = { runAgent, systemPrompt, MAX_NATIVE_MCP_TOOLS };
