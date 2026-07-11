#!/usr/bin/env node
/**
 * Rewrite the generated command table in docs/README.md from the capability
 * registry (CLAUDE.md Rule 16). Run after changing src/discovery/command-defs.ts:
 *
 *   npm run build && npm run docs:commands
 *
 * test/docs-command-tables.test.ts pins the committed table against the
 * registry, so forgetting this step fails CI with a pointer here.
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const distModule = path.join(root, 'dist', 'discovery', 'docs-tables.js');
if (!existsSync(distModule)) {
  console.error('dist/discovery/docs-tables.js not found — run `npm run build` first.'); // slop-ok: build script
  process.exit(1);
}

const { renderDocsCommandTable, replaceDocsCommandTable } = require(distModule);

const readme = path.join(root, 'docs', 'README.md');
const hasDocPage = (id) => existsSync(path.join(root, 'docs', 'commands', `${id}.md`));
const next = replaceDocsCommandTable(
  readFileSync(readme, 'utf8'),
  renderDocsCommandTable(hasDocPage),
);
writeFileSync(readme, next);

// The docs tree is prettier-formatted; normalize table padding the same way
// the pre-commit hook would so the generated file is committable as-is.
execFileSync('npx', ['prettier', '--write', 'docs/README.md'], { cwd: root, stdio: 'inherit' });
console.log('✓ docs/README.md command table regenerated from the capability registry'); // slop-ok: build script
