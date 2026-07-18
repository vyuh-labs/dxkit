/**
 * Wire-document validators — the field-precise gate between an extension's
 * emitted JSON and dxkit's machines.
 *
 * DX doctrine (the extension design's "errors are the docs"): a validation
 * failure names the exact field and what is wrong with it —
 * `inventory.v1: entities[3].fields[0].name must be a non-empty string` —
 * because for a rung-3 author iterating through `extensions dev`, the error
 * message IS the documentation. Every validator returns ALL errors it can
 * find (bounded below), not just the first, so one dev-loop iteration fixes
 * one emit's worth of mistakes.
 *
 * Forward-compatibility bias: UNKNOWN extra fields are tolerated everywhere
 * (an extension may carry its own bookkeeping alongside the contract; a
 * future minor may add optional fields that an older dxkit ignores).
 * Validation is strict about the fields the consuming machine reads and
 * silent about everything else.
 */

import type {
  WireContractDoc,
  WireExportReceipt,
  WireFindingsDoc,
  WireInventoryDoc,
} from '@vyuhlabs/dxkit-sdk';

/** Stop collecting after this many errors — a malformed 10k-entity emit
 *  should not produce a 10k-line wall; the first screenful is the signal. */
const MAX_ERRORS = 25;

class ErrorSink {
  readonly errors: string[] = [];
  constructor(private readonly schemaId: string) {}
  full(): boolean {
    return this.errors.length >= MAX_ERRORS;
  }
  add(path: string, problem: string): void {
    if (!this.full()) this.errors.push(`${this.schemaId}: ${path} ${problem}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

/** Require a non-empty string at `path`. */
function checkRequiredString(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    sink.add(
      `${path}.${key}`,
      v === undefined
        ? 'is missing (required, non-empty string)'
        : `must be a non-empty string (got ${describe(v)})`,
    );
  }
}

/** Optional string: absent is fine; present must be a string. */
function checkOptionalString(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  const v = obj[key];
  if (v !== undefined && typeof v !== 'string') {
    sink.add(`${path}.${key}`, `must be a string when present (got ${describe(v)})`);
  }
}

/**
 * Why a `file` value is NOT a repo-relative POSIX path, or null when it is
 * (S-15 / 4.0.4). The wire contract PROMISES repo-relative POSIX locators —
 * they feed finding identity (Rule 9) and topology evidence — but the
 * validators accepted any string, so absolute paths, traversal, drive
 * prefixes, and backslashes could enter fingerprints (the exact class the
 * 3.8 parseLocated boundary closed for linters). A protocol invariant is
 * VALIDATED at the boundary, never assumed.
 */
function fileLocatorError(v: string): string | null {
  if (v.includes('\0')) return 'must not contain NUL bytes';
  if (v.startsWith('/') || v.startsWith('\\'))
    return 'must be repo-relative (got an absolute path)';
  if (/^[A-Za-z]:/.test(v)) return 'must be repo-relative (got a drive-prefixed path)';
  if (v.includes('\\')) return 'must use POSIX separators (got a backslash)';
  const segs = v.split('/');
  if (segs.some((seg) => seg === '..')) return "must not traverse ('..' segment)";
  if (segs.some((seg) => seg === ''))
    return 'must not contain empty segments (leading/double slash)';
  return null;
}

/** `file` locator, required: non-empty string AND a valid repo-relative
 *  POSIX path. */
function checkRequiredFile(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  checkRequiredString(sink, obj, key, path);
  const v = obj[key];
  if (typeof v === 'string' && v.length > 0) {
    const err = fileLocatorError(v);
    if (err) sink.add(`${path}.${key}`, `${err} (got ${JSON.stringify(v)})`);
  }
}

/** `file` locator, optional: absent fine; present must be a valid
 *  repo-relative POSIX path. */
function checkOptionalFile(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  checkOptionalString(sink, obj, key, path);
  const v = obj[key];
  if (typeof v === 'string') {
    const err = fileLocatorError(v);
    if (err) sink.add(`${path}.${key}`, `${err} (got ${JSON.stringify(v)})`);
  }
}

/** Optional 1-based line number: absent fine; present must be a positive integer. */
function checkOptionalLine(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
): void {
  const v = obj[key];
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    sink.add(
      `${path}.${key}`,
      `must be a positive integer (1-based line) when present (got ${JSON.stringify(v)})`,
    );
  }
}

/** Optional meta payload: absent fine; present must be a plain object. */
function checkOptionalMeta(sink: ErrorSink, obj: Record<string, unknown>, path: string): void {
  const v = obj['meta'];
  if (v !== undefined && !isObject(v)) {
    sink.add(`${path}.meta`, `must be an object when present (got ${describe(v)})`);
  }
}

/**
 * Walk an optional array field: absent is fine; present must be an array of
 * objects, each handed to `each`. Returns early once the sink is full.
 */
function checkOptionalArray(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
  each: (item: Record<string, unknown>, itemPath: string) => void,
): void {
  const v = obj[key];
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    sink.add(`${path}${key}`, `must be an array when present (got ${describe(v)})`);
    return;
  }
  v.forEach((item, i) => {
    if (sink.full()) return;
    const itemPath = `${path}${key}[${i}]`;
    if (!isObject(item)) {
      sink.add(itemPath, `must be an object (got ${describe(item)})`);
      return;
    }
    each(item, itemPath);
  });
}

/** Like checkOptionalArray but the field is required. */
function checkRequiredArray(
  sink: ErrorSink,
  obj: Record<string, unknown>,
  key: string,
  path: string,
  each: (item: Record<string, unknown>, itemPath: string) => void,
): void {
  if (obj[key] === undefined) {
    sink.add(`${path}${key}`, 'is missing (required array)');
    return;
  }
  checkOptionalArray(sink, obj, key, path, each);
}

/** Shared shell: doc must be an object whose `schema` is exactly `schemaId`. */
function checkShell(
  sink: ErrorSink,
  raw: unknown,
  schemaId: string,
): raw is Record<string, unknown> {
  if (!isObject(raw)) {
    sink.add('document', `must be a JSON object (got ${describe(raw)})`);
    return false;
  }
  if (raw['schema'] !== schemaId) {
    sink.add('schema', `must be the string '${schemaId}' (got ${JSON.stringify(raw['schema'])})`);
    return false;
  }
  return true;
}

// ── contract.v1 ─────────────────────────────────────────────────────────────

export function validateContractV1(raw: unknown): string[] {
  const sink = new ErrorSink('contract.v1');
  if (!checkShell(sink, raw, 'contract.v1')) return sink.errors;
  checkOptionalArray(sink, raw, 'consumed', '', (item, p) => {
    checkRequiredString(sink, item, 'method', p);
    checkRequiredString(sink, item, 'url', p);
    checkOptionalFile(sink, item, 'file', p);
    checkOptionalLine(sink, item, 'line', p);
    checkOptionalMeta(sink, item, p);
  });
  checkOptionalArray(sink, raw, 'served', '', (item, p) => {
    checkRequiredString(sink, item, 'method', p);
    checkRequiredString(sink, item, 'path', p);
    checkOptionalString(sink, item, 'handler', p);
    checkOptionalFile(sink, item, 'file', p);
    checkOptionalLine(sink, item, 'line', p);
    checkOptionalMeta(sink, item, p);
  });
  checkOptionalArray(sink, raw, 'dynamicCalls', '', (item, p) => {
    checkRequiredString(sink, item, 'receiver', p);
    checkOptionalFile(sink, item, 'file', p);
    checkOptionalLine(sink, item, 'line', p);
  });
  return sink.errors;
}

// ── inventory.v1 ────────────────────────────────────────────────────────────

export function validateInventoryV1(raw: unknown): string[] {
  const sink = new ErrorSink('inventory.v1');
  if (!checkShell(sink, raw, 'inventory.v1')) return sink.errors;
  checkRequiredArray(sink, raw, 'entities', '', (entity, p) => {
    checkRequiredString(sink, entity, 'kind', p);
    checkRequiredString(sink, entity, 'name', p);
    checkOptionalFile(sink, entity, 'file', p);
    checkOptionalLine(sink, entity, 'line', p);
    checkOptionalMeta(sink, entity, p);
    checkOptionalArray(sink, entity, 'fields', `${p}.`, (field, fp) => {
      checkRequiredString(sink, field, 'name', fp);
      checkOptionalString(sink, field, 'type', fp);
      const opt = field['optional'];
      if (opt !== undefined && typeof opt !== 'boolean') {
        sink.add(`${fp}.optional`, `must be a boolean when present (got ${describe(opt)})`);
      }
    });
    checkOptionalArray(sink, entity, 'relations', `${p}.`, (rel, rp) => {
      checkRequiredString(sink, rel, 'kind', rp);
      checkRequiredString(sink, rel, 'target', rp);
    });
  });
  return sink.errors;
}

// ── findings.v1 ─────────────────────────────────────────────────────────────

const WIRE_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

export function validateFindingsV1(raw: unknown): string[] {
  const sink = new ErrorSink('findings.v1');
  if (!checkShell(sink, raw, 'findings.v1')) return sink.errors;
  checkRequiredArray(sink, raw, 'findings', '', (finding, p) => {
    checkRequiredString(sink, finding, 'rule', p);
    checkRequiredString(sink, finding, 'message', p);
    checkRequiredFile(sink, finding, 'file', p);
    const sev = finding['severity'];
    if (typeof sev !== 'string' || !WIRE_SEVERITIES.has(sev)) {
      sink.add(
        `${p}.severity`,
        `must be one of 'critical' | 'high' | 'medium' | 'low' (got ${JSON.stringify(sev)})`,
      );
    }
    checkOptionalLine(sink, finding, 'line', p);
    checkOptionalMeta(sink, finding, p);
  });
  return sink.errors;
}

// ── export.v1 ───────────────────────────────────────────────────────────────

export function validateExportV1(raw: unknown): string[] {
  const sink = new ErrorSink('export.v1');
  if (!checkShell(sink, raw, 'export.v1')) return sink.errors;
  const delivered = raw['delivered'];
  if (typeof delivered !== 'boolean') {
    sink.add(
      'delivered',
      delivered === undefined
        ? 'is missing (required boolean)'
        : `must be a boolean (got ${describe(delivered)})`,
    );
  }
  checkOptionalString(sink, raw, 'detail', 'document');
  return sink.errors;
}

// Narrowing casts for post-validation use. Safe ONLY after the matching
// validator returned zero errors — the registry's parse path enforces that
// ordering, and nothing else may call these.
export const castContractV1 = (raw: unknown): WireContractDoc => raw as WireContractDoc;
export const castInventoryV1 = (raw: unknown): WireInventoryDoc => raw as WireInventoryDoc;
export const castFindingsV1 = (raw: unknown): WireFindingsDoc => raw as WireFindingsDoc;
export const castExportV1 = (raw: unknown): WireExportReceipt => raw as WireExportReceipt;
