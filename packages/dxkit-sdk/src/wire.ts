/**
 * The extension wire schemas — the versioned JSON documents an external
 * extension emits (rung 3 of the effort ladder: any language, any runtime,
 * one JSON document out).
 *
 * An extension receives its config block as JSON on stdin, runs with the
 * repo root as cwd, and emits ONE document below on stdout (or writes it to
 * its manifest-declared `output` path). dxkit validates the document
 * against its declared `schema` id and routes it into the same machines
 * native output flows through: contract documents join the flow model,
 * inventory entities become trend-able/diff-able snapshots, findings enter
 * the canonical identity + baseline + allowlist machine, and export
 * receipts report a delivery sink's outcome.
 *
 * Versioning contract (load-bearing — the Rule 9 migration arc applied to
 * the wire): a shipped schema version is NEVER retired. When `contract.v2`
 * ships, `contract.v1` documents keep being read (dxkit up-converts at
 * ingest through one canonical up-converter per kind). An extension emits
 * the version it targets; a committed snapshot is never stranded by a
 * dxkit upgrade.
 *
 * Shapes are deliberately minimal-plus-`meta`: required fields are what the
 * consuming machine needs; `meta` carries anything extension-specific and
 * rides along untouched (rendered where a surface opts in, never load-
 * bearing for identity or verdicts).
 */

/** Severity vocabulary for wire findings — dxkit's four-tier convention. */
export type WireSeverity = 'critical' | 'high' | 'medium' | 'low';

// ── contract.v1 ─────────────────────────────────────────────────────────────

/**
 * An outbound HTTP call the extension observed (the CONSUMED side).
 * `url` may be raw or already path-shaped — dxkit re-normalizes every wire
 * URL through the ONE shared normalizer (`normalizePath`) at ingest, so an
 * extension never needs to (and must not) replicate normalization.
 */
export interface WireConsumedCall {
  /** HTTP verb. Case-insensitive on the wire; canonicalized at ingest. */
  method: string;
  /** The URL / path as observed. Re-normalized by dxkit at ingest. */
  url: string;
  /** Repo-relative POSIX path of the source of this observation. */
  file?: string;
  /** 1-based line, when the observation has one. */
  line?: number;
  /** Extension-specific payload; carried through, never load-bearing. */
  meta?: Record<string, unknown>;
}

/** An inbound route the extension observed being served (the SERVED side). */
export interface WireServedRoute {
  /** HTTP verb, or `ANY` for a method-agnostic binding. */
  method: string;
  /** The route path as declared. Re-normalized by dxkit at ingest. */
  path: string;
  /** Handler name, when known. */
  handler?: string;
  /** Repo-relative POSIX path of the source of this observation. */
  file?: string;
  /** 1-based line, when the observation has one. */
  line?: number;
  /** Extension-specific payload; carried through, never load-bearing. */
  meta?: Record<string, unknown>;
}

/**
 * A call site the extension RECOGNIZED as HTTP but could not extract a
 * concrete URL for — the coverage-honesty channel. Counted, never silently
 * dropped: these are the calls flow discloses it cannot verify.
 */
export interface WireDynamicCall {
  /** What made the site recognizable (a receiver, wrapper, or tool name). */
  receiver: string;
  file?: string;
  line?: number;
}

/**
 * `contract.v1` — consumed calls and/or served routes, joining the flow
 * machine exactly as AST-extracted and spec-declared contract evidence do
 * (`via` provenance records the extension as the source).
 */
export interface WireContractDoc {
  schema: 'contract.v1';
  consumed?: WireConsumedCall[];
  served?: WireServedRoute[];
  dynamicCalls?: WireDynamicCall[];
}

// ── inventory.v1 ────────────────────────────────────────────────────────────

/** One field of an inventory entity (mirror of a model field). */
export interface WireInventoryField {
  name: string;
  /** Type token, compared lexically within the extension's own vocabulary. */
  type?: string;
  optional?: boolean;
}

/** A typed relation from this entity to another (`target` names it). */
export interface WireInventoryRelation {
  /** Relation kind in the extension's vocabulary (`contains`, `links-to`). */
  kind: string;
  /** The `kind:name` or bare `name` of the target entity. */
  target: string;
}

/**
 * A named entity in the extension's domain — a screen, a tab, a permission,
 * an activity-log event. `kind` is the extension's own vocabulary; dxkit
 * treats entities of one kind as a diffable, trend-able set (the same way
 * data models are), keyed by `(kind, name)`.
 */
export interface WireInventoryEntity {
  kind: string;
  name: string;
  /** Repo-relative POSIX path where this entity is declared, when known. */
  file?: string;
  line?: number;
  fields?: WireInventoryField[];
  relations?: WireInventoryRelation[];
  /** Extension-specific payload; carried through, never load-bearing. */
  meta?: Record<string, unknown>;
}

/** `inventory.v1` — the extension's entity inventory (snapshot semantics). */
export interface WireInventoryDoc {
  schema: 'inventory.v1';
  entities: WireInventoryEntity[];
}

// ── findings.v1 ─────────────────────────────────────────────────────────────

/**
 * A finding the extension asserts about the repo. Enters the canonical
 * identity machine via a registered producer: located findings (with
 * `line`) diff net-new like a linter's (pre-existing backlog grandfathered,
 * net-new blocks per policy); a finding without `line` is whole-file.
 */
export interface WireFinding {
  /** Stable rule id within this extension (`no-unguarded-permission`). */
  rule: string;
  /** Human-readable, single-finding message. */
  message: string;
  severity: WireSeverity;
  /** Repo-relative POSIX path the finding is about. */
  file: string;
  /** 1-based line. Omit for a whole-file finding. */
  line?: number;
  /** Extension-specific payload; carried through, never load-bearing. */
  meta?: Record<string, unknown>;
}

/** `findings.v1` — findings entering the baseline/allowlist/gate machine. */
export interface WireFindingsDoc {
  schema: 'findings.v1';
  findings: WireFinding[];
}

// ── export.v1 ───────────────────────────────────────────────────────────────

/**
 * `export.v1` — the receipt an export (sink) extension RETURNS. Export
 * extensions receive dxkit's post-run JSON (report / verdict) and deliver
 * it wherever they like (a dashboard, a spreadsheet, an email); the receipt
 * reports the outcome so doctor and the refresh surface can display sink
 * health. A failed delivery is disclosed, never a broken gate.
 */
export interface WireExportReceipt {
  schema: 'export.v1';
  delivered: boolean;
  /** Human-readable delivery detail (destination, count, error text). */
  detail?: string;
}

// ── The schema-id registry ──────────────────────────────────────────────────

/**
 * Every shipped wire-schema id. Append-only by contract: ids are added
 * (new kinds, new versions), never removed. Pinned by the main repo's
 * `test/sdk-surface-freeze.test.ts`.
 */
export const WIRE_SCHEMA_IDS = ['contract.v1', 'inventory.v1', 'findings.v1', 'export.v1'] as const;

export type WireSchemaId = (typeof WIRE_SCHEMA_IDS)[number];

/** The union of every wire document an extension can emit. */
export type WireDoc = WireContractDoc | WireInventoryDoc | WireFindingsDoc | WireExportReceipt;
