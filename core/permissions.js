'use strict';

// Rich permission system: rules per tool name (allow/deny/ask).
class PermissionManager {
  constructor(rules = {}) {
    this.rules = { ...rules }; // toolName -> 'allow' | 'deny' | 'ask'
    this.defaultAction = 'ask';
  }

  set(tool, action) {
    this.rules[tool] = action;
  }

  get(tool) {
    return this.rules[tool] || this.defaultAction;
  }

  decide(tool) {
    const a = this.get(tool);
    return { action: a, allowed: a === 'allow' };
  }

  // Pattern-based: supports wildcards like "mcp_*"
  match(tool) {
    if (this.rules[tool]) return this.rules[tool];
    for (const [pat, action] of Object.entries(this.rules)) {
      if (pat.includes('*')) {
        const re = new RegExp('^' + pat.replace(/\*/g, '.*') + '$');
        if (re.test(tool)) return action;
      }
    }
    return this.defaultAction;
  }
}

module.exports = { PermissionManager };