/**
 * Phase Ship installers — additive copy of dxkit's guardrail templates
 * into a consumer repo. Wired into `vyuh-dxkit init` via the
 * `--with-hooks` / `--with-devcontainer` / `--with-ci` /
 * `--with-baseline-refresh` flags (or `--full` which implies all).
 *
 * Each installer is additive by default: existing consumer files are
 * never overwritten. When a conflict is detected, the installer
 * writes a sidecar (`.dxkit`-suffixed) reference file and emits a
 * note with merge instructions. `force: true` bypasses the sidecar
 * fallback and overwrites in place.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { makeExecutable } from './files';

/**
 * Detect the consumer repo's default branch so workflow templates
 * that fire on pushes to "the main branch" point at the right name.
 * The resolution order is intentionally lenient — we'd rather
 * substitute *some* sensible branch and let the consumer edit the
 * workflow than refuse to install when git state is incomplete.
 *
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` (set whenever the
 *      repo was cloned from a remote with a default-branch HEAD)
 *   2. `git rev-parse --verify <name>` against `main` / `master` /
 *      `trunk` / `develop` — the four conventions that cover ~all
 *      real repos
 *   3. The current branch (`git branch --show-current`) — the best
 *      guess in a freshly-`git init`'d repo that hasn't been pushed
 *   4. Fallback to `'main'` — the GitHub default-branch default
 */
export function detectDefaultBranch(cwd: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match && match[1]) return match[1];
  } catch {
    /* fall through */
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', candidate], {
        cwd,
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      /* try next */
    }
  }
  try {
    const current = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (current) return current;
  } catch {
    /* fall through */
  }
  return 'main';
}

export interface ShipInstallResult {
  /** Relative paths (from cwd) of files newly written to the consumer repo. */
  installed: string[];
  /** Relative paths the installer left alone because the consumer already had them. */
  skipped: string[];
  /** Sidecar paths emitted when a conflict was detected (foo.dxkit form). */
  sidecars: string[];
  /** Human-readable merge instructions. Surfaced by the CLI summary. */
  notes: string[];
}

interface InstallerOpts {
  /** Overwrite consumer files in place rather than emitting sidecars. */
  readonly force?: boolean;
  /**
   * Install the pre-commit hook in addition to pre-push.
   *
   * Default off: pre-commit re-runs every analyzer on the full repo
   * (no incremental scope yet), which makes it slow on large
   * codebases (~3 min on a 500-file repo). Pre-push is faster to
   * tolerate because it fires once per push regardless of how many
   * commits batch up.
   *
   * Customers who want commit-time gating (e.g. on small repos where
   * the scan is fast) can opt in with `--with-precommit-hook`.
   * Incremental scoped scanning lands in a future phase; the trade-
   * off goes away then.
   */
  readonly withPrecommit?: boolean;
}

function emptyResult(): ShipInstallResult {
  return { installed: [], skipped: [], sidecars: [], notes: [] };
}

function templatesDir(): string {
  return path.join(__dirname, '..', 'templates');
}

/**
 * Copy a single source file to a destination, handling the
 * additive-vs-force decision. Returns the (relative) path that was
 * written + which bucket it lands in.
 */
function copyAdditive(
  srcAbs: string,
  destAbs: string,
  cwd: string,
  opts: InstallerOpts,
  result: ShipInstallResult,
  options: { executable?: boolean; sidecarSuffix?: string } = {},
): void {
  const relDest = path.relative(cwd, destAbs);
  const exists = fs.existsSync(destAbs);

  if (exists && !opts.force) {
    const suffix = options.sidecarSuffix ?? '.dxkit';
    const sidecarAbs = destAbs + suffix;
    const relSidecar = path.relative(cwd, sidecarAbs);
    fs.mkdirSync(path.dirname(sidecarAbs), { recursive: true });
    fs.copyFileSync(srcAbs, sidecarAbs);
    if (options.executable) makeExecutable(sidecarAbs);
    result.sidecars.push(relSidecar);
    return;
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  if (options.executable) makeExecutable(destAbs);
  if (exists) {
    result.installed.push(relDest);
  } else {
    result.installed.push(relDest);
  }
}

/**
 * Hooks installer. Writes `.githooks/pre-push` by default;
 * additionally writes `.githooks/pre-commit` when
 * `opts.withPrecommit === true`. When the consumer already has a
 * matching hook (via .githooks/ or .husky/), emits a `.dxkit`
 * sidecar instead and prints merge instructions.
 *
 * Customer still needs to run `git config core.hooksPath .githooks`
 * to activate. We don't run it for them — that's a global git config
 * mutation outside dxkit's purview.
 *
 * Why pre-commit is opt-in: see `InstallerOpts.withPrecommit`.
 */
export function installHooks(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = emptyResult();
  const tmplDir = path.join(templatesDir(), '.githooks');
  const destDir = path.join(cwd, '.githooks');

  // Husky users have hooks at `.husky/<name>`. We treat either an
  // existing `.githooks/<name>` *or* `.husky/<name>` as a conflict —
  // both routes mean the consumer already has an active hook, even
  // though only the .githooks/ path is the destination we write to.
  //
  // pre-commit is opt-in (slow on large repos until incremental
  // scanning lands); pre-push always installs (acceptable cost).
  const hookNames: Array<{ name: 'pre-commit' | 'pre-push' }> = opts.withPrecommit
    ? [{ name: 'pre-commit' }, { name: 'pre-push' }]
    : [{ name: 'pre-push' }];
  let anyConflict = false;

  for (const { name } of hookNames) {
    const destAbs = path.join(destDir, name);
    const huskyAbs = path.join(cwd, '.husky', name);
    const conflict = fs.existsSync(destAbs) || fs.existsSync(huskyAbs);
    if (conflict) anyConflict = true;

    const srcAbs = path.join(tmplDir, name);
    if (conflict && !opts.force) {
      // Always land the dxkit hook at .githooks/<name>.dxkit when
      // there's a conflict, even when the conflict is at a different
      // path (husky). The sidecar is the same regardless of where the
      // existing hook lives, and the merge note tells the consumer
      // how to chain them.
      const sidecarAbs = destAbs + '.dxkit';
      fs.mkdirSync(path.dirname(sidecarAbs), { recursive: true });
      fs.copyFileSync(srcAbs, sidecarAbs);
      makeExecutable(sidecarAbs);
      result.sidecars.push(path.relative(cwd, sidecarAbs));
    } else {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      makeExecutable(destAbs);
      result.installed.push(path.relative(cwd, destAbs));
    }
  }

  if (anyConflict) {
    result.notes.push(
      'Detected an existing pre-commit/pre-push hook. The dxkit hooks were ' +
        'written as `.dxkit` sidecars next to your existing hooks; add a ' +
        '`sh .githooks/<name>.dxkit` line to each existing hook to chain them.',
    );
  }
  result.notes.push(
    'Activate the hooks: `git config core.hooksPath .githooks` (one-time, per clone).',
  );
  if (!opts.withPrecommit) {
    result.notes.push(
      'pre-commit hook NOT installed (default). The full guardrail re-runs every analyzer ' +
        'and is slow on large repos. Pre-push catches the same regressions before code leaves ' +
        'the machine. Re-run init with `--with-precommit-hook` to enable commit-time gating.',
    );
  }

  return result;
}

/**
 * Devcontainer installer. Writes the dxkit lightweight devcontainer
 * (devcontainer.json + post-create.sh + install-agent-clis.sh) into
 * `.devcontainer/`. If the consumer already has a devcontainer.json,
 * writes the entire dxkit set into `.devcontainer/.dxkit-reference/`
 * for manual merge.
 */
export function installDevcontainer(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = emptyResult();
  const tmplDir = path.join(templatesDir(), '.devcontainer');
  const destDir = path.join(cwd, '.devcontainer');
  const filesToInstall = [
    { name: 'devcontainer.json', executable: false },
    { name: 'post-create.sh', executable: true },
    { name: 'install-agent-clis.sh', executable: true },
  ];

  const hasExistingDevcontainer = fs.existsSync(path.join(destDir, 'devcontainer.json'));

  if (hasExistingDevcontainer && !opts.force) {
    // Stash the whole dxkit set under a reference dir so the
    // consumer can read it without it interfering with their own.
    const refDir = path.join(destDir, '.dxkit-reference');
    fs.mkdirSync(refDir, { recursive: true });
    for (const f of filesToInstall) {
      const srcAbs = path.join(tmplDir, f.name);
      const destAbs = path.join(refDir, f.name);
      fs.copyFileSync(srcAbs, destAbs);
      if (f.executable) makeExecutable(destAbs);
      result.sidecars.push(path.relative(cwd, destAbs));
    }
    result.notes.push(
      'Existing devcontainer.json detected — dxkit pieces stashed in ' +
        '`.devcontainer/.dxkit-reference/`. To enable dxkit guardrails in ' +
        'your container: (1) merge the `features` block from the reference ' +
        'devcontainer.json into yours, (2) add `bash .devcontainer/post-create.sh` ' +
        'to your `postCreateCommand`, (3) copy `post-create.sh` and ' +
        '`install-agent-clis.sh` into `.devcontainer/`.',
    );
    return result;
  }

  for (const f of filesToInstall) {
    copyAdditive(
      path.join(tmplDir, f.name),
      path.join(destDir, f.name),
      cwd,
      { force: true },
      result,
      { executable: f.executable },
    );
  }
  return result;
}

/**
 * Generic workflow installer used by both --with-ci (PR-gate) and
 * --with-baseline-refresh (post-merge auto-regen). Both targets are
 * uniquely-named workflow files; conflict only happens on a re-run
 * against an existing dxkit install, which we skip with a note.
 *
 * `substitutions` lets a workflow template carry placeholders the
 * installer fills in at write time. The baseline-refresh workflow
 * uses this for the consumer's default branch name; the PR-gate
 * workflow ships verbatim.
 */
function installWorkflow(
  cwd: string,
  fileName: string,
  opts: InstallerOpts,
  substitutions: Readonly<Record<string, string>> = {},
): ShipInstallResult {
  const result = emptyResult();
  const srcAbs = path.join(templatesDir(), '.github', 'workflows', fileName);
  const destAbs = path.join(cwd, '.github', 'workflows', fileName);

  if (fs.existsSync(destAbs) && !opts.force) {
    result.skipped.push(path.relative(cwd, destAbs));
    return result;
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  if (Object.keys(substitutions).length === 0) {
    fs.copyFileSync(srcAbs, destAbs);
  } else {
    let content = fs.readFileSync(srcAbs, 'utf8');
    for (const [key, value] of Object.entries(substitutions)) {
      content = content.split(key).join(value);
    }
    fs.writeFileSync(destAbs, content, 'utf8');
  }
  result.installed.push(path.relative(cwd, destAbs));
  return result;
}

export function installCiGuardrails(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  return installWorkflow(cwd, 'dxkit-guardrails.yml', opts);
}

export function installCiBaselineRefresh(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const defaultBranch = detectDefaultBranch(cwd);
  const result = installWorkflow(cwd, 'dxkit-baseline-refresh.yml', opts, {
    __DXKIT_DEFAULT_BRANCH__: defaultBranch,
  });
  if (result.installed.length > 0 && defaultBranch !== 'main') {
    result.notes.push(
      `baseline-refresh workflow targets the '${defaultBranch}' branch (detected from your repo). ` +
        `Edit the workflow's \`branches:\` trigger if you want a different one.`,
    );
  }
  return result;
}
