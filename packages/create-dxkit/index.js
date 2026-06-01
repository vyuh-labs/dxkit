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
 * @param {{ stderrChunks?: string[] }} opts
 */
function formatInstallFailure(opts = {}) {
  const stderrChunks = (opts.stderrChunks || []).filter((s) => s && s.length > 0);
  const lines = [];

  const combined = stderrChunks.join('\n');
  if (combined.length > 0) {
    lines.push('npm reported:');
    lines.push(combined.trimEnd());
    lines.push('');
  }

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

  // `--no-audit` keeps npm from printing "N vulnerabilities" at the end of
  // a successful install. Those numbers describe the HOST project's deps,
  // not anything dxkit introduced — surfacing them mid-install made
  // customers think dxkit added them. `vyuh-dxkit vulnerabilities`
  // is the right surface for dep-vuln triage anyway.
  const INSTALL_BASE = ['install', '--save-dev', '--no-audit', '@vyuhlabs/dxkit'];

  console.log('Installing @vyuhlabs/dxkit as devDependency...'); // slop-ok

  // Attempt 1: strict peer-dep resolution. On a clean tree this works in
  // one shot; on most non-trivial customer repos there's at least one
  // peer-dep mismatch (eslint 8↔10, react cross-pkg, etc.) that fails
  // here.
  const attempt1 = runCaptureStderr(npmBin(), INSTALL_BASE);
  let rc = attempt1.status;
  let usedLegacy = false;
  let attempt2 = null;

  if (rc !== 0) {
    console.log('Peer-dep conflict detected. Retrying with --legacy-peer-deps...'); // slop-ok
    // Attempt 2: capture stderr too. The earlier version inherited
    // stderr here, so when this leg failed its npm error was never
    // captured and the customer saw "Resolve the npm error above" with
    // nothing above (D158). Capturing lets us surface the real cause —
    // including the npm debug-log path, where modern npm puts ERESOLVE /
    // registry / auth detail.
    attempt2 = runCaptureStderr(npmBin(), [...INSTALL_BASE, '--legacy-peer-deps']);
    rc = attempt2.status;
    usedLegacy = true;
  }

  if (rc !== 0) {
    // Both attempts failed. Surface every captured stderr + the npm
    // debug-log path, and offer the npx-init escape hatch that needs no
    // successful `npm install`. See `formatInstallFailure`.
    const toStr = (b) => (b ? b.toString() : '');
    process.stderr.write(
      '\n' +
        formatInstallFailure({
          stderrChunks: [toStr(attempt1.stderr), attempt2 ? toStr(attempt2.stderr) : ''],
        }) +
        '\n',
    );
    process.exit(rc ?? 1);
  }

  // Install succeeded. If we had to fall back to --legacy-peer-deps,
  // persist that choice so the customer's next `npm install` doesn't
  // re-hit the same ERESOLVE wall without us in the loop to recover.
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
