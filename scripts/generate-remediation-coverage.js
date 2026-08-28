#!/usr/bin/env node
/**
 * Rewrite the generated remediation coverage table in
 * docs/learn/operating-the-lanes.md (4.4.7 V4): which pack supports which
 * remediation recipe, and the pack-declared exemption reasons, rendered
 * from the LANGUAGES registry. Run after changing a pack's remediation
 * declarations (or adding a pack):
 *
 *   npm run build && npm run docs:remediation-coverage
 *
 * test/remediation-coverage-docs.test.ts pins the committed guide against
 * a fresh render, so forgetting this step fails CI with a pointer here.
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const distModule = path.join(root, 'dist', 'discovery', 'remediation-coverage-tables.js');
if (!existsSync(distModule)) {
  console.error(
    'dist/discovery/remediation-coverage-tables.js not found: run `npm run build` first.', // slop-ok: build script
  );
  process.exit(1);
}

const { replaceRemediationCoverage } = require(distModule);

const guide = path.join(root, 'docs', 'learn', 'operating-the-lanes.md');
writeFileSync(guide, replaceRemediationCoverage(readFileSync(guide, 'utf8')));
execFileSync('npx', ['prettier', '--write', 'docs/learn/operating-the-lanes.md'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('✓ remediation coverage table regenerated from the pack declarations'); // slop-ok: build script
