/**
 * @vyuhlabs/create-dxkit — pure helpers for the bootstrap shim.
 *
 * Everything here is side-effect-free (or filesystem-injectable) and
 * unit-tested via `test/create-dxkit.test.ts`; the entry-point
 * orchestration lives in `index.js`, integration-tested as a child
 * process via `test/create-dxkit-entrypoint.test.ts`. Zero runtime
 * dependencies — see the rationale in `index.js`.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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
  PKG,
  ONE_SHOT_INIT,
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
