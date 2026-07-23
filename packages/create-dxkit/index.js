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
 * stderr (the shipped failure this rewrite fixes). The order of
 * preference now:
 *   - npm: spawn `process.execPath <npm_execpath> …` — npm always sets
 *     `npm_execpath` for scripts it launches (this shim runs via
 *     npm init/npx), and a plain JS entry needs no shell on any OS.
 *   - other PMs on Windows: `shell: true` with each arg quoted (the args
 *     are our own constants, quoted defensively anyway).
 *   - everything else: plain direct spawn.
 * The post-install `init` step spawns the freshly-installed package's
 * own bin JS via `process.execPath` — no npx, no `.cmd`, no shell.
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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** The package this bootstrap installs. */
const PKG = '@vyuhlabs/dxkit';

/**
 * The PRE-INSTALL escape hatch shown when the dev-dep install fails: a
 * one-shot npx invocation by PACKAGE name. It must NOT invoke the bare
 * `vyuh-dxkit` binary name — that resolves only through an installed
 * package, which is exactly what just failed, so it would 404 (the main
 * repo's Rule 14 class; this file is grepped by the same arch check).
 */
const ONE_SHOT_INIT = `npx -y ${PKG} init --full --yes`;

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
 * Refuse to scaffold in a directory that is clearly not a project: the
 * user's home directory or a filesystem root. The demo's next-steps say
 * `cd <your-repo>` but users skim — running from `C:\Users\<name>` would
 * seed a package.json into their home folder and then install into it.
 * Returns a human-readable reason, or null when the cwd is acceptable.
 * Windows paths compare case-insensitively.
 */
function refuseCwdReason(cwd, homeDir = os.homedir(), platform = process.platform) {
  const norm = (p) => {
    const r = path.resolve(p);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(cwd);
  if (homeDir && c === norm(homeDir)) {
    return (
      `This is your home directory (${path.resolve(cwd)}), not a project.\n` +
      'cd into the repository you want to gate, then re-run this command.\n' +
      'Nothing was written.'
    );
  }
  if (c === norm(path.parse(c).root)) {
    return (
      `This is the filesystem root (${path.resolve(cwd)}), not a project.\n` +
      'cd into the repository you want to gate, then re-run this command.\n' +
      'Nothing was written.'
    );
  }
  return null;
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
 *  `.cmd` shims on Windows; bun ships as `bun.exe`. Only used on the
 *  `shell: true` Windows path — see `installSpawnPlan`. */
function pmBin(pm, platform = process.platform) {
  if (platform !== 'win32') return pm;
  return pm === 'bun' ? 'bun.exe' : `${pm}.cmd`;
}

/** Quote one argument for a Windows `shell: true` spawn (cmd.exe). Our own
 *  install args are constants, but quote defensively — Node does NOT quote
 *  args it joins for a shell spawn. */
function windowsQuoteArg(arg) {
  if (/^[A-Za-z0-9_@/.:=+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * How to actually spawn the package manager — the CVE-2024-27980-safe plan.
 *
 *   - npm with `npm_execpath` pointing at a JS entry (always true when this
 *     shim runs via npm init / npx): spawn node itself on that entry. No
 *     `.cmd`, no shell, works on every OS and every Node.
 *   - anything else on Windows: `shell: true` (spawning a `.cmd` with
 *     `shell: false` throws EINVAL on patched Node) with args pre-quoted.
 *   - anything else elsewhere: plain direct spawn.
 *
 * Returns `{ cmd, args, shell }` ready for spawnSync.
 */
function installSpawnPlan(pm, pmArgs, env = process.env, platform = process.platform) {
  const execpath = env.npm_execpath;
  if (pm === 'npm' && typeof execpath === 'string' && /\.[cm]?js$/.test(execpath)) {
    return { cmd: process.execPath, args: [execpath, ...pmArgs], shell: false };
  }
  if (platform === 'win32') {
    return { cmd: pmBin(pm, platform), args: pmArgs.map(windowsQuoteArg), shell: true };
  }
  return { cmd: pm, args: pmArgs, shell: false };
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
 * Resolve the freshly-installed package's bin entry to a JS path we can
 * run with `process.execPath` — no npx, no `.cmd` shim, no shell, so the
 * init step cannot re-hit the Windows spawn class the install step just
 * avoided. Returns null when the package (or its bin) can't be resolved;
 * the caller falls back to a one-shot npx by package name.
 */
function resolveInstalledBin(cwd, requireResolve = require.resolve, fsMod = fs) {
  // Direct node_modules path FIRST: the install we just ran put the package
  // at <cwd>/node_modules (a symlink under pnpm — fs reads through it), and
  // this route is immune to the package's `exports` map, which does not have
  // to expose `./package.json` for require.resolve subpath resolution.
  const candidates = [path.join(cwd, 'node_modules', PKG, 'package.json')];
  try {
    candidates.push(requireResolve(`${PKG}/package.json`, { paths: [cwd] }));
  } catch {
    // exports-restricted or unresolvable — the direct path may still work
  }
  for (const pkgJsonPath of candidates) {
    try {
      const pkgJson = JSON.parse(fsMod.readFileSync(pkgJsonPath, 'utf8'));
      const bin = pkgJson.bin && pkgJson.bin['vyuh-dxkit'];
      if (typeof bin !== 'string') continue;
      const binPath = path.resolve(path.dirname(pkgJsonPath), bin);
      if (fsMod.existsSync(binPath)) return binPath;
    } catch {
      // unreadable candidate — try the next
    }
  }
  return null;
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
 * Build the failure message shown when the install could not complete.
 *
 * Pure + exported so its content is unit-testable. Two distinct shapes:
 *
 *   - `spawnError` set: the package manager never RAN (spawn-level failure —
 *     EINVAL, ENOENT). Say exactly that; there is no npm log to point at and
 *     no peer-dep story to tell. The previous version read this case as a
 *     "peer-dep conflict" with empty stderr — a fabricated diagnosis that
 *     shipped and was caught in the field.
 *   - otherwise: the PM ran and exited non-zero. Surface whatever stderr we
 *     captured, ALWAYS point at the npm debug log when one is named, and
 *     list the real common causes.
 *
 * Both shapes end with the one-shot npx escape hatch, which needs no
 * successful `npm install` at all (package form — the binary form would
 * 404 in exactly this situation).
 *
 * @param {{ stderrChunks?: string[], pm?: string, spawnError?: Error }} opts
 */
function formatInstallFailure(opts = {}) {
  const stderrChunks = (opts.stderrChunks || []).filter((s) => s && s.length > 0);
  const pm = opts.pm || 'npm';
  const lines = [];

  if (opts.spawnError) {
    lines.push(
      `Could not launch ${pm} at all (${opts.spawnError.code || opts.spawnError.message}).`,
    );
    lines.push(`${pm} never ran, so there is no install error to debug — the problem is`);
    lines.push(`launching ${pm} from this environment (PATH, or a Node/npm installation issue).`);
    lines.push('');
  } else {
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
    lines.push(`Could not install ${PKG}. Common causes:`);
    lines.push('  • a private-registry auth or proxy issue (check the log above),');
    lines.push("  • an unresolved peer-dep conflict in this folder's package.json,");
    lines.push('  • running in a wrapper directory rather than your actual project.');
    lines.push('');
  }
  lines.push('You do NOT need this install to use dxkit. From your project root run:');
  lines.push(`  ${ONE_SHOT_INIT}`);
  lines.push(
    'That scaffolds dxkit directly (the same step this bootstrap runs after ' +
      'install) without adding it to package.json.',
  );
  return lines.join('\n');
}

module.exports = {
  resolveInitArgs,
  refuseCwdReason,
  ensurePackageJson,
  detectPackageManager,
  pmBin,
  windowsQuoteArg,
  installSpawnPlan,
  installArgs,
  resolveInstalledBin,
  persistLegacyPeerDeps,
  extractNpmLogPath,
  formatInstallFailure,
};

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
