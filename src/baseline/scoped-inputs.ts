/**
 * Scope-aware producer-context inputs.
 *
 * Extracted from `create.ts` so `gatherCurrentScan` stays focused on
 * orchestration. The producer registry (CLAUDE.md Rule 10) reads a handful
 * of analyzer outputs from `ProducerContext` beyond the cached
 * `AnalysisResult`: the test-gaps report, hygiene markers, raw secrets, and
 * inline allowlist annotations. Each feeds exactly one producer family, so a
 * gather scope that can't block on that family skips the (sometimes
 * expensive) gather and substitutes an empty input — the producer then
 * emits zero entries. The ref side is scoped identically, so the cross-run
 * diff stays balanced (see `gather-scope.ts`).
 */
import { analyzeTestGaps } from '../analyzers/tests';
import { emptyTestGapsReport, type TestGapsReport } from '../analyzers/tests/types';
import { gatherHygieneMarkers } from '../analyzers/quality/gather';
import { gatherGitleaksResult } from '../analyzers/tools/gitleaks';
import type { GitleaksRawSecret } from '../analyzers/tools/gitleaks';
import { gatherInlineAllowlistAnnotations } from '../allowlist/gather';
import type { InlineAllowlistOccurrence } from '../allowlist/gather';
import type { GatherScope } from './gather-scope';
import type { HygieneSnapshot } from './producers';

/** Vacuous hygiene snapshot for the scope-aware gather when a posture
 *  cannot block on `stale-file` / hygiene counts (`scope.hygiene === false`),
 *  so the hygiene grep is skipped. The `quality` producer reads
 *  `hygiene.staleFiles` and emits zero entries from the empty list. */
const EMPTY_HYGIENE_SNAPSHOT: HygieneSnapshot = {
  staleFiles: [],
  todoCount: 0,
  fixmeCount: 0,
  hackCount: 0,
  consoleLogCount: 0,
  mixedLanguages: false,
};

/** The non-cached analyzer outputs the producer registry consumes. */
export interface ScopedProducerInputs {
  readonly testGapsReport: TestGapsReport;
  readonly hygiene: HygieneSnapshot;
  readonly rawSecrets: ReadonlyArray<GitleaksRawSecret>;
  readonly inlineAllowlistAnnotations: ReadonlyArray<InlineAllowlistOccurrence>;
}

/**
 * Gather the producer-context inputs a scope needs. Each gather is skipped
 * when its scope flag is off, substituting an empty value so the
 * corresponding producer emits zero entries. `inlineAllowlistAnnotations` is
 * always gathered (a cheap source scan that feeds the stale-allow producer,
 * which has no scope flag).
 */
export async function gatherScopedProducerInputs(
  cwd: string,
  scope: GatherScope,
  verbose: boolean,
): Promise<ScopedProducerInputs> {
  const testGapsReport = scope.testGaps
    ? await analyzeTestGaps(cwd, { verbose })
    : emptyTestGapsReport();
  const hygiene = scope.hygiene ? gatherHygieneMarkers(cwd) : EMPTY_HYGIENE_SNAPSHOT;
  const gitleaksOutcome = scope.secrets
    ? gatherGitleaksResult(cwd)
    : ({ kind: 'unavailable', reason: 'scoped out' } as const);
  const rawSecrets: ReadonlyArray<GitleaksRawSecret> =
    gitleaksOutcome.kind === 'success' ? gitleaksOutcome.rawSecrets : [];
  const inlineAllowlistAnnotations = gatherInlineAllowlistAnnotations(cwd);
  return { testGapsReport, hygiene, rawSecrets, inlineAllowlistAnnotations };
}
