/**
 * Layer 2 orchestrator — populates the non-capability slice of
 * `HealthMetrics` (cloc-derived `sourceFiles` / `totalLines` /
 * `clocLanguages`) and contributes tool-availability strings to
 * `toolsUsed` / `toolsUnavailable` for gitleaks and graphify.
 *
 * Phase 10e.C.7 narrowed `HealthMetrics` to drop every capability-owned
 * field; the secret findings and structural stats that this file used to
 * reshape now live exclusively under `HealthReport.capabilities`. What
 * remains is the tool-name surface users see in reports.
 *
 * Phase 10e.C.3 replaced the prior child-process + bash orchestration
 * with direct in-process calls to the memoized outcome helpers
 * (`gatherGitleaksResult`, `gatherGraphifyResult`); the capability
 * dispatcher's later `SECRETS` / `STRUCTURAL` calls in
 * `gatherCapabilityReport` hit cached outcomes, so each tool runs
 * exactly once per analyzer run.
 *
 * Keeps the sync signature — callers in `analyzers/health.ts` wrap with
 * `timed()`, not `timedAsync()`. Tool-name strings are byte-identical to
 * pre-C.7, including the exact `toolsUnavailable` phrasings.
 */
import { HealthMetrics } from '../types';
import { gatherClocMetrics } from './cloc';
import { gatherGitleaksResult } from './gitleaks';
import { gatherGraphifyGraph, gatherGraphifyResult } from './graphify';
import { type GatherScope, FULL_SCOPE } from '../../baseline/gather-scope';

export async function gatherLayer2Parallel(
  cwd: string,
  _verbose = false,
  scope: GatherScope = FULL_SCOPE,
): Promise<Partial<HealthMetrics>> {
  // cloc warms the line-count metrics (language breakdown, large-file,
  // comment ratio); skip it when the scope blocks on none of those.
  const clocPartial = scope.cloc ? gatherClocMetrics(cwd) : {};

  const toolsUsed: string[] = [...(clocPartial.toolsUsed ?? [])];
  const toolsUnavailable: string[] = [...(clocPartial.toolsUnavailable ?? [])];

  // Run gitleaks here only when the scope needs secrets — it warms the
  // outcome the later SECRETS capability dispatch reuses. When secrets are
  // out of scope, the dispatch is skipped too, so gitleaks never runs.
  if (scope.secrets) {
    const gitleaks = gatherGitleaksResult(cwd);
    if (gitleaks.kind === 'success') {
      toolsUsed.push('gitleaks');
    } else {
      // `not installed` renders as bare `gitleaks`, every other failure
      // mode carries its reason as a parenthetical — byte-identical to
      // the pre-C.7 string the report surfaces.
      toolsUnavailable.push(
        gitleaks.reason === 'not installed' ? 'gitleaks' : `gitleaks (${gitleaks.reason})`,
      );
    }
  }

  // graphify (AST stats + the graph.json side-effect write) feeds only
  // structural/maintainability metrics + import reachability — never a
  // kind the gate blocks on (the classifier never reads dep-vuln
  // reachability). Skip it when structural is out of scope.
  if (scope.structural) {
    const graphify = await gatherGraphifyResult(cwd);
    if (graphify.kind === 'success') {
      toolsUsed.push('graphify');
    } else {
      toolsUnavailable.push(`graphify (${graphify.reason})`);
    }

    // Trigger the graph.json side-effect write. Shares the Python
    // invocation with gatherGraphifyResult above via the promise-
    // coalesced cache — no second shell-out. The disk write powers
    // the explore CLI (Sprint 2) + dashboard viz (Sprint 3) + future
    // 2.8 context CLI + reachability flows, all of which read from
    // .dxkit/reports/graph.json via the canonical loader.
    await gatherGraphifyGraph(cwd);
  }

  return {
    sourceFiles: clocPartial.sourceFiles,
    totalLines: clocPartial.totalLines,
    clocLanguages: clocPartial.clocLanguages,
    toolsUsed,
    toolsUnavailable,
  };
}
