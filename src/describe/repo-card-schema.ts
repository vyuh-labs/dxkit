/**
 * `dxkit.repo-card.v1` — the versioned, zero-write repo card.
 *
 * A shareable snapshot of what dxkit can see about a repo: its stack, its
 * HTTP flow spine (routes served, calls made, how they bind), its data
 * models, and — the honest part — how MUCH of that dxkit actually resolved
 * versus inferred or could not see. Every count is broken down by
 * `EpistemicLabel` so the reader can trust the picture (see the label
 * mapping in `repo-card.ts`).
 *
 * Contract discipline (mirror of `dxkit.evaluate-evidence.v1`): the schema id
 * is registered append-only in `src/evidence/conventions.ts`; the top-level
 * field set is pinned by `test/describe/repo-card-freeze.test.ts`. A field
 * ADDITION needs review; a REMOVAL or reshape is a new `…v2` id with the v1
 * reader kept.
 */
import type { EpistemicLabel, EvidenceEnvelope } from '../evidence/conventions';

export const REPO_CARD_SCHEMA = 'dxkit.repo-card.v1' as const;

/** A count of facts, split by how each one is known. Sums to `total`. */
export interface LabeledCounts {
  readonly total: number;
  readonly observed: number;
  readonly derived: number;
  readonly inferred: number;
  readonly unknown: number;
}

/** Which git state produced the card (a dirty tree is itself a card fact). */
export interface RepoCardProvenance {
  readonly commitSha: string;
  readonly branch: string;
  readonly workingTreeDirty: boolean;
}

/** Observed stack facts (parsed by dxkit itself → always `observed`). */
export interface RepoCardStack {
  readonly name: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly framework: string | null;
  readonly infrastructure: readonly string[];
}

/**
 * The HTTP flow spine. `routes` are served endpoints, `calls` are outbound
 * client calls, `bindings` are the resolved call→route joins. `seams` are
 * the gaps: calls that reach no served route, and served routes nothing
 * calls — the part a linter cannot see.
 */
export interface RepoCardFlow {
  readonly routes: LabeledCounts;
  readonly calls: LabeledCounts;
  readonly bindings: LabeledCounts;
  /** Client calls dxkit could not resolve to a served route (integration gaps). */
  readonly unresolvedCalls: number;
  /** Served routes no observed call consumes (dead-surface candidates). */
  readonly unconsumedRoutes: number;
  /** Call sites whose URL is computed at runtime — unresolvable by construction. */
  readonly dynamicCalls: number;
  /** How the consumed side was located; always inferred. */
  readonly connectionRung: string;
}

/** The declared data-model surface. */
export interface RepoCardModels {
  readonly models: LabeledCounts;
  /** Models whose shape is computed at runtime — unresolvable by construction. */
  readonly dynamicModels: number;
}

/** Contract freshness, when the repo commits a served contract; else null. */
export interface RepoCardFreshness {
  readonly generatedAt: string;
  readonly commitSha: string | null;
  readonly stale: boolean;
  readonly participants: number;
}

/**
 * Honesty block: how much of the flow surface dxkit actually saw. Mirrors
 * `FlowCoverage` — the denominator for every count above.
 */
export interface RepoCardCoverage {
  readonly callSitesSeen: number;
  readonly extracted: number;
  readonly dynamic: number;
  readonly paths: { readonly exact: number; readonly templated: number; readonly opaque: number };
  readonly note: string;
}

/** A single labeled headline the card wants to surface, for renderers. */
export interface RepoCardHighlight {
  readonly label: EpistemicLabel;
  readonly text: string;
}

export interface RepoCardDoc extends EvidenceEnvelope {
  readonly schema: typeof REPO_CARD_SCHEMA;
  readonly provenance: RepoCardProvenance;
  readonly stack: RepoCardStack;
  readonly flow: RepoCardFlow;
  readonly models: RepoCardModels;
  readonly freshness: RepoCardFreshness | null;
  readonly coverage: RepoCardCoverage;
  /** Human-readable disclosures (what was not measured, what is inferred). */
  readonly notes: readonly string[];
  /** Confirmation that producing this card wrote nothing to the repo. */
  readonly zeroWrite: true;
}
