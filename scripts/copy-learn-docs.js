#!/usr/bin/env node
/**
 * Package the learn knowledge base into dist/ so the published package
 * renders the full learn page with NO repo checkout and no network (the
 * zero-context path):
 *   - docs/learn/*.md        → dist/learn/docs/      (curated narratives)
 *   - docs/** (everything)   → dist/learn/docs-ref/  (the reference shelf)
 * Runs after tsc in `npm run build`; `src/learn/bundle.ts` prefers the
 * packaged copies and falls back to docs/ when running from source.
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const DEST_LEARN = path.join(__dirname, '..', 'dist', 'learn', 'docs');
const DEST_REF = path.join(__dirname, '..', 'dist', 'learn', 'docs-ref');

if (!fs.existsSync(DOCS)) {
  console.log('Warning: docs/ not found; learn page will render packaging stubs.'); // slop-ok
  process.exit(0);
}

let count = 0;
function copyTree(src, dest, skip) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d, null);
    } else if (entry.name.endsWith('.md')) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      count++;
    }
  }
}

copyTree(path.join(DOCS, 'learn'), DEST_LEARN, null);
copyTree(DOCS, DEST_REF, (name) => name === 'learn');
console.log(`Packaged ${count} learn/reference docs into dist/learn/`); // slop-ok
