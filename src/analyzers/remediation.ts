/**
 * Remediation actions — ranked improvement suggestions with simulated score deltas.
 *
 * Every analyzer's scorer is a pure function over metrics. An action describes
 * how metrics would change if the action succeeded (the `patch`). Ranking
 * simulates by running the scorer twice: once on current metrics, once on
 * patched metrics. The delta is the score improvement.
 *
 * Because simulation uses the real scorer, ranked deltas stay correct even
 * when the scoring formula is tuned.
 */
import { Evidence } from './evidence';

export interface RemediationAction<M> {
  /** Stable id an agent can reference, e.g. "quality.delete-stale-files". */
  id: string;
  /** Imperative, concrete title ("Delete 3 committed .pyc files"). */
  title: string;
  /** What improves. Empty if purely hygienic. */
  evidence: Evidence[];
  /** Pure mutation: describes the metrics after the action is applied. */
  patch: (m: M) => M;
  /** Optional rationale shown to agents/humans. */
  rationale?: string;
}

export interface RankedAction<M> extends RemediationAction<M> {
  /** Score points gained if this action succeeds. May be 0 or negative. */
  scoreDelta: number;
  /** Baseline score before the patch. */
  baselineScore: number;
  /** Score after the patch. */
  projectedScore: number;
}

/**
 * Rank actions by simulated score improvement, descending.
 *
 * Zero-delta actions are kept (still may be hygienic). Negative-delta actions
 * are filtered out (shouldn't occur — indicates a bug in the action's patch).
 */
export function rank<M>(
  actions: RemediationAction<M>[],
  metrics: M,
  scorer: (m: M) => { score: number },
): RankedAction<M>[] {
  const baseline = scorer(metrics).score;
  const ranked: RankedAction<M>[] = [];
  for (const action of actions) {
    const projected = scorer(action.patch(metrics)).score;
    const delta = projected - baseline;
    if (delta < 0) continue;
    ranked.push({
      ...action,
      scoreDelta: delta,
      baselineScore: baseline,
      projectedScore: projected,
    });
  }
  ranked.sort((a, b) => b.scoreDelta - a.scoreDelta);
  return ranked;
}
