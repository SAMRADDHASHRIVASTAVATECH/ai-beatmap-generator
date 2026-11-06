#!/usr/bin/env node
'use strict';
// Purple-line CLI: autonomous test->diagnose->propose/fix cycle on a repo.
//   node scripts/purple-line.js [repo] [--goal <text>] [--apply]
// --apply wires the local model as the fixing agent (via Nexus agent stack).
const path = require('node:path');
const { PurpleLine } = require('../core/purple-line');

const repo = path.resolve(process.argv[2] || process.cwd());
const goalFlag = process.argv.indexOf('--goal');
const goal = goalFlag > -1 ? process.argv[goalFlag + 1] : 'make the test suite pass';
const apply = process.argv.includes('--apply');

(async () => {
  const dataDir = process.env.NEXUS_DATA_DIR || path.join(process.cwd(), '.nexus', 'purple');
  let agentFn = null;
  if (apply) {
    console.log('[purple] --apply needs a running LM Studio with a tool-calling model; wire runAgent here.');
    process.exit(2);
  }
  const line = new PurpleLine({ dataDir, repoRoot: repo, onEvent: (e) => console.log('[purple]', JSON.stringify(e)) });
  const r = await line.cycleOnce({ goal });
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => { console.error('failed:', e); process.exit(1); });
