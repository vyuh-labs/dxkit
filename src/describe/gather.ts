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
import * as fs from 'fs';
import * as path from 'path';
import { detect } from '../detect';
import type { DetectedStack } from '../types';
import { gatherRepoFlowModel } from '../analyzers/flow/gather';
import { gatherFunctionSignatures } from '../analyzers/duplication/signatures';
import { readWorkspace } from '../workspace';
import { buildIntraRepoModel, buildHolisticGraph, type HolisticGraph } from './holistic';
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

/**
 * Gather the holistic (intra + inter-repo) contract graph for the map. Roots =
 * this repo ∪ every LOCAL-path workspace participant (offline — a `repo:`-only
 * participant with no checkout is skipped, never fetched, per Rule 11). Each
 * root contributes its own tree-sitter call graph (deeper than graphify) joined
 * to its flow model; the mesh resolves calls across the boundary. Zero-write.
 */
export async function gatherHolisticGraph(cwd: string): Promise<HolisticGraph> {
  const roots: Array<{ name: string; root: string }> = [
    { name: path.basename(path.resolve(cwd)), root: path.resolve(cwd) },
  ];
  const ws = readWorkspace(cwd);
  if (ws) {
    for (const p of ws.participants) {
      if (!p.path) continue; // repo:-only → offline, skip (never fetch)
      const abs = path.resolve(cwd, p.path);
      if (fs.existsSync(abs) && !roots.some((r) => r.root === abs)) {
        roots.push({ name: p.name, root: abs });
      }
    }
  }
  const models = [];
  for (const { name, root } of roots) {
    const sigs = await gatherFunctionSignatures(root);
    const flow = await gatherRepoFlowModel(root);
    models.push(buildIntraRepoModel(name, root, sigs, flow));
  }
  return buildHolisticGraph(models);
}
