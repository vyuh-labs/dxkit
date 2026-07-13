/**
 * Gather the read-only inputs for a repo card. Every source here is a
 * canonical Rule-2 entry point that loads its own policy/overlay and is
 * verified zero-write:
 *   - `detect` (stack facts),
 *   - `gatherRepoFlowModel` (the flow spine),
 *   - `diagnoseFlow` (the seams: unresolved calls + unconsumed routes),
 *   - `gatherRepoModelSet` (the data models),
 *   - `contractFreshness` (freshness, probed OFFLINE — see below).
 *
 * Offline by construction: `diagnoseFlow` freshness-probes the network by
 * default, so the card computes freshness itself via
 * `contractFreshness(cwd, () => null)` and ignores the diagnosis' own
 * `contract` field. Nothing here writes to disk.
 */
import { detect } from '../detect';
import type { DetectedStack } from '../types';
import { gatherRepoFlowModel } from '../analyzers/flow/gather';
import { diagnoseFlow, flowCoverage } from '../analyzers/flow/diagnose';
import type { FlowModel } from '../analyzers/flow/model';
import type { FlowDiagnosis, FlowCoverage } from '../analyzers/flow/diagnose';
import { gatherRepoModelSet } from '../analyzers/model-schema/gather';
import type { ModelSet } from '../analyzers/model-schema/model';
import { contractFreshness } from '../analyzers/flow/staleness';
import type { ContractFreshness } from '../analyzers/flow/staleness';
import { resolveProvenance, type ResolvedProvenance } from '../analyzers/cache';

/** The raw, read-only material a repo card is built from. */
export interface DescribeInput {
  readonly stack: DetectedStack;
  readonly provenance: ResolvedProvenance;
  readonly flow: FlowModel;
  /** null when no flow-capable pack is active / extraction is empty. */
  readonly diagnosis: FlowDiagnosis | null;
  readonly coverage: FlowCoverage;
  readonly models: ModelSet;
  /** null when the repo commits no served contract. */
  readonly freshness: ContractFreshness | null;
}

/**
 * Collect everything the card needs. Fail-soft on the optional lanes: a
 * repo with no flow-capable pack still gets a card (empty flow + null
 * diagnosis), so `describe` never errors out on a stack it only partly
 * understands.
 */
export async function gatherDescribeInput(cwd: string): Promise<DescribeInput> {
  const stack = detect(cwd);
  const provenance = resolveProvenance(cwd);

  const flow = await gatherRepoFlowModel(cwd);
  const diagnosis = await diagnoseFlow(cwd);
  const models = await gatherRepoModelSet(cwd);

  // Freshness OFFLINE: never touch the network from a zero-write trial card.
  const freshness = contractFreshness(cwd, () => null);

  // Prefer the diagnosis' coverage (identical builder); fall back to the pure
  // builder over the model so the honesty block is always present.
  const coverage = diagnosis?.coverage ?? flowCoverage(flow);

  return { stack, provenance, flow, diagnosis, coverage, models, freshness };
}
