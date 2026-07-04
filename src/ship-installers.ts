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
import { detect } from './detect';
import { buildDevcontainerExtensions, buildDevcontainerFeatures } from './languages';
import { VERSION } from './constants';

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
 * Render the per-stack features block as a properly-indented JSON
 * fragment slotted into the template's `"features": __PLACEHOLDER__`
 * line. The first line stays flush; continuation lines get the
 * template's two-space outer indent so the resulting object reads
 * naturally inside the surrounding JSONC.
 */
function renderFeaturesBlock(features: Record<string, Record<string, unknown>>): string {
  const raw = JSON.stringify(features, null, 2);
  return raw
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
}

/**
 * Render the extensions array as a JSON array, indented to line up
 * naturally inside the surrounding JSONC. Mirrors renderFeaturesBlock's
 * shape so the two substitutions produce visually consistent output.
 */
function renderExtensionsBlock(extensions: string[]): string {
  const raw = JSON.stringify(extensions, null, 2);
  return raw
    .split('\n')
    .map((line, i) => (i === 0 ? line : '      ' + line))
    .join('\n');
}

/**
 * Read the devcontainer.json template, substitute the
 * `__DXKIT_DEVCONTAINER_FEATURES__` and `__DXKIT_DEVCONTAINER_EXTENSIONS__`
 * placeholders with the detected stack's per-pack contributions, and
 * return the rendered text. Pure-ish: one filesystem read, no writes.
 */
function renderDevcontainerJson(tmplDir: string, cwd: string): string {
  const srcAbs = path.join(tmplDir, 'devcontainer.json');
  const template = fs.readFileSync(srcAbs, 'utf8');
  const stack = detect(cwd);
  const features = buildDevcontainerFeatures(stack.languages);
  const extensions = buildDevcontainerExtensions(stack.languages);
  return template
    .replace('__DXKIT_DEVCONTAINER_FEATURES__', renderFeaturesBlock(features))
    .replace('__DXKIT_DEVCONTAINER_EXTENSIONS__', renderExtensionsBlock(extensions));
}

/**
 * Devcontainer installer. Writes the dxkit lightweight devcontainer
 * (devcontainer.json + post-create.sh + install-agent-clis.sh) into
 * `.devcontainer/`. If the consumer already has a devcontainer.json,
 * writes the entire dxkit set into `.devcontainer/.dxkit-reference/`
 * for manual merge.
 *
 * devcontainer.json is rendered per-detected-stack: only active
 * packs' features land in the output. Always-on entries (Node +
 * GitHub CLI) ship regardless so the post-create script can run on
 * a non-Node project.
 */
export function installDevcontainer(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = emptyResult();
  const tmplDir = path.join(templatesDir(), '.devcontainer');
  const destDir = path.join(cwd, '.devcontainer');
  const filesToCopyVerbatim = [
    { name: 'post-create.sh', executable: true },
    { name: 'install-agent-clis.sh', executable: true },
  ];

  const hasExistingDevcontainer = fs.existsSync(path.join(destDir, 'devcontainer.json'));

  if (hasExistingDevcontainer && !opts.force) {
    // Stash the whole dxkit set under a reference dir so the
    // consumer can read it without it interfering with their own.
    // The reference devcontainer.json is rendered with the
    // per-stack features so the customer sees the same shape as
    // a fresh install — they can lift the features block directly.
    const refDir = path.join(destDir, '.dxkit-reference');
    fs.mkdirSync(refDir, { recursive: true });
    const renderedJson = renderDevcontainerJson(tmplDir, cwd);
    fs.writeFileSync(path.join(refDir, 'devcontainer.json'), renderedJson, 'utf8');
    result.sidecars.push(path.relative(cwd, path.join(refDir, 'devcontainer.json')));
    for (const f of filesToCopyVerbatim) {
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

  // devcontainer.json gets rendered (per-stack features substitution),
  // the rest are flat copies.
  fs.mkdirSync(destDir, { recursive: true });
  const renderedJson = renderDevcontainerJson(tmplDir, cwd);
  const destDevcontainerJson = path.join(destDir, 'devcontainer.json');
  fs.writeFileSync(destDevcontainerJson, renderedJson, 'utf8');
  result.installed.push(path.relative(cwd, destDevcontainerJson));

  for (const f of filesToCopyVerbatim) {
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

export function installCiDeepSastRefresh(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = installWorkflow(cwd, 'dxkit-deep-sast-refresh.yml', opts);
  if (result.installed.length > 0) {
    result.notes.push(
      'deep-SAST refresh workflow installed. To activate: add a SNYK_TOKEN Actions secret and ' +
        'set deepSast.snyk.{orgId,projectId} in .vyuh-dxkit.json. Without the secret it no-ops.',
    );
  }
  return result;
}

/**
 * AI PR-review workflow installer. Writes
 * `.github/workflows/pr-review.yml` — a workflow that runs Claude
 * Code over a PR's diff and posts a review comment.
 *
 * Opt-in (via `--with-pr-review`) because the workflow needs an
 * `ANTHROPIC_API_KEY` repo secret AND a flipped `ENABLE_AI_REVIEW`
 * repo variable to actually run anything; without both, the
 * workflow file just sits inert in the repo and clutters the
 * Actions tab. Customers who want this should opt in explicitly
 * with the flag (and configure the repo secret + variable
 * separately).
 */
export function installPrReview(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = installWorkflow(cwd, 'pr-review.yml', opts);
  if (result.installed.length > 0) {
    result.notes.push(
      'pr-review.yml is dormant until you configure both: ' +
        '(1) `ANTHROPIC_API_KEY` repo secret, and ' +
        '(2) `ENABLE_AI_REVIEW=true` repo variable.',
    );
  }
  return result;
}

export const GITIGNORE_HEADER = '# dxkit — runtime outputs (analyzer reports + dashboard)';
export const GITIGNORE_ENTRIES = [
  '.dxkit/reports/',
  '.dxkit/dashboard.html',
  '.dxkit/cache/',
  '.dxkit/loop/',
  'graphify-out/',
];

/**
 * Seed `.gitignore` with dxkit's runtime-output paths and write a
 * starter `.dxkit-ignore` template explaining the optional dxkit-
 * specific scan-exclusion file.
 *
 * Concerns the seeded files address:
 *   - `.gitignore`: stops customers from accidentally committing
 *     `.dxkit/reports/*.md` and `.dxkit/dashboard.html` (which
 *     churn on every analyzer run). Selectively keeps
 *     `.dxkit/baselines/` tracked — it IS the guardrail anchor.
 *   - `.dxkit-ignore`: dxkit's own scan-exclusion file. Loaded by
 *     `loadExclusions()` if present; never created by dxkit before
 *     this commit. Seeding a documented template makes the feature
 *     discoverable.
 *
 * Both are additive: existing `.gitignore` entries are preserved
 * (dedup against current contents); existing `.dxkit-ignore` is
 * never overwritten.
 */
export function installIgnoreFiles(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = emptyResult();

  // .gitignore: append runtime-output entries
  const gitignorePath = path.join(cwd, '.gitignore');
  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
    if (existing.includes(GITIGNORE_HEADER)) {
      result.skipped.push('.gitignore');
    } else {
      const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
      const newEntries = GITIGNORE_ENTRIES.filter((e) => !existingLines.has(e));
      if (newEntries.length > 0) {
        const block = '\n' + GITIGNORE_HEADER + '\n' + newEntries.join('\n') + '\n';
        fs.appendFileSync(gitignorePath, block, 'utf-8');
        result.installed.push('.gitignore');
      } else {
        result.skipped.push('.gitignore');
      }
    }
  } else {
    const content = GITIGNORE_HEADER + '\n' + GITIGNORE_ENTRIES.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf-8');
    result.installed.push('.gitignore');
  }

  // .dxkit-ignore: write starter template (never overwrite)
  const dxkitIgnorePath = path.join(cwd, '.dxkit-ignore');
  if (fs.existsSync(dxkitIgnorePath) && !opts.force) {
    result.skipped.push('.dxkit-ignore');
  } else {
    fs.writeFileSync(dxkitIgnorePath, DXKIT_IGNORE_TEMPLATE, 'utf-8');
    result.installed.push('.dxkit-ignore');
  }

  return result;
}

/**
 * Wire `vyuh-dxkit hooks activate` into the consumer's `package.json`
 * postinstall script so cloning + `npm install` auto-activates the
 * dxkit hook directory. Closes the per-clone "run this one git config
 * command" friction step that today's installHooks emits as a note.
 *
 * Conflict policy (mirrors the rest of the ship surface):
 *   - No package.json → skip cleanly (Python-only / Go-only / etc.
 *     repos use the existing manual-activation path).
 *   - scripts.postinstall absent → write ours.
 *   - scripts.postinstall already mentions `vyuh-dxkit hooks activate`
 *     → skip (idempotent re-runs).
 *   - scripts.postinstall is set to something else → leave it alone
 *     and emit a note asking the consumer to chain. Auto-chaining
 *     risks breaking their existing script's exit-code semantics.
 */
export const POSTINSTALL_CMD = 'vyuh-dxkit hooks activate';

export function installHooksPostinstall(cwd: string, _opts: InstallerOpts = {}): ShipInstallResult {
  const result = emptyResult();
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    // Non-Node repos (Python-only, Go-only, .NET-only, etc.) — no
    // postinstall surface to wire into. Fall back to the existing
    // manual note emitted by `installHooks`.
    return result;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    return result;
  }

  type PackageJson = { scripts?: Record<string, string> } & Record<string, unknown>;
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    // Malformed package.json — bail rather than risk corrupting it.
    result.notes.push(
      `Skipped postinstall hooks-activation wire-up: ${path.relative(cwd, pkgPath)} is not valid JSON.`,
    );
    return result;
  }

  const existing = pkg.scripts?.postinstall;
  if (existing && existing.includes(POSTINSTALL_CMD)) {
    result.skipped.push('package.json (postinstall)');
    return result;
  }
  if (existing && existing.trim().length > 0) {
    // Chain after the existing command. `vyuh-dxkit hooks activate` is
    // exit-0-safe by design, so `&&`-appending preserves the existing
    // script's exit semantics (a real failure there still fails the
    // install) while ensuring hooks activate on every clone. Without
    // this, the common case of an existing postinstall (patch-package,
    // a husky bootstrap, etc.) silently leaves the pre-push guardrail
    // inactive — exactly the gap that lets pushes bypass the check.
    pkg.scripts = { ...(pkg.scripts ?? {}), postinstall: `${existing} && ${POSTINSTALL_CMD}` };
    const trailing = raw.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailing, 'utf-8');
    result.installed.push('package.json (postinstall)');
    result.notes.push(
      `Chained \`${POSTINSTALL_CMD}\` after your existing postinstall so dxkit hooks activate ` +
        `on every clone. It exits 0, so your script's result is unaffected.`,
    );
    return result;
  }

  pkg.scripts = { ...(pkg.scripts ?? {}), postinstall: POSTINSTALL_CMD };

  // Preserve trailing newline if the original had one — many editors
  // and linters expect it.
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline, 'utf-8');
  result.installed.push('package.json (postinstall)');
  result.notes.push(
    'Wired `vyuh-dxkit hooks activate` into package.json postinstall — every clone + `npm install` ' +
      'will activate `core.hooksPath = .githooks` automatically. (Manual one-time activation no longer needed.)',
  );
  return result;
}

export const DXKIT_PACKAGE = '@vyuhlabs/dxkit';

/**
 * Ensure `@vyuhlabs/dxkit` is in the consumer's package.json
 * devDependencies, pinned to the version that ran init.
 *
 * The git hooks AND the CI guardrail workflow both resolve
 * `./node_modules/.bin/vyuh-dxkit` first and only fall back to a global
 * install. Without a project-local devDep they silently run whatever
 * stale global happens to be on PATH — or fail outright on a fresh CI
 * runner where no global exists. Pinning the dep makes the guardrail
 * version-locked to the project, which is the whole point of the
 * local-first resolution (and the only way CI can re-read a baseline +
 * external snapshots produced by this version).
 *
 * Conflict policy (mirrors the rest of the ship surface):
 *   - No package.json → skip (non-Node repo; uses the global/npx path).
 *   - Already in dependencies OR devDependencies → skip, preserving the
 *     consumer's chosen spec (never repin or downgrade).
 *   - Otherwise → add `^X.Y.Z` to devDependencies and note that the
 *     consumer must run `npm install` to provision it.
 */
export function installDxkitDevDependency(
  cwd: string,
  _opts: InstallerOpts = {},
): ShipInstallResult {
  const result = emptyResult();
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return result;

  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath, 'utf-8');
  } catch {
    return result;
  }

  type DepMap = Record<string, string>;
  type PackageJson = { dependencies?: DepMap; devDependencies?: DepMap } & Record<string, unknown>;
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    result.notes.push(
      `Skipped dxkit devDependency wire-up: ${path.relative(cwd, pkgPath)} is not valid JSON.`,
    );
    return result;
  }

  // Never add dxkit as a dependency of dxkit itself. The dxkit repo runs its
  // own generated artifacts against the local build, and a package declaring
  // itself as a devDependency is invalid. (Only reachable when init/update
  // runs inside this repo; no customer package is named DXKIT_PACKAGE.)
  if (pkg.name === DXKIT_PACKAGE) {
    result.skipped.push('package.json (devDependencies)');
    return result;
  }

  if (pkg.dependencies?.[DXKIT_PACKAGE] || pkg.devDependencies?.[DXKIT_PACKAGE]) {
    result.skipped.push('package.json (devDependencies)');
    return result;
  }

  // Pin to the running version's minor range so hooks/CI stay on a
  // version that understands this project's baseline + snapshots, while
  // still picking up patch + minor fixes. A bare `latest` is the
  // fallback when the version is unreadable (broken install reports
  // '0.0.0').
  const spec = VERSION && VERSION !== '0.0.0' ? `^${VERSION}` : 'latest';
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [DXKIT_PACKAGE]: spec };

  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline, 'utf-8');
  result.installed.push('package.json (devDependencies)');
  result.notes.push(
    `Added ${DXKIT_PACKAGE}@${spec} to devDependencies — run \`npm install\` to provision it so the ` +
      `git hooks + CI guardrail resolve a project-local dxkit instead of a global (or missing) one.`,
  );
  return result;
}

const DXKIT_IGNORE_TEMPLATE = `# .dxkit-ignore — extra paths dxkit's analyzers should skip.
#
# Format: same as .gitignore (directory/, file-glob, multi-segment).
# Union'd on top of:
#   - dxkit's bundled defaults (node_modules/, dist/, .git/, build/, ...)
#   - this repo's .gitignore
#
# Use this file for dxkit-specific exclusions that you don't want in
# .gitignore (e.g. vendored code you DO commit but DON'T want dxkit
# to analyze for quality / coverage / security findings).
#
# Common examples (uncomment + adjust to your project):
#
# vendor/                    # vendored third-party code committed to git
# third_party/
# generated/                 # generated code (protobuf, GraphQL types, ORM)
# *.generated.ts
# *.designer.cs
# legacy/                    # pre-existing code you don't want to track findings against
# fixtures/large/            # test fixtures that inflate metrics
#
# After editing, the next \`vyuh-dxkit baseline create\` will pick up the
# changes. Note: changes to this file invalidate cached baselines
# (the file's content hash lands in the baseline envelope).
`;
