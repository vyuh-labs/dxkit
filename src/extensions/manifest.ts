/**
 * Extension manifest discovery + validation.
 *
 * A manifest is `.dxkit/extensions/<name>/extension.json`, committed to the
 * repo. TRUST BOUNDARY (load-bearing, Rule 17's verbatim): manifests are
 * honored ONLY from the repo's own tree — the same boundary as npm scripts
 * and CI config. Nothing here (or anywhere) accepts a manifest from a CLI
 * flag or any other untrusted source, and extensions EXECUTE only on
 * trusted context at refresh time (`extensions refresh`, the on-merge
 * workflow); per-commit gates and untrusted runs read committed snapshots
 * offline. A PR that edits an extension.json or its script gets reviewed
 * like a PR that edits a CI workflow.
 *
 * Validation is field-precise in the wire-validator style (the error is
 * the documentation), plus three path-safety guards on values that reach
 * a spawn or a write:
 *   - `run.command` / `run.args[*]` must not start with `-` (argument
 *     injection into the interpreter);
 *   - `output` must be a repo-relative path without `..` traversal or an
 *     absolute head (an extension may only write its own committed
 *     snapshot location);
 *   - the manifest's `name` must equal its directory name (one identity,
 *     no aliasing).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ContributionKind, ExtensionManifest } from '@vyuhlabs/dxkit-sdk';
import { CONTRIBUTION_KINDS, type ContributionKindDef } from './contributions';

export const EXTENSIONS_DIR = '.dxkit/extensions';

/** Ceiling on run.timeoutSeconds — a refresh surface, not a build system. */
const MAX_TIMEOUT_SECONDS = 3600;
/** Default when the manifest omits timeoutSeconds. */
export const DEFAULT_TIMEOUT_SECONDS = 300;

/** A manifest that passed validation, with its repo location attached. */
export interface LoadedExtension {
  readonly manifest: ExtensionManifest;
  /** Repo-relative directory (`.dxkit/extensions/<name>`). */
  readonly dir: string;
  /**
   * The committed config block passed to the extension on stdin (the
   * manifest's optional `config` object — committed, so inside the same
   * trust boundary). `{}` when absent.
   */
  readonly config: Record<string, unknown>;
}

export interface DiscoverResult {
  readonly extensions: readonly LoadedExtension[];
  /** Per-manifest validation failures, field-precise. Fail-open: a broken
   *  manifest never hides the healthy ones, and doctor surfaces these. */
  readonly errors: readonly string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Repo-relative, no traversal, no absolute head, no leading dash. */
function safeRelativePath(p: string): boolean {
  if (p.length === 0 || p.startsWith('-')) return false;
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return false;
  const segments = p.split(/[\\/]+/);
  return segments.every((s) => s !== '..' && s.length > 0);
}

function validateManifest(raw: unknown, dirName: string, at: string): string[] {
  const errors: string[] = [];
  const add = (field: string, problem: string) => errors.push(`${at}: ${field} ${problem}`);
  if (!isObject(raw)) {
    add('manifest', 'must be a JSON object');
    return errors;
  }
  if (raw['schemaVersion'] !== 1) {
    add('schemaVersion', `must be 1 (got ${JSON.stringify(raw['schemaVersion'])})`);
  }
  const name = raw['name'];
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    add('name', 'must be a lowercase kebab-case string');
  } else if (name !== dirName) {
    add('name', `('${name}') must equal the extension directory name ('${dirName}')`);
  }
  const contributes = raw['contributes'];
  const knownKinds = CONTRIBUTION_KINDS.map((d: ContributionKindDef) => d.kind);
  if (typeof contributes !== 'string' || !knownKinds.includes(contributes as ContributionKind)) {
    add(
      'contributes',
      `must be one of ${knownKinds.map((k) => `'${k}'`).join(' | ')} (got ${JSON.stringify(contributes)})`,
    );
  }
  const run = raw['run'];
  if (!isObject(run)) {
    add('run', 'is missing (required object with command/args)');
  } else {
    const command = run['command'];
    if (typeof command !== 'string' || command.length === 0 || command.startsWith('-')) {
      add('run.command', 'must be a non-empty string not starting with "-"');
    }
    const args = run['args'];
    if (args !== undefined) {
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        add('run.args', 'must be an array of strings when present');
      }
    }
    const t = run['timeoutSeconds'];
    if (
      t !== undefined &&
      (!Number.isInteger(t) || (t as number) < 1 || (t as number) > MAX_TIMEOUT_SECONDS)
    ) {
      add('run.timeoutSeconds', `must be an integer in [1, ${MAX_TIMEOUT_SECONDS}] when present`);
    }
  }
  const refresh = raw['refresh'];
  if (refresh !== 'on-merge' && refresh !== 'manual') {
    add('refresh', `must be 'on-merge' or 'manual' (got ${JSON.stringify(refresh)})`);
  }
  const output = raw['output'];
  if (typeof output !== 'string' || !safeRelativePath(output) || !output.endsWith('.json')) {
    add(
      'output',
      'must be a repo-relative .json path (no absolute paths, no "..", no leading "-")',
    );
  }
  const config = raw['config'];
  if (config !== undefined && !isObject(config)) {
    add('config', 'must be an object when present');
  }
  const gating = raw['gating'];
  if (gating !== undefined && gating !== 'block' && gating !== 'warn' && gating !== 'off') {
    add('gating', `must be 'block', 'warn', or 'off' when present (got ${JSON.stringify(gating)})`);
  }
  return errors;
}

/**
 * Discover every committed extension manifest under `.dxkit/extensions/`.
 * Broken manifests are reported, not thrown, and never hide healthy ones.
 */
export function discoverExtensions(cwd: string): DiscoverResult {
  const root = path.join(cwd, EXTENSIONS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { extensions: [], errors: [] }; // no extensions dir — the common case
  }
  const extensions: LoadedExtension[] = [];
  const errors: string[] = [];
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = `${EXTENSIONS_DIR}/${entry.name}`;
    const manifestPath = path.join(root, entry.name, 'extension.json');
    let text: string;
    try {
      text = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
      errors.push(`${dir}: missing extension.json`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      errors.push(
        `${dir}/extension.json: not valid JSON (${e instanceof Error ? e.message : String(e)})`,
      );
      continue;
    }
    const problems = validateManifest(raw, entry.name, `${dir}/extension.json`);
    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    const m = raw as unknown as ExtensionManifest & { config?: Record<string, unknown> };
    extensions.push({ manifest: m, dir, config: m.config ?? {} });
  }
  return { extensions, errors };
}
