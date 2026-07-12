/**
 * Dead-surface tier — the honest confidence ladder for a served route that no
 * in-repo client call consumes. "Unconsumed" is NOT "dead": a route reads as
 * unconsumed for three unrelated reasons, and the tier keeps them apart so the
 * signal never cries wolf (the precision floor).
 *
 *   - genuinely dead      — the change added it, nothing reaches it, remove it.
 *   - consumed cross-repo — the consuming frontend lives in another repo.
 *   - consumed by convention — a webhook / cron / health / CLI route an
 *                              EXTERNAL actor drives, so "no in-repo consumer"
 *                              is expected.
 *
 * This module is PURE and tiny by design: it maps already-computed signals to a
 * tier. The producer owns the policy that derives those signals (from
 * `diagnoseFlow`'s connection rung, the pack-declared convention union, the
 * direct-call seam, and the convergence join) — this function just encodes the
 * ladder. Kept separate so the ladder is fixture-testable independent of the I/O
 * that feeds it, and so the "one concept, one code path" rule holds (Rule 2:
 * every consumer tiers a dead surface through here).
 */

/** The confidence tier of a served-but-unconsumed route. */
export type DeadSurfaceTier =
  | 'removable' // high confidence dead AND converged (also a duplicate) — warn loud
  | 'likely' // unconsumed, but cross-repo consumers can't be ruled out — surface + nudge
  | 'expected'; // an external-actor route (webhook/cron/health/CLI) or direct-called — inventory only

/** The signals the tier is a pure function of. Each is decided by the producer
 *  from an existing source (never re-detected here). */
export interface DeadSurfaceSignals {
  /** The route matched a pack-declared `nonConsumerRoutePaths` convention
   *  (webhook / cron / health / public-api / CLI) — an external actor drives it,
   *  so no in-repo consumer is EXPECTED. */
  readonly isConventionRoute: boolean;
  /** The route's handler symbol is the target of a `calls` edge in the graph —
   *  it is consumed by a server-side DIRECT call (RSC / loader / server action),
   *  not over HTTP. Closes the App-Router "dead is the norm" false-positive. */
  readonly isDirectlyCalled: boolean;
  /** The producer could actually SEE every consumer — either an explicit
   *  cross-repo mesh was consulted (`configured-participants` /
   *  `committed-counterpart`) or the scan is a full-stack tree that consumes its
   *  own routes. When false (a bare backend repo with no workspace config), a
   *  cross-repo consumer might exist and be invisible, so deadness is UNCERTAIN
   *  and the route can never reach `removable`. */
  readonly crossRepoConsumersVisible: boolean;
  /** The convergence input: the route's handler / file is ALSO a structural
   *  duplicate (a `code-reimplementation` finding co-locates here). Two
   *  independent seam signals agreeing is what earns the loud `removable` tier
   *  without a false-block. */
  readonly isStructuralDuplicate: boolean;
  /** Whether this route's DEADNESS can be CONFIRMED — true only when the handler
   *  is a specific symbol (a named method), so "no consumer" genuinely means
   *  unreferenced. A bare HTTP-verb handler (`GET` / `POST`, as App-Router /
   *  file-route handlers are exported) can be consumed by a server component or
   *  framework WITHOUT a resolvable call, so its "unconsumed" is ambiguous — it
   *  can never reach the loud `removable` tier (it stays `likely`). This is the
   *  precision boundary the App-Router case surfaced: HTTP-unconsumed ≠ dead when
   *  the framework consumes the route out of band. */
  readonly deadnessConfirmable: boolean;
}

/**
 * Map the signals to a tier. The ladder, in one place:
 *
 *  1. An external-actor route (convention) or a direct-called route is NOT dead
 *     — it is consumed, just not over HTTP. → `expected` (inventory only).
 *  2. A genuinely-unconsumed route whose consumers were all VISIBLE (cross-repo
 *     ruled out) AND which is ALSO a structural duplicate is near-certain
 *     removable slop — convergence earns the loud tier. → `removable`.
 *  3. Everything else genuinely-unconsumed — single-signal, or cross-repo
 *     consumers we could not see — is surfaced but never shouted; the nudge is
 *     "configure `workspace.json` so cross-repo consumers can be ruled out."
 *     → `likely`.
 *
 * Bias to false-NEGATIVE throughout: an uncertain route lands `likely`/`expected`,
 * never a loud `removable` it can't back up.
 */
export function deadSurfaceTier(signals: DeadSurfaceSignals): DeadSurfaceTier {
  if (signals.isConventionRoute || signals.isDirectlyCalled) return 'expected';
  if (
    signals.crossRepoConsumersVisible &&
    signals.isStructuralDuplicate &&
    signals.deadnessConfirmable
  ) {
    return 'removable';
  }
  return 'likely';
}

/**
 * Whether a route's file path or URL path matches any pack-declared
 * `nonConsumerRoutePaths` convention substring (case-insensitive). Pure over the
 * pattern union the caller passes (`allNonConsumerRoutePaths(flags)`), so the
 * conventions stay pack-declared (Rule 6/8) and this function never holds a
 * `webhook`/`cron`/`health` literal.
 */
export function matchesNonConsumerConvention(
  filePath: string,
  urlPath: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false;
  const f = filePath.toLowerCase();
  const u = urlPath.toLowerCase();
  return patterns.some((p) => {
    const needle = p.toLowerCase();
    return f.includes(needle) || u.includes(needle);
  });
}

/** Generic HTTP-verb handler names carry no identity — a route whose handler is
 *  a bare verb can't be trusted to resolve via the direct-call seam (every
 *  `GET`/`POST` in the codebase would match), so the caller treats such a
 *  handler as "not directly resolvable" and lets the route stay uncertain
 *  rather than falsely marking it consumed. Bias to false-negative on deadness
 *  (never a false dead warning). */
const GENERIC_HANDLER_NAMES: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'handler', // arch-shape-ok: a generic HTTP-handler symbol name, not an architectural role label
  'handle',
  'default',
  'index',
]);

/** Is this handler name specific enough to trust a direct-call-seam match? */
export function isSpecificHandlerName(handler: string | null | undefined): boolean {
  if (!handler) return false;
  const h = handler.replace(/\(\)$/, '').toLowerCase();
  const last = h.includes('.') ? (h.split('.').pop() ?? h) : h;
  return last.length > 0 && !GENERIC_HANDLER_NAMES.has(last);
}
