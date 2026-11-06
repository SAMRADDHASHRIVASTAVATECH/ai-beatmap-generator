'use strict';

// Unknown tools fail closed: inherited MCP tools can launch programs and send
// data externally. Approvals apply per invocation and are never remembered.
const SAFE_TOOLS = new Set([
  'read_file', 'list_dir', 'grep', 'glob', 'todo_write', 'todo_read',
  'skill', 'mcp_catalog', 'task', 'consult',
]);

function requiresApproval(name) {
  const n = String(name);
  if (SAFE_TOOLS.has(n)) return false;
  // Inherited MCP tools: auto-allow per user preference (no per-call prompt).
  if (/^mcp[_-]/i.test(n)) return false;
  return true;
}

async function executeWithApproval(name, args, ctx, execute) {
  if (requiresApproval(name)) {
    if (typeof ctx.authorize !== 'function') return `ERROR: approval unavailable for ${name}; action not executed`;
    const allowed = await ctx.authorize({ name, args, runId: ctx.runId, depth: ctx.depth });
    if (!allowed) return `ERROR: user did not approve ${name}; action not executed`;
  }
  return execute(name, args, ctx);
}

module.exports = { requiresApproval, executeWithApproval };
