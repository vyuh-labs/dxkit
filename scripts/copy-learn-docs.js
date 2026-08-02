#!/usr/bin/env node
/**
 * Copy the curated learn docs (docs/learn/*.md) into dist/learn/docs/ so the
 * published package renders the learn page with NO repo checkout and no
 * network (the zero-context path). Runs after tsc in `npm run build`;
 * `src/learn/bundle.ts:learnDocsDir()` prefers this packaged copy and falls
 * back to docs/learn/ when running from source.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'docs', 'learn');
const DEST = path.join(__dirname, '..', 'dist', 'learn', 'docs');

if (!fs.existsSync(SRC)) {
  console.log('Warning: docs/learn/ not found; learn page will render packaging stubs.'); // slop-ok
  process.exit(0);
}
fs.mkdirSync(DEST, { recursive: true });
let count = 0;
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith('.md')) continue;
  fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
  count++;
}
console.log(`Copied ${count} learn docs to dist/learn/docs/`); // slop-ok
