#!/usr/bin/env node
/**
 * Build step: emit policy.schema.json at the package root from the compiled
 * schema builder (dist/baseline/policy-schema.js). The package root is where
 * the scaffold's local-path $schema stamp points
 * (./node_modules/@vyuhlabs/dxkit/policy.schema.json), so the shipped schema
 * is always version-matched to the shipped dxkit. Runs after tsc in `npm run
 * build`; the artifact is gitignored (generated, never hand-edited).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { buildPolicySchema } = require(path.join(root, 'dist', 'baseline', 'policy-schema.js'));
const { version } = require(path.join(root, 'package.json'));

const out = path.join(root, 'policy.schema.json');
fs.writeFileSync(out, JSON.stringify(buildPolicySchema(version), null, 2) + '\n', 'utf8');
console.log(`Generated policy.schema.json (dxkit ${version})`); // slop-ok — build-script progress line
