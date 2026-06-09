/**
 * On-disk allowlist file — `.dxkit/allowlist.json` + optional sidecar
 * `.dxkit/allowlist-reasons.local.json`.
 *
 * The allowlist file is the durable contract for per-finding
 * suppressions: customer has reviewed this fingerprint, categorized
 * the reason, and accepts that the guardrail should let the finding
 * pass on future runs.
 *
 * Identity is the 16-char hex fingerprint from
 * `src/analyzers/tools/fingerprint.ts` (CLAUDE.md Rule 9). An entry
 * matches a finding when their fingerprint strings are byte-equal.
 *
 * # Two modes, one schema
 *
 * The mode is recorded in `.dxkit/policy.json` (out of scope for this
 * module — consumers pass it in via `AllowlistMode`). Both modes use
 * the same `AllowlistFile` shape on disk; sanitized mode just drops
 * the human-readable fields and pushes them to a sidecar:
 *
 *   `'full'` — every field present on the entry. Default for
 *   private repos. The committed file carries the full audit trail.
 *
 *   `'sanitized'` — entries carry `fingerprint + kind + category +
 *   addedAt + expiresAt + acknowledgedSeverity` only. The
 *   `reason` + `addedBy` fields live in the gitignored sidecar
 *   `.dxkit/allowlist-reasons.local.json`, keyed by fingerprint.
 *   Default for public repos. Loaders merge the sidecar back when
 *   present; readers tolerate its absence (no reason field, but
 *   the suppression still applies because matching is by
 *   fingerprint).
 *
 * # Validation surface
 *
 * `validateAllowlistFile` enforces every Sprint-0-locked rule:
 *   - `reason` is required (full mode) / required in sidecar
 *     (sanitized mode)
 *   - `category` is one of the five canonical values
 *   - `category` is valid for the entry's `kind`
 *   - `requiresExpiry(category)` ⇒ `expiresAt` is present + parseable
 *   - `acknowledgedSeverity` is required when `category` is
 *     `accepted-risk` AND `severity` is `high`/`critical`
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IdentityKind } from '../baseline/producers';
import type { FindingSeverity } from '../baseline/types';
import {
  ALL_CATEGORIES,
  isCategoryValidForKind,
  requiresExpiry,
  type AllowlistCategory,
} from './categories';

export const ALLOWLIST_SCHEMA_VERSION = 'dxkit-allowlist/v1' as const;
export type AllowlistSchemaVersion = typeof ALLOWLIST_SCHEMA_VERSION;

export const ALLOWLIST_REASONS_SCHEMA_VERSION = 'dxkit-allowlist-reasons/v1' as const;
export type AllowlistReasonsSchemaVersion = typeof ALLOWLIST_REASONS_SCHEMA_VERSION;

export const ALLOWLIST_DIR = '.dxkit';
export const ALLOWLIST_FILENAME = 'allowlist.json';
export const ALLOWLIST_REASONS_FILENAME = 'allowlist-reasons.local.json';

/**
 * Single source of truth for mode values. The `AllowlistMode` union
 * is derived from this array via `(typeof ...)[number]`, so adding
 * a new mode means appending one string here — the runtime checks
 * below pick it up via `ALL_MODES.includes(...)` without any
 * literal-value drift between type and runtime.
 */
export const ALL_MODES = ['full', 'sanitized'] as const;
export type AllowlistMode = (typeof ALL_MODES)[number];

/**
 * One allowlist entry. Two-shape contract:
 *   - Full mode: every optional field may be present on disk.
 *   - Sanitized mode on disk: `reason` + `addedBy` are absent; the
 *     loader merges them in from the sidecar when present.
 *
 * The TypeScript type allows the union so a single in-memory shape
 * serves both modes; the validator enforces shape invariants.
 */
export interface AllowlistEntry {
  /** SHA-1[0:16] canonical fingerprint matching the target finding. */
  readonly fingerprint: string;
  /** Identity kind of the target finding (matches CLAUDE.md Rule 9
   *  canonical kinds). */
  readonly kind: IdentityKind;
  /** Suppression category — one of the five Sprint-0-locked enum
   *  values. */
  readonly category: AllowlistCategory;
  /** Human-readable rationale. Required in full mode; lives in
   *  sidecar in sanitized mode. */
  readonly reason?: string;
  /** Who added the entry. Required in full mode; lives in sidecar
   *  in sanitized mode. Free-form (typically email, git user, or
   *  Slack handle). */
  readonly addedBy?: string;
  /** ISO `YYYY-MM-DD` of when the entry was added. */
  readonly addedAt: string;
  /** ISO `YYYY-MM-DD` after which the entry stops suppressing the
   *  finding. Required for `accepted-risk` + `deferred` categories;
   *  optional otherwise. */
  readonly expiresAt?: string;
  /** Severity at which the suppression was acknowledged. Required
   *  when `category` is `accepted-risk` and the finding's severity
   *  is `high` or `critical` — see `validateAllowlistEntry`. */
  readonly acknowledgedSeverity?: FindingSeverity;
}

export interface AllowlistFile {
  readonly schemaVersion: AllowlistSchemaVersion;
  readonly mode: AllowlistMode;
  readonly entries: ReadonlyArray<AllowlistEntry>;
}

/**
 * The gitignored sidecar that carries the human-readable fields in
 * sanitized mode. Sparse — only the fields that need to live
 * outside the committed file appear. Loaders are lenient when the
 * sidecar is absent (no entry merges; suppression still works by
 * fingerprint).
 */
export interface AllowlistReasonsSidecar {
  readonly schemaVersion: AllowlistReasonsSchemaVersion;
  readonly reasons: Readonly<
    Record<
      /* fingerprint */ string,
      {
        readonly reason: string;
        readonly addedBy: string;
      }
    >
  >;
}

export interface ValidationError {
  readonly fingerprint?: string;
  readonly field: string;
  readonly message: string;
}

export function pathForAllowlist(cwd: string): string {
  return path.join(cwd, ALLOWLIST_DIR, ALLOWLIST_FILENAME);
}

export function pathForAllowlistReasons(cwd: string): string {
  return path.join(cwd, ALLOWLIST_DIR, ALLOWLIST_REASONS_FILENAME);
}

/**
 * Create an empty allowlist file in the requested mode. Useful for
 * the `vyuh-dxkit allowlist add` CLI path when no file exists yet.
 */
export function emptyAllowlistFile(mode: AllowlistMode = 'full'): AllowlistFile {
  return { schemaVersion: ALLOWLIST_SCHEMA_VERSION, mode, entries: [] };
}

/**
 * Read the on-disk allowlist + (when present) merge the sidecar
 * reasons. Returns `null` when the main file doesn't exist —
 * callers treat that as "no allowlist configured."
 *
 * Throws on:
 *   - Malformed JSON in either file
 *   - Unrecognized `schemaVersion`
 *   - Root is not an object
 *
 * The sidecar's absence is NOT an error: customers in sanitized
 * mode may have a committed allowlist on disk without the sidecar
 * cloned (CI checkout, fresh teammate clone). The fingerprint-only
 * file is still functional as a suppression list.
 */
export function loadAllowlist(cwd: string): AllowlistFile | null {
  const filePath = pathForAllowlist(cwd);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`allowlist file is not valid JSON: ${filePath} (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`allowlist file root is not an object: ${filePath}`);
  }
  const obj = parsed as Partial<AllowlistFile>;
  if (obj.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) {
    throw new Error(
      `allowlist file schemaVersion is ${JSON.stringify(obj.schemaVersion)}; ` +
        `this dxkit understands ${JSON.stringify(ALLOWLIST_SCHEMA_VERSION)} only ` +
        `(${filePath})`,
    );
  }
  if (!isAllowlistMode(obj.mode)) {
    throw new Error(
      `allowlist file mode is ${JSON.stringify(obj.mode)}; ` +
        `expected one of ${JSON.stringify(ALL_MODES)} (${filePath})`,
    );
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error(`allowlist file entries is not an array (${filePath})`);
  }

  const base = parsed as AllowlistFile;
  if (base.mode === 'full') return base;

  // sanitized mode → merge sidecar if present
  const sidecar = loadAllowlistReasons(cwd);
  if (!sidecar) return base;
  return mergeReasons(base, sidecar);
}

/**
 * Load the gitignored reasons sidecar. Returns `null` when missing.
 * Throws on malformed JSON or wrong schemaVersion.
 */
export function loadAllowlistReasons(cwd: string): AllowlistReasonsSidecar | null {
  const filePath = pathForAllowlistReasons(cwd);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `allowlist reasons sidecar is not valid JSON: ${filePath} (${(err as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`allowlist reasons sidecar root is not an object: ${filePath}`);
  }
  const obj = parsed as Partial<AllowlistReasonsSidecar>;
  if (obj.schemaVersion !== ALLOWLIST_REASONS_SCHEMA_VERSION) {
    throw new Error(
      `allowlist reasons sidecar schemaVersion is ${JSON.stringify(obj.schemaVersion)}; ` +
        `expected ${JSON.stringify(ALLOWLIST_REASONS_SCHEMA_VERSION)} (${filePath})`,
    );
  }
  if (!obj.reasons || typeof obj.reasons !== 'object' || Array.isArray(obj.reasons)) {
    throw new Error(`allowlist reasons sidecar 'reasons' is not an object (${filePath})`);
  }
  return parsed as AllowlistReasonsSidecar;
}

/**
 * Persist the allowlist to disk. Writes the sidecar separately in
 * sanitized mode: the committed file gets the structural fields;
 * the sidecar gets `reason` + `addedBy`.
 *
 * Validation runs before writing — invalid input throws and the
 * file isn't touched. Use `validateAllowlistFile` directly when
 * you want non-throwing error reporting.
 */
export function saveAllowlist(cwd: string, file: AllowlistFile): void {
  const errors = validateAllowlistFile(file);
  if (errors.length > 0) {
    throw new Error(
      `allowlist file failed validation:\n` +
        errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n'),
    );
  }

  if (file.mode === 'full') {
    writeJsonPretty(pathForAllowlist(cwd), file);
    return;
  }

  // sanitized mode: split entries → main + sidecar
  const sanitizedEntries: AllowlistEntry[] = [];
  const reasons: Record<string, { reason: string; addedBy: string }> = {};
  for (const entry of file.entries) {
    sanitizedEntries.push(sanitizedEntry(entry));
    if (entry.reason !== undefined && entry.addedBy !== undefined) {
      reasons[entry.fingerprint] = { reason: entry.reason, addedBy: entry.addedBy };
    }
  }
  const sanitizedFile: AllowlistFile = {
    schemaVersion: file.schemaVersion,
    mode: 'sanitized',
    entries: sanitizedEntries,
  };
  const sidecar: AllowlistReasonsSidecar = {
    schemaVersion: ALLOWLIST_REASONS_SCHEMA_VERSION,
    reasons,
  };
  writeJsonPretty(pathForAllowlist(cwd), sanitizedFile);
  writeJsonPretty(pathForAllowlistReasons(cwd), sidecar);
}

/** Find an entry by fingerprint. */
export function findEntry(file: AllowlistFile, fingerprint: string): AllowlistEntry | undefined {
  return file.entries.find((e) => e.fingerprint === fingerprint);
}

/**
 * Add an entry. Returns a NEW `AllowlistFile` (immutable update).
 * Throws if `entry.fingerprint` already exists.
 */
export function addEntry(file: AllowlistFile, entry: AllowlistEntry): AllowlistFile {
  if (findEntry(file, entry.fingerprint)) {
    throw new Error(
      `allowlist already contains entry for fingerprint ${entry.fingerprint}; ` +
        `use removeEntry first or update in place`,
    );
  }
  return { ...file, entries: [...file.entries, entry] };
}

/**
 * Remove an entry by fingerprint. Returns a NEW `AllowlistFile`.
 * Silently no-ops when the fingerprint isn't present (CLI surfaces
 * the "not found" case through a separate read step).
 */
export function removeEntry(file: AllowlistFile, fingerprint: string): AllowlistFile {
  return { ...file, entries: file.entries.filter((e) => e.fingerprint !== fingerprint) };
}

/**
 * Whether the allowlist suppresses a given finding. Pure
 * fingerprint match. Expiry handling is layered on top by
 * `isEntryActive` (kept separate so the guardrail can distinguish
 * "matched but expired" from "no match").
 */
export function matchesFinding(file: AllowlistFile, fingerprint: string): boolean {
  return findEntry(file, fingerprint) !== undefined;
}

/**
 * Whether an entry is currently active (within its expiry window).
 * Entries without `expiresAt` are always active. Entries past their
 * expiry are inactive — guardrail treats the underlying finding as
 * un-allowlisted and the next run flags the suppression as stale.
 */
export function isEntryActive(entry: AllowlistEntry, now: Date = new Date()): boolean {
  if (!entry.expiresAt) return true;
  const today = now.toISOString().slice(0, 10);
  return entry.expiresAt >= today;
}

/**
 * Days remaining until an entry expires, or `null` when it has no
 * expiry. Negative values mean already expired by that many days.
 */
export function daysUntilExpiry(entry: AllowlistEntry, now: Date = new Date()): number | null {
  if (!entry.expiresAt) return null;
  const expiry = new Date(entry.expiresAt + 'T00:00:00Z');
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((expiry.getTime() - today.getTime()) / msPerDay);
}

/** One entry in a soon-to-expire audit bucket, with the days
 *  remaining so callers can render time-to-expiry context. */
export interface SoonToExpire {
  readonly entry: AllowlistEntry;
  readonly daysRemaining: number;
}

/**
 * Audit report partitioning the file's entries into the three
 * actionable categories the `vyuh-dxkit allowlist audit` subcommand
 * surfaces. Pure function — no I/O, no side effects.
 *
 * - `expired` — entries past their `expiresAt`. Prune candidates.
 *   The underlying suppression no longer applies on the next
 *   guardrail run.
 * - `soonToExpire` — entries whose `expiresAt` is within
 *   `soonToExpireDays` (default 14). Customer should review whether
 *   the deferred work is still in plan and either fix the finding,
 *   extend the expiry, or remove the entry.
 * - `missingRationale` — entries with empty / whitespace-only
 *   reason. In full mode this should never happen (validator
 *   rejects); in sanitized mode it may occur when the sidecar is
 *   missing or stale.
 * - `orphaned` — entries whose fingerprint matches no current
 *   finding. Only populated when the caller supplies the set of
 *   current finding fingerprints via `AuditOptions.currentFingerprints`
 *   (otherwise `undefined` — audit stays pure-over-file). An orphaned
 *   entry is NOT necessarily stale: re-baselining churns some
 *   fingerprints (semgrep nondeterminism, cross-tool dedup ordering),
 *   and an entry may suppress an intermittently-detected finding. So
 *   this bucket FLAGS for review — it never drives auto-removal.
 */
export interface AuditReport {
  readonly expired: ReadonlyArray<AllowlistEntry>;
  readonly soonToExpire: ReadonlyArray<SoonToExpire>;
  readonly missingRationale: ReadonlyArray<AllowlistEntry>;
  /** Entries whose fingerprint is absent from the supplied current-
   *  finding set. `undefined` when no set was supplied (the caller
   *  didn't ask for orphan detection). */
  readonly orphaned?: ReadonlyArray<AllowlistEntry>;
}

export interface AuditOptions {
  readonly now?: Date;
  /** Window in days within which `expiresAt` is considered "soon."
   *  Default 14 — chosen to match a typical sprint cadence. */
  readonly soonToExpireDays?: number;
  /** Set of fingerprints present in the current finding set (the
   *  union of every baseline entry's `id` plus its
   *  `absorbedFingerprints`, so an entry keyed on a collapsed
   *  contributor isn't falsely flagged). When provided, entries whose
   *  fingerprint isn't in this set land in the `orphaned` bucket. */
  readonly currentFingerprints?: ReadonlySet<string>;
}

export function auditAllowlist(file: AllowlistFile, options: AuditOptions = {}): AuditReport {
  const now = options.now ?? new Date();
  const horizon = options.soonToExpireDays ?? 14;
  const expired: AllowlistEntry[] = [];
  const soonToExpire: SoonToExpire[] = [];
  const missingRationale: AllowlistEntry[] = [];
  const orphaned: AllowlistEntry[] = [];

  for (const entry of file.entries) {
    const days = daysUntilExpiry(entry, now);
    if (days !== null && days < 0) {
      expired.push(entry);
    } else if (days !== null && days <= horizon) {
      soonToExpire.push({ entry, daysRemaining: days });
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
      // In sanitized mode the reason may legitimately live in the
      // gitignored sidecar; flag here so the caller can decide
      // whether to treat it as a real audit item or just an
      // "unavailable locally" notice.
      missingRationale.push(entry);
    }
    if (options.currentFingerprints && !options.currentFingerprints.has(entry.fingerprint)) {
      orphaned.push(entry);
    }
  }
  return {
    expired,
    soonToExpire,
    missingRationale,
    ...(options.currentFingerprints ? { orphaned } : {}),
  };
}

/**
 * Remove expired entries from the file. Returns a new file (immutable)
 * plus the list of removed entries so the CLI can render what changed.
 * Pure function — no I/O.
 */
export function pruneExpired(
  file: AllowlistFile,
  now: Date = new Date(),
): { kept: AllowlistFile; removed: ReadonlyArray<AllowlistEntry> } {
  const removed: AllowlistEntry[] = [];
  const keptEntries: AllowlistEntry[] = [];
  for (const entry of file.entries) {
    if (isEntryActive(entry, now)) {
      keptEntries.push(entry);
    } else {
      removed.push(entry);
    }
  }
  return { kept: { ...file, entries: keptEntries }, removed };
}

/**
 * Validate every entry in the file against the canonical taxonomy
 * + Sprint-0-locked rules. Pure function; returns an array of
 * `ValidationError` rather than throwing so callers can render
 * structured error messages.
 */
export function validateAllowlistFile(file: AllowlistFile): ReadonlyArray<ValidationError> {
  const errors: ValidationError[] = [];
  if (file.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) {
    errors.push({
      field: 'schemaVersion',
      message: `expected ${JSON.stringify(ALLOWLIST_SCHEMA_VERSION)}, got ${JSON.stringify(file.schemaVersion)}`,
    });
  }
  if (!isAllowlistMode(file.mode)) {
    errors.push({
      field: 'mode',
      message: `expected one of ${JSON.stringify(ALL_MODES)}, got ${JSON.stringify(file.mode)}`,
    });
  }

  const seen = new Set<string>();
  for (const entry of file.entries) {
    if (seen.has(entry.fingerprint)) {
      errors.push({
        fingerprint: entry.fingerprint,
        field: 'fingerprint',
        message: `duplicate fingerprint`,
      });
    }
    seen.add(entry.fingerprint);
    for (const err of validateAllowlistEntry(entry, file.mode)) errors.push(err);
  }
  return errors;
}

/**
 * Validate a single entry. Exposed independently so the CLI's
 * `allowlist add` can pre-flight before mutating the file.
 */
export function validateAllowlistEntry(
  entry: AllowlistEntry,
  mode: AllowlistMode,
): ReadonlyArray<ValidationError> {
  const errors: ValidationError[] = [];
  const fp = entry.fingerprint;

  if (!fp || typeof fp !== 'string' || !/^[0-9a-f]{16}$/.test(fp)) {
    errors.push({
      fingerprint: fp,
      field: 'fingerprint',
      message: 'must be a 16-char lowercase hex string',
    });
  }
  if (!ALL_CATEGORIES.includes(entry.category)) {
    errors.push({
      fingerprint: fp,
      field: 'category',
      message: `must be one of ${JSON.stringify(ALL_CATEGORIES)}; got ${JSON.stringify(entry.category)}`,
    });
  }
  if (!isCategoryValidForKind(entry.kind, entry.category)) {
    errors.push({
      fingerprint: fp,
      field: 'category',
      message: `category ${JSON.stringify(entry.category)} does not apply to kind ${JSON.stringify(entry.kind)}`,
    });
  }
  // reason: required in full mode; sidecar-owned in sanitized mode (so
  // the entry on disk legitimately omits it). The CLI write path emits
  // a separate validation pass for the sidecar.
  if (mode === 'full') {
    if (entry.reason === undefined || entry.reason === null) {
      errors.push({ fingerprint: fp, field: 'reason', message: 'required in full mode' });
    } else if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      errors.push({
        fingerprint: fp,
        field: 'reason',
        message: 'must be a non-empty string',
      });
    }
    if (entry.addedBy === undefined || entry.addedBy === null) {
      errors.push({ fingerprint: fp, field: 'addedBy', message: 'required in full mode' });
    } else if (typeof entry.addedBy !== 'string' || entry.addedBy.trim().length === 0) {
      errors.push({
        fingerprint: fp,
        field: 'addedBy',
        message: 'must be a non-empty string',
      });
    }
  }
  if (!entry.addedAt || !/^\d{4}-\d{2}-\d{2}$/.test(entry.addedAt)) {
    errors.push({
      fingerprint: fp,
      field: 'addedAt',
      message: 'must be ISO date YYYY-MM-DD',
    });
  }
  if (requiresExpiry(entry.category)) {
    if (!entry.expiresAt) {
      errors.push({
        fingerprint: fp,
        field: 'expiresAt',
        message: `required for category ${JSON.stringify(entry.category)}`,
      });
    }
  }
  if (entry.expiresAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresAt)) {
    errors.push({
      fingerprint: fp,
      field: 'expiresAt',
      message: 'must be ISO date YYYY-MM-DD when present',
    });
  }
  // Note on acknowledgedSeverity: the rule "accepted-risk on a
  // high/critical finding requires acknowledgedSeverity" can't be
  // enforced from inside this validator — the finding's severity
  // doesn't live on the on-disk entry. The CLI's `allowlist add`
  // path enforces it at write time when the finding is in scope.
  return errors;
}

// ─── Internals ───────────────────────────────────────────────────────────

function isAllowlistMode(value: unknown): value is AllowlistMode {
  return typeof value === 'string' && (ALL_MODES as readonly string[]).includes(value);
}

function writeJsonPretty(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sanitizedEntry(entry: AllowlistEntry): AllowlistEntry {
  // Strip `reason` + `addedBy`; everything else stays on disk in the
  // committed file. The fingerprint contract preserves matching.
  // We intentionally rebuild via property assignment rather than
  // destructuring so the optional-undefined fields don't survive
  // serialization as explicit `null`s.
  const out: AllowlistEntry = {
    fingerprint: entry.fingerprint,
    kind: entry.kind,
    category: entry.category,
    addedAt: entry.addedAt,
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    ...(entry.acknowledgedSeverity !== undefined
      ? { acknowledgedSeverity: entry.acknowledgedSeverity }
      : {}),
  };
  return out;
}

function mergeReasons(file: AllowlistFile, sidecar: AllowlistReasonsSidecar): AllowlistFile {
  const merged = file.entries.map((entry) => {
    const r = sidecar.reasons[entry.fingerprint];
    if (!r) return entry;
    return { ...entry, reason: r.reason, addedBy: r.addedBy };
  });
  return { ...file, entries: merged };
}
