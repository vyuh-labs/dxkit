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

// ── verdict.v1 ──────────────────────────────────────────────────────────────

/**
 * The engine identity a verdict names — reproducibility's first field: a
 * receipt that cannot say what produced it cannot be re-verified.
 */
export interface WireVerdictEngine {
  name: string;
  version: string;
}

/**
 * The policy the verdict was judged under. `hash` is always present (the
 * policy content hash the engine actually used); `id` + `version` are the
 * author-declared name of the policy document when it carries one — a
 * verdict under `acme.dod/1` is distinguishable from one under
 * `acme.dod/2` by name, not just by hash.
 */
export interface WireVerdictPolicy {
  id?: string;
  version?: string;
  hash: string;
}

/** The three-way outcome. `cannot_gate` is the refusal tier: the engine
 *  could not attribute a block-rule-class delta, so it refuses to certify
 *  rather than guessing (never rendered as a pass). */
export type WireVerdictStatus = 'passed' | 'blocked' | 'cannot_gate';

/** One finding that counts toward the verdict (blocking or warning). */
export interface WireVerdictFinding {
  /** dxkit finding kind (`secret`, `custom-check`, `dep-vuln`, …). */
  kind: string;
  severity?: WireSeverity;
  /** Rule / check label when the kind carries one. */
  rule?: string;
  /** Repo-relative POSIX path, when located. */
  file?: string;
  /** 1-based line, when located. */
  line?: number;
  message?: string;
  /** The durable canonical identity (Rule 9) — stable across runs and
   *  environments; the handle allowlists and baselines key on. */
  fingerprint: string;
  /** True = counts toward `blocked`; false = a warning. */
  blocking: boolean;
}

/**
 * One named check's outcome. `skipped` is NEVER silent: it always carries
 * `cause` (the shared acceptance philosophy — a skipped check is not a
 * passed check, and the verdict says why it did not run).
 */
export interface WireVerdictCheck {
  /** Stable check id (`custom:no_placeholder`, `deps.vulnerabilities`,
   *  `gate.flow`, `floor.typescript:syntax`, …). */
  id: string;
  status: 'passed' | 'failed' | 'skipped';
  /** REQUIRED when status is `skipped`. */
  cause?: string;
}

/** The correctness floor's slice of the verdict. */
export interface WireVerdictFloor {
  ran: boolean;
  /** Present when `ran` is false — the declared cause. */
  skippedWithCause?: string;
  /** Per-command outcomes when the floor ran. */
  checks?: WireVerdictCheck[];
}

/**
 * `verdict.v1` — the machine-readable gate verdict + receipt (the fleet
 * verification-receipt's unsigned core). Emitted by `vyuh-dxkit gate
 * --json`; consumed by workbenches that render the soundness panel
 * themselves ("we render, dxkit decides"). Reproducible by construction:
 * it names the engine, the policy (id/version/hash), and the prior mode
 * that produced it.
 */
export interface WireVerdictDoc {
  schema: 'verdict.v1';
  engine: WireVerdictEngine;
  policy: WireVerdictPolicy;
  status: WireVerdictStatus;
  /** The gate's exit-code contract: 0 passed / 1 blocked / 2 cannot_gate. */
  exitCode: 0 | 1 | 2;
  /** Prior mode the subject was judged under (`fresh`, `tree-baseline`,
   *  `committed-full`, `ref-based`, …) — attribution semantics differ by
   *  prior, so an honest receipt names it. */
  mode: string;
  findings: WireVerdictFinding[];
  checks: WireVerdictCheck[];
  floor: WireVerdictFloor;
  /** Populated when `status` is `cannot_gate`: what could not be
   *  attributed and the remedy. */
  refusals?: { reason: string; remedy?: string }[];
  /** The human rendering, embeddable in an exported package. */
  receipt: string;
  /** Emitter-specific payload; carried through, never load-bearing. */
  meta?: Record<string, unknown>;
}

// ── flow.v1 ─────────────────────────────────────────────────────────────────

/** One step of a declared flow: a consumed `(method, path)` that must
 *  resolve against the composed served surface. Either the split form
 *  or the compact `call: 'GET /orders'` string. */
export interface WireFlowStep {
  method?: string;
  path?: string;
  /** Compact `'<METHOD> <path>'` form; parsed at ingest. */
  call?: string;
  /** Informational: which member is expected to serve it. Never
   *  load-bearing — resolution is against the WHOLE mesh. */
  package?: string;
  meta?: Record<string, unknown>;
}

/** A declared end-to-end flow: an ordered set of steps that must ALL
 *  resolve for the flow to count as complete. Identity is the `id`
 *  alone (the paired-change doctrine — never the matched member set,
 *  so an iterating estate doesn't churn identity). */
export interface WireFlow {
  id: string;
  description?: string;
  steps: WireFlowStep[];
  meta?: Record<string, unknown>;
}

/**
 * `flow.v1` — externally-declared expected flows (4.4.0 WP7 / P2-6).
 * A consumer compiles its own knowledge of the estate (consumer apps,
 * shared tables, service contracts) into these descriptors; the wave
 * gate evaluates "does every declared flow still complete" against the
 * composed served surface of all members. dxkit re-normalizes every
 * step path through the ONE shared normalizer at ingest.
 */
export interface WireFlowDoc {
  schema: 'flow.v1';
  flows: WireFlow[];
}

// ── The schema-id registry ──────────────────────────────────────────────────

/**
 * Every shipped wire-schema id. Append-only by contract: ids are added
 * (new kinds, new versions), never removed. Pinned by the main repo's
 * `test/sdk-surface-freeze.test.ts`.
 */
export const WIRE_SCHEMA_IDS = [
  'contract.v1',
  'inventory.v1',
  'findings.v1',
  'export.v1',
  'verdict.v1',
  'flow.v1',
] as const;

export type WireSchemaId = (typeof WIRE_SCHEMA_IDS)[number];

/** The union of every wire document an extension can emit. Deliberately
 *  EXCLUDES `verdict.v1`: a verdict is what dxkit EMITS about a tree,
 *  never a document an extension feeds in. */
export type WireDoc = WireContractDoc | WireInventoryDoc | WireFindingsDoc | WireExportReceipt;
