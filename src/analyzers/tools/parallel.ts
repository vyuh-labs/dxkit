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
import { gatherGraphifyResult } from './graphify';

export function gatherLayer2Parallel(cwd: string, _verbose = false): Partial<HealthMetrics> {
  const clocPartial = gatherClocMetrics(cwd);

  const toolsUsed: string[] = [...(clocPartial.toolsUsed ?? [])];
  const toolsUnavailable: string[] = [...(clocPartial.toolsUnavailable ?? [])];

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

  const graphify = gatherGraphifyResult(cwd);
  if (graphify.kind === 'success') {
    toolsUsed.push('graphify');
  } else {
    toolsUnavailable.push(`graphify (${graphify.reason})`);
  }

  return {
    sourceFiles: clocPartial.sourceFiles,
    totalLines: clocPartial.totalLines,
    clocLanguages: clocPartial.clocLanguages,
    toolsUsed,
    toolsUnavailable,
  };
}
