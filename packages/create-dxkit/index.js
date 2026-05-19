#!/usr/bin/env node
/**
 * @vyuhlabs/create-dxkit — `npm init @vyuhlabs/dxkit` entry point.
 *
 * Collapses the two-step first install — `npm install --save-dev
 * @vyuhlabs/dxkit && npx vyuh-dxkit init` — into a single command. npm
 * resolves `npm init @scope/name` to `npx @scope/create-name`, so this
 * shim runs in the customer's cwd with their command-line args.
 *
 * Responsibilities, in order:
 *   1. Seed a minimal `package.json` if the cwd doesn't have one
 *      (else `npm install --save-dev` would write to the global one).
 *   2. Run `npm install --save-dev @vyuhlabs/dxkit`. On peer-dep
 *      ERESOLVE, retry once with `--legacy-peer-deps`.
 *   3. Forward the user's args (or `--full --yes` if none) to
 *      `vyuh-dxkit init`.
 *
 * Zero runtime dependencies — keeps the install surface as narrow as
 * possible so a customer hitting this for the first time doesn't pull
 * a transitive that conflicts with their tree.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Pure helpers (exported for unit tests) ──────────────────────────

/**
 * The args we forward to `vyuh-dxkit init`. When the user passed
 * nothing, fall back to `--full --yes` — the "I just want everything"
 * default that matches the highest-leverage first-install case.
 */
function resolveInitArgs(argv) {
  const userArgs = argv.slice(2);
  return userArgs.length > 0 ? userArgs : ['--full', '--yes'];
}

/**
 * Seed a minimal package.json when missing. `npm install --save-dev`
 * needs SOMETHING to write the entry into; without this, npm walks up
 * to the parent dir or refuses outright depending on version.
 *
 * Returns `{ seeded: true }` when we wrote a file, `{ seeded: false }`
 * when an existing package.json was already present.
 */
function ensurePackageJson(cwd, fsMod = fs, pathMod = path) {
  const pkgPath = pathMod.join(cwd, 'package.json');
  if (fsMod.existsSync(pkgPath)) return { seeded: false };
  const seeded = {
    name:
      pathMod
        .basename(cwd)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-') || 'dxkit-project',
    private: true,
    version: '0.0.0',
  };
  fsMod.writeFileSync(pkgPath, JSON.stringify(seeded, null, 2) + '\n');
  return { seeded: true };
}

/** Platform-aware `npm` / `npx` binary names — npm/npx ship as .cmd on Windows. */
function npmBin(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}
function npxBin(platform = process.platform) {
  return platform === 'win32' ? 'npx.cmd' : 'npx';
}

module.exports = { resolveInitArgs, ensurePackageJson, npmBin, npxBin };

// ── Entry point ─────────────────────────────────────────────────────

if (require.main === module) {
  const cwd = process.cwd();
  const initArgs = resolveInitArgs(process.argv);

  const seedResult = ensurePackageJson(cwd);
  if (seedResult.seeded) {
    console.log(`Seeded minimal package.json in ${cwd}.`); // slop-ok
  }

  function run(cmd, args) {
    return spawnSync(cmd, args, { stdio: 'inherit', shell: false }).status;
  }

  console.log('Installing @vyuhlabs/dxkit as devDependency...'); // slop-ok
  let rc = run(npmBin(), ['install', '--save-dev', '@vyuhlabs/dxkit']);
  if (rc !== 0) {
    console.log('Retrying with --legacy-peer-deps...'); // slop-ok
    rc = run(npmBin(), ['install', '--save-dev', '@vyuhlabs/dxkit', '--legacy-peer-deps']);
  }
  if (rc !== 0) {
    const failMsg =
      'Could not install @vyuhlabs/dxkit. Resolve the npm error above (try clearing your npm cache or fixing peer-dep conflicts in package.json), then re-run.';
    console.error(failMsg); // slop-ok: zero-dep shim has no logger module to delegate to
    process.exit(rc ?? 1);
  }

  console.log(`Running: vyuh-dxkit init ${initArgs.join(' ')}`); // slop-ok
  const initRc = run(npxBin(), ['vyuh-dxkit', 'init', ...initArgs]);
  process.exit(initRc ?? 0);
}
