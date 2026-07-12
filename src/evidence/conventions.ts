/**
 * Evidence conventions — the shared vocabulary for dxkit's zero-write
 * evidence documents (`vyuh-dxkit evaluate`, `vyuh-dxkit describe`, and any
 * future trial/report surface that emits a shareable, versioned artifact).
 *
 * One module so the vocabulary cannot fork (the one-concept rule): every
 * evidence schema id is registered here APPEND-ONLY, every doc carries the
 * same envelope fields, and the epistemic-label enum has exactly one
 * definition. `test/evidence/conventions-freeze.test.ts` pins the registry
 * and the label set the same way the SDK wire-schema ids are pinned — a
 * shipped schema id is never removed or renamed; an incompatible shape
 * change is a NEW id (`…v2`) and readers up-convert at ingest.
 */
import { VERSION as DXKIT_VERSION } from '../constants';

/**
 * Registered evidence schema ids. APPEND-ONLY: removing or renaming an
 * entry breaks every consumer that version-gates on `doc.schema` — add a
 * `…v2` alongside instead and keep the v1 reader.
 */
export const EVIDENCE_SCHEMA_IDS = ['dxkit.evaluate-evidence.v1'] as const;

export type EvidenceSchemaId = (typeof EVIDENCE_SCHEMA_IDS)[number];

/**
 * How a fact in an evidence document is known. The honesty vocabulary
 * shared by every evidence surface (the repo card labels every field with
 * one of these; evaluate uses them for disclosure notes):
 *   - `observed`: dxkit parsed the source / ran the tool itself.
 *   - `derived`: taken from an artifact the repo declared (a spec, a
 *     committed contract) — trusted, but dxkit did not see the source.
 *   - `inferred`: heuristic, carries a confidence; may be wrong.
 *   - `unknown`: dxkit knows the fact exists but cannot resolve it
 *     (a dynamic call, a missing scanner, an unreachable participant).
 */
export const EPISTEMIC_LABELS = ['observed', 'derived', 'inferred', 'unknown'] as const;

export type EpistemicLabel = (typeof EPISTEMIC_LABELS)[number];

/**
 * The envelope every evidence document opens with. `schema` first so
 * downstream tooling can version-gate before reading further fields.
 */
export interface EvidenceEnvelope {
  readonly schema: EvidenceSchemaId;
  /** ISO-8601 timestamp of the run that produced the document. */
  readonly generatedAt: string;
  readonly dxkitVersion: string;
}

/** Build the envelope for a new evidence document. */
export function evidenceEnvelope(schema: EvidenceSchemaId): EvidenceEnvelope {
  return {
    schema,
    generatedAt: new Date().toISOString(),
    dxkitVersion: DXKIT_VERSION,
  };
}
