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
import { makeExecutable } from './files';

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
 * Hooks installer. Writes `.githooks/pre-commit` and
 * `.githooks/pre-push`. When the consumer already has a pre-commit
 * hook (via .githooks/ or .husky/), emits a `.dxkit` sidecar instead
 * and prints merge instructions.
 *
 * Customer still needs to run `git config core.hooksPath .githooks`
 * to activate. We don't run it for them — that's a global git config
 * mutation outside dxkit's purview.
 */
export function installHooks(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  const result = emptyResult();
  const tmplDir = path.join(templatesDir(), '.githooks');
  const destDir = path.join(cwd, '.githooks');

  // Husky users have hooks at `.husky/<name>`. We treat either an
  // existing `.githooks/<name>` *or* `.husky/<name>` as a conflict —
  // both routes mean the consumer already has an active hook, even
  // though only the .githooks/ path is the destination we write to.
  const hookNames: Array<{ name: 'pre-commit' | 'pre-push' }> = [
    { name: 'pre-commit' },
    { name: 'pre-push' },
  ];
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
 */
function installWorkflow(cwd: string, fileName: string, opts: InstallerOpts): ShipInstallResult {
  const result = emptyResult();
  const srcAbs = path.join(templatesDir(), '.github', 'workflows', fileName);
  const destAbs = path.join(cwd, '.github', 'workflows', fileName);

  if (fs.existsSync(destAbs) && !opts.force) {
    result.skipped.push(path.relative(cwd, destAbs));
    return result;
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  result.installed.push(path.relative(cwd, destAbs));
  return result;
}

export function installCiGuardrails(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  return installWorkflow(cwd, 'dxkit-guardrails.yml', opts);
}

export function installCiBaselineRefresh(cwd: string, opts: InstallerOpts = {}): ShipInstallResult {
  return installWorkflow(cwd, 'dxkit-baseline-refresh.yml', opts);
}
