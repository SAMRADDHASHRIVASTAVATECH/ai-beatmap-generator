#!/usr/bin/env node
'use strict';

// Live probe of every model visible to LM Studio: discovery + health, tool
// calling, JSON output and vision. Writes .nexus/probe.json.
// Usage: npm run probe
const path = require('node:path');
const fs = require('node:fs');
const { discover, probeAll } = require('../core/discovery');

(async () => {
  const dir = path.join(process.cwd(), '.nexus');
  fs.mkdirSync(dir, { recursive: true });
  console.log('discovering models on 127.0.0.1:1234 ...');
  const found = await discover({ withLiveness: true });
  for (const m of found.models) {
    console.log(`  ${m.id}  [${m.type}] ${m.params || ''} ${m.quantization || ''} ctx=${m.contextLength} size=${m.sizeHuman}`);
  }
  console.log('probing (loads models sequentially; first run is slow) ...');
  const results = await probeAll(found.models, {
    onProgress: (id) => console.log(`  probing ${id} ...`),
  });
  const merged = {
    discoveredAt: found.measuredAt,
    count: found.count,
    models: found.models,
    probes: results,
  };
  fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(merged, null, 2));
  console.log('\nwrote .nexus/probe.json');
  for (const p of results) {
    console.log(`  ${p.id}: ok=${p.ok} healthMs=${p.healthMs ?? '-'} toolCalling=${p.toolCalling ?? '-'} jsonOutput=${p.jsonOutput ?? '-'} vision=${p.visionAccepted ?? 'n/a'} ${p.error ? 'error=' + p.error : ''}`);
  }
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
