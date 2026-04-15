#!/usr/bin/env node
/**
 * Build step: copies src-templates/ into templates/ (the published artifact)
 * and copies non-TS resource files (e.g. default-exclusions.gitignore) into
 * dist/ so they're accessible via __dirname at runtime.
 *
 * Runs as part of `npm run build` and `prepublishOnly`.
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_SRC = path.join(PKG_ROOT, 'src-templates');
const TEMPLATE_DEST = path.join(PKG_ROOT, 'templates');

// Resource files loaded via __dirname at runtime — must be copied alongside
// their .ts counterparts into dist/.
const RESOURCE_FILES = [
  {
    src: path.join(PKG_ROOT, 'src', 'analyzers', 'tools', 'default-exclusions.gitignore'),
    dest: path.join(PKG_ROOT, 'dist', 'analyzers', 'tools', 'default-exclusions.gitignore'),
  },
];

function copyResource({ src, dest }) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

for (const r of RESOURCE_FILES) {
  if (copyResource(r)) {
    console.log(`Copied ${path.relative(PKG_ROOT, r.src)} → ${path.relative(PKG_ROOT, r.dest)}`); // slop-ok: build script
  }
}

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
