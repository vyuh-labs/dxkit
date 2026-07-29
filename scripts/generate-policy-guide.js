#!/usr/bin/env node
/**
 * Rewrite the generated registry tables in docs/configuration/policy-guide.md
 * (E5): the remediate task→tier table, the per-driver tier→model mapping, and
 * the knob index. Run after changing the task/driver/metadata registries:
 *
 *   npm run build && npm run docs:policy-guide
 *
 * test/policy-guide.test.ts pins the committed guide against a fresh render,
 * so forgetting this step fails CI with a pointer here.
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const distModule = path.join(root, 'dist', 'discovery', 'policy-guide-tables.js');
if (!existsSync(distModule)) {
  console.error('dist/discovery/policy-guide-tables.js not found — run `npm run build` first.'); // slop-ok: build script
  process.exit(1);
}

const { replacePolicyGuideTables } = require(distModule);

const guide = path.join(root, 'docs', 'configuration', 'policy-guide.md');
writeFileSync(guide, replacePolicyGuideTables(readFileSync(guide, 'utf8')));
execFileSync('npx', ['prettier', '--write', 'docs/configuration/policy-guide.md'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('✓ policy-guide tables regenerated from the registries'); // slop-ok: build script
