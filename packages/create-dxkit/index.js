#!/usr/bin/env node
/**
 * @vyuhlabs/create-dxkit — `npm init @vyuhlabs/dxkit` entry point.
 *
 * Collapses the two-step first install — `npm install --save-dev
 * @vyuhlabs/dxkit`, then the CLI's `init` — into a single command. npm
 * resolves `npm init @scope/name` to `npx @scope/create-name`, so this
 * shim runs in the customer's cwd with their command-line args.
 *
 * Responsibilities, in order:
 *   1. Refuse to run in a home directory or filesystem root — a user
 *      who skipped the `cd <your-repo>` step would otherwise get a
 *      package.json seeded into their home folder (shipped once, found
 *      in the field).
 *   2. Seed a minimal `package.json` if the cwd doesn't have one
 *      (else the dev-dep install would write to the global one).
 *   3. Detect the repo's package manager from its lockfile (pnpm / yarn
 *      / bun / npm) and add `@vyuhlabs/dxkit` as a devDependency with
 *      THAT PM — running `npm install` in a pnpm repo crashes npm. On an
 *      npm install failure, retry once with `--legacy-peer-deps`.
 *   4. Forward the user's args (or `--full --yes` if none) to
 *      `vyuh-dxkit init`.
 *
 * Windows spawning (load-bearing): Node's CVE-2024-27980 fix (18.20.2 /
 * 20.12.2 / 21.7.3, April 2024) makes spawning a `.cmd`/`.bat` with
 * `shell: false` throw EINVAL — so the old `spawnSync('npm.cmd', …)`
 * approach could NEVER succeed on a current Node on Windows, and the
 * un-checked `.error` read as a phantom "peer-dep conflict" with empty
 * stderr (the shipped failure this rewrite fixes). `installSpawnPlan`
 * in `lib.js` owns the safe plan; the post-install `init` step spawns
 * the freshly-installed package's own bin JS via `process.execPath` —
 * no npx, no `.cmd`, no shell.
 *
 * Zero runtime dependencies — keeps the install surface as narrow as
 * possible so a customer hitting this for the first time doesn't pull
 * a transitive that conflicts with their tree. That is also why the
 * package-manager detection in `lib.js` is a small self-contained copy
 * of `src/package-manager.ts` rather than an import: this shim is a
 * separate published package and cannot depend on the main one.
 */
'use strict';

const { spawnSync } = require('child_process');
const lib = require('./lib');
const {
  PKG,
  ONE_SHOT_INIT,
  resolveInitArgs,
  refuseCwdReason,
  ensurePackageJson,
  detectPackageManager,
  windowsQuoteArg,
  installSpawnPlan,
  installArgs,
  resolveInstalledBin,
  persistLegacyPeerDeps,
  formatInstallFailure,
} = lib;

// Re-export the pure helpers so tests (and any tooling) can keep
// requiring the package entry.
module.exports = lib;

// ── Entry point ─────────────────────────────────────────────────────

if (require.main === module) {
  const cwd = process.cwd();
  const initArgs = resolveInitArgs(process.argv);

  const refusal = refuseCwdReason(cwd);
  if (refusal) {
    process.stderr.write('\n' + refusal + '\n');
    process.exit(1);
  }

  const seedResult = ensurePackageJson(cwd);
  if (seedResult.seeded) {
    console.log(`Seeded minimal package.json in ${cwd}.`); // slop-ok
  }

  // Quiet variant: streams stdout (so the customer sees progress) but
  // captures stderr. Used for the install attempts so npm's multi-line
  // ERESOLVE wall doesn't print on screen before the fallback retry succeeds.
  function runCaptureStderr(plan) {
    return spawnSync(plan.cmd, plan.args, {
      stdio: ['inherit', 'inherit', 'pipe'],
      shell: plan.shell,
    });
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
  const attempt1 = runCaptureStderr(installSpawnPlan(pm, addArgs));
  let rc = attempt1.status;
  let usedLegacy = false;
  let attempt2 = null;

  if (attempt1.error) {
    // The PM never ran (spawn-level failure). Retrying would EINVAL/ENOENT
    // identically — bail with the honest cause instead of a peer-dep guess.
    process.stderr.write('\n' + formatInstallFailure({ pm, spawnError: attempt1.error }) + '\n');
    process.exit(1);
  }

  // The `--legacy-peer-deps` retry is npm-specific — pnpm / yarn / bun are
  // lenient on peer deps by default, so a failure there is a real error, not a
  // strictness knob to relax.
  if (rc !== 0 && pm === 'npm') {
    // We don't know yet WHY npm failed (the detail is in its debug log) —
    // peer-dep strictness is just the most common recoverable cause, so try
    // the relaxed mode once before reporting.
    console.log(`npm install failed (exit ${rc}). Retrying with --legacy-peer-deps...`); // slop-ok
    // Capture stderr here too, so a second failure surfaces the real cause
    // (including the npm debug-log path) rather than an empty error wall.
    attempt2 = runCaptureStderr(installSpawnPlan(pm, [...addArgs, '--legacy-peer-deps']));
    rc = attempt2.status;
    usedLegacy = true;
    if (attempt2.error) {
      process.stderr.write('\n' + formatInstallFailure({ pm, spawnError: attempt2.error }) + '\n');
      process.exit(1);
    }
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
  // Run the freshly-installed CLI's bin JS with node directly — immune to
  // the Windows `.cmd`+`shell:false` EINVAL class and needs no npx
  // resolution. Fall back to one-shot npx BY PACKAGE NAME (never the bare
  // binary name, which only resolves through an install).
  const binJs = resolveInstalledBin(cwd);
  let initResult;
  if (binJs) {
    initResult = spawnSync(process.execPath, [binJs, 'init', ...initArgs], {
      stdio: 'inherit',
      shell: false,
    });
  } else {
    const plan = installSpawnPlan('npm', [], process.env, process.platform);
    const npxViaNode = plan.cmd === process.execPath;
    initResult = npxViaNode
      ? spawnSync(
          process.execPath,
          [
            plan.args[0],
            'exec',
            '--yes',
            '--package',
            PKG,
            '--',
            'vyuh-dxkit',
            'init',
            ...initArgs,
          ],
          { stdio: 'inherit', shell: false },
        )
      : spawnSync(
          'npx',
          ['-y', '--package', PKG, 'vyuh-dxkit', 'init', ...initArgs].map(windowsQuoteArg),
          { stdio: 'inherit', shell: process.platform === 'win32' },
        );
  }
  if (initResult.error) {
    process.stderr.write(
      `\nCould not launch vyuh-dxkit init (${initResult.error.code || initResult.error.message}).\n` +
        `The install itself succeeded — finish setup from your project root with:\n  ${ONE_SHOT_INIT}\n`,
    );
    process.exit(1);
  }
  process.exit(initResult.status ?? 0);
}
