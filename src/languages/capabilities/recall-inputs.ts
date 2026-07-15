/**
 * Shared helpers for a pack's `LintGateProvider.recallInputs` (CLAUDE.md
 * Rule 19).
 *
 * Recall inputs answer "what determines what this linter can SEE?" — its own
 * version, its plugins' versions, its config file. The ANSWER is per-ecosystem
 * (Rule 6), so it lives in each pack; the MECHANICS (probe a binary's version,
 * hash a config file, read an installed package's version) are identical
 * everywhere, so they live here and every pack imports them.
 *
 * Deliberately self-contained: `src/baseline/` already imports `src/languages/`
 * (`check.ts`, the gate checks), so importing back would close a cycle. The
 * local `hashFile` mirrors the envelope-metadata hashing in `baseline/recall.ts`
 * — 16-char SHA-1, never a finding identity (Rule 9), which is why this file is
 * outside that rule's `src/analyzers/ + src/baseline/` scope.
 *
 * Contract for everything here: an input must be STABLE across runs of the same
 * environment. Never a timestamp, an absolute temp path, or a value that moves
 * on its own — an unstable input reads as permanent drift and silently turns
 * the kind's gate off, which is worse than the misattribution it was added to
 * prevent.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findTool, type ToolDefinition } from '../../analyzers/tools/tool-registry';

/** 16-char SHA-1 of a file's content, or absent when the file does not exist.
 *  The canonical "absent -> no entry" convention: a config file that does not
 *  exist contributes nothing rather than a sentinel, so a repo that never had
 *  one does not read as drift against a repo that still does not have one. */
export function hashFileInput(cwd: string, relPath: string): Readonly<Record<string, string>> {
  try {
    const content = fs.readFileSync(path.join(cwd, relPath), 'utf8');
    return { [relPath]: createHash('sha1').update(content).digest('hex').slice(0, 16) };
  } catch {
    return {};
  }
}

/** First existing config file among `candidates`, hashed. Linters accept a
 *  family of config filenames (`.eslintrc` / `eslint.config.js`,
 *  `.golangci.yml` / `.golangci.yaml`); the one that exists is the one that
 *  determines recall. */
export function hashFirstConfig(
  cwd: string,
  candidates: readonly string[],
): Readonly<Record<string, string>> {
  for (const candidate of candidates) {
    const hashed = hashFileInput(cwd, candidate);
    if (Object.keys(hashed).length > 0) return hashed;
  }
  return {};
}

/**
 * A tool's resolved version via the canonical registry probe (Rule 1).
 *
 * Absent when the tool is NOT INSTALLED — the lint runner is fail-open on a
 * missing binary, so "not installed" contributes no input rather than a
 * sentinel that would drift the moment it IS installed.
 *
 * But a tool that is not in the REGISTRY is a different thing entirely: it is a
 * programming error, and it throws. `TOOL_DEFS` is a `Record<string,
 * ToolDefinition>`, so `TOOL_DEFS.cargo` type-checks and is `undefined` at
 * runtime — this function shipped with exactly that mistake for `cargo` and
 * `dotnet`, and an earlier blanket `catch` turned it into a silently empty
 * input set: recall attribution that looked wired and could never fire. That is
 * the whole bug class Rule 19 exists to close, so it must not hide inside
 * Rule 19's own plumbing. Fail-open on the ENVIRONMENT, never on our own wiring.
 */
export function toolVersionInput(
  def: ToolDefinition,
  cwd: string,
  name?: string,
): Readonly<Record<string, string>> {
  if (!def || typeof def.name !== 'string') {
    throw new Error(
      'toolVersionInput: no such tool in TOOL_DEFS (a Record index type-checks ' +
        'but resolves to undefined at runtime). Use a real registry key, and declare ' +
        "it in the pack's tools[] — see CLAUDE.md Rule 1.",
    );
  }
  const key = name ?? def.name;
  try {
    const status = findTool(def, cwd);
    if (!status.available) return {};
    return { [key]: status.version || 'present' };
  } catch {
    return {}; // probe failed (environment) — not our wiring
  }
}

/** Read `node_modules/<pkg>/package.json`'s version — the version that
 *  ACTUALLY ran (`resolved` mode). */
export function installedNodeVersion(cwd: string, pkg: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'node_modules', pkg, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Every dependency range declared in the repo's own `package.json`
 *  (dependencies + devDependencies) — the `locked` mode's view. A caret range
 *  does not move when it resolves forward, which is exactly the point: fewer
 *  re-baselines for repos that tolerate dev != CI. */
function declaredNodeRanges(cwd: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/**
 * Every INSTALLED package whose name matches `pattern`, name -> version.
 *
 * Reads both real-world layouts:
 *
 *   - flat (`npm` / `yarn` / `bun`): `node_modules/<pkg>/package.json`, plus
 *     one level into `node_modules/@scope/`;
 *   - pnpm's virtual store: `node_modules/.pnpm/<name>@<version>[_<peers>]`,
 *     where `/` is encoded as `+`. The version is in the directory name, so no
 *     file read is needed.
 *
 * Why installed rather than declared: on a real repo the plugins that decide
 * what the linter reports are usually TRANSITIVE. gcs-web declares exactly
 * `eslint` and `eslint-config-next`, and `eslint-plugin-react-hooks@7.1.1`
 * arrives underneath the latter — so a declared-only scan would have missed
 * the precise bump this rule exists to catch, on the only repo that runs the
 * gate. Real-repo testing is what caught that; the elegant version of this
 * function was wrong.
 *
 * If two versions of one plugin are installed, BOTH are recorded (joined,
 * sorted). Ambiguity is real information here — silently picking one would be
 * the lossy-projection habit all over again.
 */
export function installedPackagesMatching(cwd: string, pattern: RegExp): Record<string, string> {
  const found = new Map<string, Set<string>>();
  const add = (name: string, version: string | undefined): void => {
    if (!version || !pattern.test(name)) return;
    const versions = found.get(name) ?? new Set<string>();
    versions.add(version);
    found.set(name, versions);
  };

  const modules = path.join(cwd, 'node_modules');
  for (const entry of readdirSafe(modules)) {
    if (entry === '.pnpm' || entry === '.bin') continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSafe(path.join(modules, entry))) {
        add(`${entry}/${scoped}`, installedNodeVersion(cwd, `${entry}/${scoped}`));
      }
      continue;
    }
    add(entry, installedNodeVersion(cwd, entry));
  }

  for (const dir of readdirSafe(path.join(modules, '.pnpm'))) {
    const parsed = parsePnpmStoreDir(dir);
    if (parsed) add(parsed.name, parsed.version);
  }

  const out: Record<string, string> = {};
  for (const name of [...found.keys()].sort()) {
    out[name] = [...(found.get(name) as Set<string>)].sort().join('+');
  }
  return out;
}

/** `eslint-plugin-react-hooks@7.1.1_eslint@9.39.4_jiti@2.7.0_` ->
 *  `{ name: 'eslint-plugin-react-hooks', version: '7.1.1' }`.
 *  `@typescript-eslint+eslint-plugin@8.62.1_...` ->
 *  `{ name: '@typescript-eslint/eslint-plugin', version: '8.62.1' }`.
 *  The `_<peers>` suffix is pnpm's peer-resolution hash — excluded on purpose:
 *  it moves when an unrelated peer moves, and an input that moves on its own
 *  reads as permanent drift. */
function parsePnpmStoreDir(dir: string): { name: string; version: string } | null {
  const base = dir.split('_')[0];
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  const name = base.slice(0, at).replace(/\+/g, '/');
  const version = base.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Versions of a node linter and everything that extends it.
 *
 * `roots` are the linter packages themselves (`eslint`, `typescript`).
 * `pluginPattern` matches the packages that ADD RULES to it — the load-bearing
 * part: a plugin bump changes which rules run under a byte-identical argv,
 * which is precisely the case that shipped (`eslint-plugin-react-hooks ^7.0.1
 * -> 7.1.1` adds rules nobody asked for, and every finding they report looks
 * net-new).
 *
 * `resolved` reports what is INSTALLED (including transitive plugins);
 * `locked` reports only the repo's DECLARED ranges, which do not move when a
 * caret resolves forward — fewer re-baselines for repos that tolerate
 * dev != CI, at the cost of not seeing a transitive bump at all.
 */
export function nodeLinterVersions(opts: {
  readonly cwd: string;
  readonly mode: 'resolved' | 'locked';
  readonly roots: readonly string[];
  readonly pluginPattern: RegExp;
}): Record<string, string> {
  const declared = declaredNodeRanges(opts.cwd);

  if (opts.mode === 'locked') {
    const out: Record<string, string> = {};
    for (const name of Object.keys(declared).sort()) {
      if (opts.roots.includes(name) || opts.pluginPattern.test(name)) out[name] = declared[name];
    }
    return out;
  }

  const out = installedPackagesMatching(opts.cwd, opts.pluginPattern);
  for (const name of opts.roots) {
    const version = installedNodeVersion(opts.cwd, name) ?? declared[name];
    if (version !== undefined) out[name] = version;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
