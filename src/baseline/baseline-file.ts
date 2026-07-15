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
import type { BaselineEntry, IdentitySchemeVersion } from './types';
import type { SaltMode } from '../analyzers/tools/salt';
import type { ScanCoverage } from './coverage';
import type { RecallMap } from './recall';

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
  /** Flattened name → version/hash record of everything that determined what
   *  this scan could see. Sparse: only inputs that actually applied appear.
   *
   *  A DISPLAY projection of `recall` (`recallInputsUnion`) — human-readable in
   *  `baseline show`, and the source of `analysis.toolchainHash`. NOT an
   *  attribution source: the guardrail compares `recall` per kind, because a
   *  flat union cannot say WHICH kind a given drift affects. That confusion is
   *  exactly what made the pre-Rule-19 mechanism inert. */
  readonly tools: Readonly<Record<string, string>>;
  /** What each finding kind could SEE when this baseline was captured
   *  (CLAUDE.md Rule 19) — tool versions, plugin versions, check commands, plus
   *  a dxkit-controlled `epoch` per kind.
   *
   *  The guardrail compares this against the current scan's per kind. Unequal ⇒
   *  that kind's delta has an explanation other than "the developer introduced
   *  it", so its net-new findings warn instead of blocking.
   *
   *  Optional: baselines written before Rule 19 omit it. Absent is NOT treated
   *  as "comparable" — every kind reads as drifted until the repo re-baselines,
   *  because assuming comparability is precisely the proxy Rule 19 exists to
   *  kill. Do NOT bump `BASELINE_SCHEMA_VERSION` for this: a bump makes
   *  `readBaselineFile` throw on every existing baseline, which is the opposite
   *  of a graceful degrade. */
  readonly recall?: RecallMap;
  /** Mode used to derive the salt for any `secret-hmac` entries.
   *  Read by the matcher to decide whether HMAC compare is
   *  available on the current run. Recorded even when no
   *  `secret-hmac` entries are present so the value is stable
   *  across runs that add the first HMAC entry. */
  readonly saltMode: SaltMode;
  /** Which scanners were available when this baseline was captured.
   *  Lets a later guardrail check tell "scanned and clean" apart from
   *  "never scanned because the tool was missing." Optional: baselines
   *  written before this field existed simply omit it, and the matcher
   *  treats a missing record as "no coverage info to diff against"
   *  rather than erroring. */
  readonly coverage?: ScanCoverage;
  /** Identity scheme the `findings[].id` values were minted under. Lets a
   *  later dxkit detect that a baseline predates an identity-scheme change
   *  and migrate it (rather than silently reporting every pre-existing
   *  finding as net-new because the ids no longer line up). Optional:
   *  baselines written before this field existed omit it and are treated
   *  as the original `'v1'` scheme. */
  readonly identityScheme?: IdentitySchemeVersion;
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
 * Identity kinds that this dxkit version no longer recognizes but
 * that older baseline files may contain. Lenient migration: read
 * silently drops these so a 2.5.x baseline still loads on a 2.6+
 * dxkit without forcing a `baseline create --force`. The dropped
 * kind moves to a separate artifact — `license` → `.dxkit/bom.json`,
 * the canonical inventory carried by `vyuh-dxkit bom`.
 */
const RETIRED_KINDS: ReadonlySet<string> = new Set(['license']);

/**
 * Read + validate a baseline file. Throws when the schema banner is
 * missing or unrecognized — fail fast rather than letting the
 * matcher consume a malformed file and produce wrong verdicts.
 *
 * Retired finding kinds (see `RETIRED_KINDS`) are silently filtered
 * out of `findings` so a baseline written by an older dxkit doesn't
 * crash the matcher when its identity union no longer contains that
 * kind. The original file on disk is not modified — only the in-memory
 * view consumed by the matcher / classifier. A subsequent `baseline
 * create --force` writes a fresh file without the retired entries.
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
  const obj = parsed as { schemaVersion?: unknown; findings?: unknown };
  if (obj.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `baseline file schemaVersion is ${JSON.stringify(obj.schemaVersion)}; ` +
        `this dxkit understands ${JSON.stringify(BASELINE_SCHEMA_VERSION)} only ` +
        `(${filePath})`,
    );
  }
  const file = parsed as BaselineFile & {
    findings: ReadonlyArray<BaselineEntry & { kind: string }>;
  };
  const filteredFindings = file.findings.filter((entry) => !RETIRED_KINDS.has(entry.kind));
  if (filteredFindings.length === file.findings.length) {
    return file;
  }
  return { ...file, findings: filteredFindings };
}
