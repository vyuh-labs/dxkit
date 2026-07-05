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
 *      (else the dev-dep install would write to the global one).
 *   2. Detect the repo's package manager from its lockfile (pnpm / yarn
 *      / bun / npm) and add `@vyuhlabs/dxkit` as a devDependency with
 *      THAT PM — running `npm install` in a pnpm repo crashes npm. On an
 *      npm peer-dep ERESOLVE, retry once with `--legacy-peer-deps`.
 *   3. Forward the user's args (or `--full --yes` if none) to
 *      `vyuh-dxkit init`.
 *
 * Zero runtime dependencies — keeps the install surface as narrow as
 * possible so a customer hitting this for the first time doesn't pull
 * a transitive that conflicts with their tree. That is also why the
 * package-manager detection is a small self-contained copy of
 * `src/package-manager.ts` rather than an import: this shim is a
 * separate published package and cannot depend on the main one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** The package this bootstrap installs. */
const PKG = '@vyuhlabs/dxkit';

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

/**
 * Detect the repo's package manager — lockfile first (it reflects what actually
 * provisioned node_modules), then the `packageManager` field (corepack), else
 * npm. Self-contained copy of `src/package-manager.ts:detectPackageManager`
 * (this shim can't import from the main package). `fsMod`/`pathMod` are
 * injectable for unit tests.
 */
function detectPackageManager(cwd, fsMod = fs, pathMod = path) {
  const has = (f) => fsMod.existsSync(pathMod.join(cwd, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('package-lock.json')) return 'npm';
  try {
    const pkg = JSON.parse(fsMod.readFileSync(pathMod.join(cwd, 'package.json'), 'utf8'));
    if (typeof pkg.packageManager === 'string') {
      const name = pkg.packageManager.split('@')[0].trim();
      if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
    }
  } catch {
    // no/invalid package.json → fall through to npm
  }
  return 'npm';
}

/** Platform-aware executable name for a package manager. The JS PMs ship as
 *  `.cmd` shims on Windows; bun ships as `bun.exe`. */
function pmBin(pm, platform = process.platform) {
  if (platform !== 'win32') return pm;
  return pm === 'bun' ? 'bun.exe' : `${pm}.cmd`;
}

/**
 * The args that add `@vyuhlabs/dxkit` as a devDependency with the given PM.
 * `--no-audit` (npm) suppresses the host project's vuln tally mid-install —
 * those numbers describe the customer's own deps, not anything dxkit added.
 */
function installArgs(pm) {
  switch (pm) {
    case 'pnpm':
      return ['add', '-D', PKG];
    case 'yarn':
      return ['add', '-D', PKG];
    case 'bun':
      return ['add', '-d', PKG];
    default:
      return ['install', '--save-dev', '--no-audit', PKG];
  }
}

/**
 * Persist `legacy-peer-deps=true` to `.npmrc` when the fallback install
 * had to be used. Without this, the customer's next `npm install` (any
 * `npm install <new-pkg>`) re-hits the same peer-dep ERESOLVE we just
 * worked around — only this time WE aren't in the loop to recover.
 *
 * Idempotent: skips if the line is already present. Append-or-create
 * — preserves any other settings the customer already had.
 */
function persistLegacyPeerDeps(cwd, fsMod = fs, pathMod = path) {
  const npmrcPath = pathMod.join(cwd, '.npmrc');
  const line = 'legacy-peer-deps=true';
  let existing = '';
  if (fsMod.existsSync(npmrcPath)) {
    existing = fsMod.readFileSync(npmrcPath, 'utf8');
    if (existing.split('\n').some((l) => l.trim() === line)) {
      return { changed: false, reason: 'already-present' };
    }
    if (existing.length > 0 && !existing.endsWith('\n')) existing += '\n';
  }
  fsMod.writeFileSync(npmrcPath, existing + line + '\n');
  return { changed: true, reason: existing ? 'appended' : 'created' };
}

/**
 * Extract npm's "complete log of this run" debug-log path from captured
 * npm output. Modern npm routes ERESOLVE / registry / auth detail to a
 * `_logs/*-debug-0.log` file and emits only a one-line pointer to
 * stderr — so this path is where the real failure cause lives. Matches
 * both the new `npm error ...` and legacy `npm ERR! ...` prefixes, and
 * tolerates Windows paths.
 *
 * Returns the last match (npm prints the pointer last) or null.
 */
function extractNpmLogPath(text) {
  if (!text) return null;
  const re = /complete log of this run can be found in:\s*(.+)$/gim;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1].trim();
  }
  return last;
}

/**
 * Build the failure message shown when BOTH install attempts fail.
 *
 * Pure + exported so its content is unit-testable. The screenshotted
 * customer failure showed "Resolve the npm error above" with nothing
 * above — because the captured stderr was empty (npm put the detail in
 * its log file). This message never claims the error is "above": it
 * surfaces whatever stderr we captured, ALWAYS points at the npm debug
 * log when one is named, and offers the npx-init escape hatch that
 * doesn't need a successful `npm install` at all.
 *
 * @param {{ stderrChunks?: string[], pm?: string }} opts
 */
function formatInstallFailure(opts = {}) {
  const stderrChunks = (opts.stderrChunks || []).filter((s) => s && s.length > 0);
  const pm = opts.pm || 'npm';
  const lines = [];

  const combined = stderrChunks.join('\n');
  if (combined.length > 0) {
    lines.push(`${pm} reported:`);
    lines.push(combined.trimEnd());
    lines.push('');
  }

  // Only npm routes its failure detail to a `_logs/*-debug.log` and prints a
  // "complete log of this run" pointer; the other PMs surface the cause on
  // stderr directly (already shown above).
  if (pm === 'npm') {
    const logPath = extractNpmLogPath(combined);
    if (logPath) {
      lines.push(`Full npm error log: ${logPath}`);
    } else {
      lines.push(
        'npm wrote the failure detail to its debug log — see the ' +
          '"complete log of this run" path npm printed above, under ' +
          'your npm cache `_logs/` directory.',
      );
    }
    lines.push('');
  }
  lines.push('Could not install @vyuhlabs/dxkit. Common causes:');
  lines.push('  • a private-registry auth or proxy issue (check the log above),');
  lines.push("  • an unresolved peer-dep conflict in this folder's package.json,");
  lines.push('  • running in a wrapper directory rather than your actual project.');
  lines.push('');
  lines.push('You do NOT need this install to use dxkit. From your project root run:');
  lines.push('  npx vyuh-dxkit init --full --yes');
  lines.push(
    'That scaffolds dxkit directly (the same step this bootstrap runs after ' +
      'install) without adding it to package.json.',
  );
  return lines.join('\n');
}

module.exports = {
  resolveInitArgs,
  ensurePackageJson,
  npmBin,
  npxBin,
  detectPackageManager,
  pmBin,
  installArgs,
  persistLegacyPeerDeps,
  extractNpmLogPath,
  formatInstallFailure,
};

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

  // Quiet variant: streams stdout (so the customer sees progress) but
  // captures stderr. Used for attempt 1 so npm's multi-line ERESOLVE
  // wall doesn't print on screen before the fallback retry succeeds.
  function runCaptureStderr(cmd, args) {
    return spawnSync(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], shell: false });
  }

  // Detect the repo's package manager from its lockfile and install with THAT
  // PM — `npm install` in a pnpm repo crashes npm ("Cannot read properties of
  // null"). The dev-dep add args (`--no-audit` etc.) come from `installArgs`.
  const pm = detectPackageManager(cwd);
  const addArgs = installArgs(pm);

  console.log(`Installing ${PKG} as a devDependency with ${pm}...`); // slop-ok

  // Attempt 1: strict resolution. On a clean tree this works in one shot; on a
  // non-trivial npm repo there's often a peer-dep mismatch (eslint 8↔10, react
  // cross-pkg, etc.) that fails here — hence the legacy-peer-deps retry below.
  const attempt1 = runCaptureStderr(pmBin(pm), addArgs);
  let rc = attempt1.status;
  let usedLegacy = false;
  let attempt2 = null;

  // The `--legacy-peer-deps` retry is npm-specific — pnpm / yarn / bun are
  // lenient on peer deps by default, so a failure there is a real error, not a
  // strictness knob to relax.
  if (rc !== 0 && pm === 'npm') {
    console.log('Peer-dep conflict detected. Retrying with --legacy-peer-deps...'); // slop-ok
    // Capture stderr here too, so a second failure surfaces the real cause
    // (including the npm debug-log path) rather than an empty error wall.
    attempt2 = runCaptureStderr(pmBin(pm), [...addArgs, '--legacy-peer-deps']);
    rc = attempt2.status;
    usedLegacy = true;
  }

  if (rc !== 0) {
    // Both attempts failed. Surface every captured stderr + (for npm) the
    // debug-log path, and offer the npx-init escape hatch that needs no
    // successful install. See `formatInstallFailure`.
    const toStr = (b) => (b ? b.toString() : '');
    process.stderr.write(
      '\n' +
        formatInstallFailure({
          stderrChunks: [toStr(attempt1.stderr), attempt2 ? toStr(attempt2.stderr) : ''],
          pm,
        }) +
        '\n',
    );
    process.exit(rc ?? 1);
  }

  // Install succeeded. If we had to fall back to --legacy-peer-deps (npm only),
  // persist that choice so the customer's next `npm install` doesn't re-hit the
  // same ERESOLVE wall without us in the loop to recover.
  if (usedLegacy) {
    const result = persistLegacyPeerDeps(cwd);
    if (result.changed) {
      console.log(`Persisted legacy-peer-deps=true to .npmrc (${result.reason}).`); // slop-ok
    }
  }

  console.log(`Running: vyuh-dxkit init ${initArgs.join(' ')}`); // slop-ok
  const initRc = run(npxBin(), ['vyuh-dxkit', 'init', ...initArgs]);
  process.exit(initRc ?? 0);
}
