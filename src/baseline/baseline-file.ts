/**
 * On-disk baseline file — `.dxkit/baselines/<name>.json`.
 *
 * The baseline file is the durable contract between today's scan
 * and tomorrow's guardrail check. It carries:
 *
 *   - Per-finding identities (`BaselineEntry[]`) for cross-run
 *     matching.
 *   - Repo state at capture time (commit SHA, branch) so the
 *     git-aware matcher knows what to diff against.
 *   - Analysis-environment metadata (dxkit version, tool versions,
 *     policy hash, config hashes) so the policy classifier can
 *     reclassify newly-detected findings as `tooling_drift` or
 *     `config_drift` rather than blocking them as regressions.
 *   - The salt-resolution mode used to derive any secret-HMAC
 *     entries, so the matcher knows whether HMAC comparison is
 *     available on the current run.
 *
 * Raw finding payloads (titles, secret values, source excerpts) are
 * NEVER stored. The file is committable to git: a leak surfaces
 * identity fingerprints + locations, but no exploitable content.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BaselineEntry } from './types';
import type { SaltMode } from './salt';

/** Banner stamped on every baseline file. Bump when the on-disk
 *  shape changes incompatibly so readers can refuse old / new files
 *  rather than silently mis-parse them. */
export const BASELINE_SCHEMA_VERSION = 'dxkit-baseline/v1' as const;
export type BaselineSchemaVersion = typeof BASELINE_SCHEMA_VERSION;

/** Default baseline name when the user doesn't pass `--name`. */
export const DEFAULT_BASELINE_NAME = 'main' as const;

/**
 * Repo state at the moment of capture. The matcher reads `commitSha`
 * to drive `git diff` against the current `HEAD`; `branch` and `root`
 * are recorded for human auditability.
 */
export interface BaselineRepoState {
  readonly commitSha: string;
  readonly branch: string;
  readonly root: string;
}

/**
 * Analysis-environment metadata. Hashes are 16-char hex (SHA-1[0:16])
 * so a diff between baseline and current is one inequality check per
 * field. Drift on `toolchainHash` triggers `tooling_drift`
 * reclassification; drift on `policyHash` / `ignoreHash` / `configHash`
 * triggers `config_drift`.
 *
 * `''` is the canonical "absent" value for files that didn't exist at
 * capture time — so a baseline made before `.dxkit-ignore` existed
 * doesn't accidentally read as "drift" against a current run where
 * the file is still absent.
 */
export interface BaselineAnalysisMeta {
  readonly dxkitVersion: string;
  readonly policyHash: string;
  readonly ignoreHash: string;
  readonly toolchainHash: string;
  readonly configHash: string;
}

/**
 * The full on-disk envelope. Fields are ordered to match the order
 * the matcher reads them in: identity-related fields first, then
 * envelope metadata. Serialized via `JSON.stringify(file, null, 2)`
 * for git-friendly diffs.
 */
export interface BaselineFile {
  readonly schemaVersion: BaselineSchemaVersion;
  readonly name: string;
  readonly createdAt: string;
  readonly repo: BaselineRepoState;
  readonly analysis: BaselineAnalysisMeta;
  /** Per-tool version strings keyed by tool name. Sparse: only the
   *  tools that actually ran appear. Surfaced to the matcher as
   *  the canonical "what scanned this repo" record so version drift
   *  is detectable per-tool, not just at the aggregate level. */
  readonly tools: Readonly<Record<string, string>>;
  /** Mode used to derive the salt for any `secret-hmac` entries.
   *  Read by the matcher to decide whether HMAC compare is
   *  available on the current run. Recorded even when no
   *  `secret-hmac` entries are present so the value is stable
   *  across runs that add the first HMAC entry. */
  readonly saltMode: SaltMode;
  /** Per-finding entries. Multiset — duplicates allowed (an
   *  identity appearing twice means two distinct occurrences). */
  readonly findings: ReadonlyArray<BaselineEntry>;
}

/** Default storage directory. Lives under `.dxkit/` alongside the
 *  generated reports + the salt file. */
export const DEFAULT_BASELINE_DIR = path.join('.dxkit', 'baselines');

/** Absolute path for a named baseline inside `cwd`. */
export function pathForBaseline(cwd: string, name: string): string {
  return path.join(cwd, DEFAULT_BASELINE_DIR, `${name}.json`);
}

/**
 * Write a baseline file. Creates the parent directory when missing.
 * Pretty-printed JSON for git-friendly diffs.
 */
export function writeBaselineFile(filePath: string, file: BaselineFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/**
 * Read + validate a baseline file. Throws when the schema banner is
 * missing or unrecognized — fail fast rather than letting the
 * matcher consume a malformed file and produce wrong verdicts.
 */
export function readBaselineFile(filePath: string): BaselineFile {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`baseline file is not valid JSON: ${filePath} (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`baseline file root is not an object: ${filePath}`);
  }
  const obj = parsed as { schemaVersion?: unknown };
  if (obj.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `baseline file schemaVersion is ${JSON.stringify(obj.schemaVersion)}; ` +
        `this dxkit understands ${JSON.stringify(BASELINE_SCHEMA_VERSION)} only ` +
        `(${filePath})`,
    );
  }
  return parsed as BaselineFile;
}
