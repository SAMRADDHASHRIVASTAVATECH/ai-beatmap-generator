#!/usr/bin/env node
'use strict';

// Build the capability manifest the harness embeds in every system prompt.
//   npm run capabilities            # fast: config + skill frontmatter, no process starts
//   npm run capabilities -- --measure   # also starts every server once to record tool counts
const path = require('node:path');
const { buildManifest } = require('../core/capability-manifest');

const measure = process.argv.includes('--measure');
const workspace = path.resolve(process.argv.find((a) => a.startsWith('--workspace='))?.split('=')[1] || process.cwd());

(async () => {
  const { manifest, file } = await buildManifest({
    workspace,
    measure,
    onLog: (m) => console.log('[capabilities]', m),
  });
  console.log(`wrote ${file}`);
  console.log(`servers: ${manifest.servers.length}  skills: ${manifest.skills.length}  measured: ${manifest.measured}`);
  const failed = (manifest.servers || []).filter((s) => s.measured && !s.measured.ok);
  if (failed.length) {
    console.log('servers that failed to start:');
    for (const s of failed) console.log(`  ${s.name}: ${s.measured.error}`);
  }
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
