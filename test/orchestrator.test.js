'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orchestrate } = require('../core/orchestrator');

const result = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

test('supervisor plans, dispatches different specialists, and synthesizes their briefs', async () => {
  const calls = [];
  const events = [];
  const pool = {
    async chat(key, messages) {
      calls.push({ key, messages });
      if (calls.length === 1) return result(JSON.stringify({ steps: [
        { agent: 'scout', task: 'Inspect the project' },
        { agent: 'coder', task: 'Implement the change' },
      ] }));
      if (calls.length === 2) return result('Found source.js');
      if (calls.length === 3) {
        assert.match(messages[1].content, /Found source.js/);
        return result('Updated source.js');
      }
      assert.match(messages[1].content, /Found source.js/);
      assert.match(messages[1].content, /Updated source.js/);
      return result('The change is complete.');
    },
  };
  const out = await orchestrate({ prompt: 'Do the work', workspace: '/tmp', pool, emit: (e) => events.push(e) });
  assert.deepEqual(calls.map((c) => c.key), ['planner', 'scout', 'coder', 'coder']);
  assert.equal(out.orchestrated, true);
  assert.equal(out.text, 'The change is complete.');
  assert.equal(out.briefs.length, 2);
  assert.equal(events.filter((e) => e.type === 'step-done').length, 2);
});

test('supervisor reports an agent model failure and stops dependent steps', async () => {
  const calls = [];
  const pool = {
    async chat(key) {
      calls.push(key);
      if (calls.length === 1) return result(JSON.stringify({ steps: [
        { agent: 'scout', task: 'Inspect' },
        { agent: 'coder', task: 'Change' },
      ] }));
      throw new Error('model unavailable');
    },
  };
  const out = await orchestrate({ prompt: 'Do the work', workspace: '/tmp', pool, emit: () => {} });
  assert.match(out.error, /step 1 .*model unavailable/);
  assert.deepEqual(calls, ['planner', 'scout']);
  assert.match(out.briefs[0].brief, /FAILED/);
});
