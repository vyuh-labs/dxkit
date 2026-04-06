#!/usr/bin/env node
/**
 * Build step: copies src-templates/ into templates/ (the published artifact).
 * src-templates/ is the source of truth for the package — it lives next to src/
 * and is checked into the repo. templates/ is build output and gitignored.
 *
 * Runs as part of `npm run build` and `prepublishOnly`.
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_SRC = path.join(PKG_ROOT, 'src-templates');
const TEMPLATE_DEST = path.join(PKG_ROOT, 'templates');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

if (fs.existsSync(TEMPLATE_DEST)) {
  fs.rmSync(TEMPLATE_DEST, { recursive: true });
}
fs.mkdirSync(TEMPLATE_DEST, { recursive: true });

if (!fs.existsSync(TEMPLATE_SRC)) {
  console.log('Warning: src-templates/ not found at', TEMPLATE_SRC);
  console.log('Templates will be empty. This is expected when building from npm tarball.');
  process.exit(0);
}

copyRecursive(TEMPLATE_SRC, TEMPLATE_DEST);

let count = 0;
function countFiles(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) countFiles(full);
    else count++;
  }
}
countFiles(TEMPLATE_DEST);
console.log(`Copied ${count} template files from src-templates/ to templates/`);
