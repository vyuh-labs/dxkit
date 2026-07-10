/**
 * Cross-repo flow contract snapshots under `.dxkit/flow/`.
 *
 * The integration gate is cross-repo: each side publishes its inventory as a
 * committed artifact the OTHER side gates against (mirror of the ingest
 * snapshot pattern, CLAUDE.md Rule 13). A backend refreshes `served.json`
 * (every `(method, path)` it serves); a frontend refreshes `consumed.json`
 * (every binding it depends on). A repo commits the COUNTERPART's snapshot (or
 * a monorepo computes both live), so the gate needs a cross-repo fetch/token
 * only at refresh time — never on the developer's machine or in the per-stop
 * gate.
 *
 * This module is the single reader/writer of `.dxkit/flow/`: confining the path
 * here (arch-check enforced) stops the "different modules pick different
 * defaults" drift class and keeps a future cross-repo fetch composing on one
 * primitive. Snapshots carry only finding data (normalized method/path/file) —
 * no token, no account id — so they are safe to commit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { consumedPathConfidence, dedupeServedRoutes, type FlowModel } from './model';

/** Directory (relative to repo root) where flow contract snapshots live. */
export const FLOW_DIR = path.join('.dxkit', 'flow');
export const SERVED_SNAPSHOT = 'served.json';
export const CONSUMED_SNAPSHOT = 'consumed.json';

/** Current schema version of the committed `served.json` / `consumed.json`
 *  snapshots (the `schemaVersion` literal on `SnapshotMeta`). Named here so the
 *  freeze contract has one referenceable constant; pinned by
 *  `test/flow-contract-freeze.test.ts`. */
export const SERVED_CONSUMED_SCHEMA_VERSION = 1;

/** One served endpoint in the served-side inventory. */
export interface ServedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: string | null;
  readonly via: 'decorator' | 'router-call' | 'file-route' | 'spec';
}

/** One binding in the consumed-side inventory — a UI call site's dependency on
 *  a served `(method, path)`. `file` + the normalized key are the flow-binding
 *  identity inputs; `line` is display metadata (never hashed). `confidence` in
 *  [0,1] is the path-specificity signal the gate thresholds on — a
 *  placeholder-only path (`/{var}`) is too generic to block a build. */
export interface ConsumedBinding {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
  readonly confidence: number;
}

interface SnapshotMeta {
  readonly schemaVersion: 1;
  /** ISO timestamp, stamped by the caller so this module stays clock-free
   *  (testability — mirror of ingest/snapshot.ts). */
  readonly generatedAt: string;
  /** Commit the snapshot was produced against, when known. */
  readonly commitSha?: string;
  /** Change-detection digest of the contract's contents — lets a consumer see
   *  that a published contract drifted (routes changed) even when the commit or
   *  timestamp did not carry the signal. Set by `flow publish`. */
  readonly contentHash?: string;
}

/** Where a participant's served routes came from at publish time.
 *   - `local`       — a local checkout's working tree
 *   - `ref`         — a local checkout pinned at a git ref
 *   - `remote`      — cloned from the participant's `repo:` URL (shallow)
 *   - `missing`     — no local checkout and no `repo` to fall back to
 *   - `unreachable` — a `repo:` clone/fetch failed (bad URL, auth, unknown ref) */
export type ParticipantSource = 'local' | 'ref' | 'remote' | 'missing' | 'unreachable';

/** Per-participant provenance recorded on a published served contract — the
 *  staleness signal: WHICH commit each participant's routes were gathered at.
 *  Additive on schema v1 (older readers ignore it); doctor compares `sha`
 *  against the participant's current tip to disclose a snapshot that has
 *  fallen behind its provider. */
export interface ParticipantProvenance {
  readonly name: string;
  readonly source: ParticipantSource;
  /** Routes this participant contributed to the mesh. */
  readonly routes: number;
  /** Commit the participant's routes were gathered at, when resolvable. */
  readonly sha?: string;
  /** Ref the participant was pinned at (from workspace.json), when declared. */
  readonly ref?: string;
}

export interface ServedContract extends SnapshotMeta {
  readonly side: 'served';
  readonly routes: ServedRoute[];
  /** Present on mesh publishes (`flow publish` with workspace participants). */
  readonly participants?: readonly ParticipantProvenance[];
}

export interface ConsumedContract extends SnapshotMeta {
  readonly side: 'consumed';
  readonly bindings: ConsumedBinding[];
}

/** The `${method} ${path}` join key both sides meet on. */
export function contractKey(method: string, routePath: string): string {
  return `${method} ${routePath}`;
}

/**
 * A short, stable content digest of a served route set. Lets a consumer detect
 * that a published contract drifted (routes added/removed) even when the commit
 * SHA or timestamp did not carry the signal. Non-cryptographic (FNV-1a): this
 * is a change-detection digest, NOT a finding identity, so it deliberately does
 * not route through the fingerprint helpers (Rule 9 governs identity, not this).
 */
export function servedContentHash(routes: readonly ServedRoute[]): string {
  const canon = routes
    .map((r) => contractKey(r.method, r.path))
    .sort()
    .join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ─── Build (from a flow model) ────────────────────────────────────────────────

/**
 * The served inventory: every distinct `(method, path)` this repo serves,
 * deduped via the shared helper (spec wins). Sorted for byte-stable snapshots
 * across runs (a committed artifact should not churn on extraction order).
 */
export function buildServedContract(model: FlowModel, meta: SnapshotMeta): ServedContract {
  const routes = dedupeServedRoutes(model.routes)
    .map((r) => ({ method: r.method, path: r.path, handler: r.handler, via: r.via }))
    .sort(byMethodPath);
  return { ...meta, side: 'served', routes };
}

/**
 * The consumed inventory: every internal binding this repo depends on — each
 * client call that resolved to an internal path (external/absolute URLs, whose
 * `path` is null, are not internal integrations). Deduped by
 * `(method, path, file)` — the flow-binding identity — so multiple call sites
 * for one dependency collapse to one entry (the earliest line kept for
 * display). Sorted for byte-stability.
 */
export function buildConsumedContract(model: FlowModel, meta: SnapshotMeta): ConsumedContract {
  const byKey = new Map<string, ConsumedBinding>();
  for (const call of model.calls) {
    if (call.path == null) continue;
    const key = `${call.method}\0${call.path}\0${call.file}`;
    const existing = byKey.get(key);
    if (!existing || call.line < existing.line) {
      byKey.set(key, {
        method: call.method,
        path: call.path,
        file: call.file,
        line: call.line,
        // Path-intrinsic confidence: a path with no leading anchor (all-
        // placeholder, or an opaque leading `{var}` that could resolve under any
        // namespace) is low-confidence, so the gate warns rather than blocks.
        confidence: consumedPathConfidence(call.path),
      });
    }
  }
  const bindings = [...byKey.values()].sort(
    (a, b) => byMethodPath(a, b) || a.file.localeCompare(b.file),
  );
  return { ...meta, side: 'consumed', bindings };
}

function byMethodPath(
  a: { method: string; path: string },
  b: { method: string; path: string },
): number {
  return a.method.localeCompare(b.method) || a.path.localeCompare(b.path);
}

// ─── Persist ──────────────────────────────────────────────────────────────────

/** Write the served snapshot (overwrite). Returns the file path. */
export function writeServedContract(cwd: string, contract: ServedContract): string {
  return writeSnapshot(cwd, SERVED_SNAPSHOT, contract);
}

/** Write the consumed snapshot (overwrite). Returns the file path. */
export function writeConsumedContract(cwd: string, contract: ConsumedContract): string {
  return writeSnapshot(cwd, CONSUMED_SNAPSHOT, contract);
}

function writeSnapshot(
  cwd: string,
  name: string,
  contract: ServedContract | ConsumedContract,
): string {
  const dir = path.join(cwd, FLOW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(contract, null, 2) + '\n', 'utf-8');
  return file;
}

// ─── Load (fail-open) ───────────────────────────────────────────────────────

/**
 * Read the served snapshot from a repo root (default `.dxkit/flow/served.json`,
 * or an explicit path for a counterpart's committed snapshot). Fail-open: a
 * missing / unreadable / malformed file yields `undefined`, never a throw — the
 * gate degrades to "no contract to check against", never an error.
 */
export function readServedContract(cwd: string, filePath?: string): ServedContract | undefined {
  const raw = readJson(filePath ?? path.join(cwd, FLOW_DIR, SERVED_SNAPSHOT));
  return isServed(raw) ? raw : undefined;
}

/** Read the consumed snapshot (see {@link readServedContract}). */
export function readConsumedContract(cwd: string, filePath?: string): ConsumedContract | undefined {
  const raw = readJson(filePath ?? path.join(cwd, FLOW_DIR, CONSUMED_SNAPSHOT));
  return isConsumed(raw) ? raw : undefined;
}

/** The `${method} ${path}` keys a served contract exposes — the O(1) lookup the
 *  gate uses to check whether a consumed binding still resolves. */
export function servedKeySet(contract: ServedContract): Set<string> {
  return new Set(contract.routes.map((r) => contractKey(r.method, r.path)));
}

function readJson(absPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function isServed(v: unknown): v is ServedContract {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as ServedContract).side === 'served' &&
    Array.isArray((v as ServedContract).routes)
  );
}

function isConsumed(v: unknown): v is ConsumedContract {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as ConsumedContract).side === 'consumed' &&
    Array.isArray((v as ConsumedContract).bindings)
  );
}
