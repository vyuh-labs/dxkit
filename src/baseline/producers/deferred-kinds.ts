/**
 * Identity kinds declared in `IdentityInput` but not yet wired by any
 * producer (CLAUDE.md Rule 10\'s declared-deferral discipline). Split from
 * `producers/index.ts` at the large-file bar; the registry re-exports it,
 * so consumers keep importing from the one surface.
 */

/**
 * Identity kinds declared in `IdentityInput` but not yet wired by
 * any producer. Each entry MUST carry a `reason` (what blocks the
 * producer today) and `landingPhase` (when we intend to wire it).
 * The contract test asserts:
 *
 *   - Every kind appearing here is NOT contributed by any
 *     registered producer (no double-counting).
 *   - Every `IdentityKind` is either contributed OR in this map.
 *
 * Adding a new identity kind without wiring a producer requires
 * adding an entry here — the deferral becomes architecturally
 * explicit rather than silently invisible.
 */
export const DEFERRED_KINDS: Readonly<
  Record<string, { readonly reason: string; readonly landingPhase: string }>
> = Object.freeze({
  'god-file': {
    reason:
      'graphify Python script does not yet surface per-file complexity offenders; ' +
      'QualityMetrics.topGodFiles is forward-declared but unpopulated. ' +
      'Substitute: large-file (over the configured large-file threshold) overlaps the same files ~80%+ of the time.',
    landingPhase: '2.6 / Phase 10s.2 (graphify-symbols expansion)',
  },
  hygiene: {
    reason:
      'gatherHygieneMarkers emits aggregate counts, not per-occurrence positions; ' +
      'extending to surface Array<{file, line, marker}> is a small gather refactor. ' +
      'Substitute: aggregate counts feed the Quality dimension score; ' +
      'newSevereQualityIssueInChangedFiles block rule catches high-severity overlap.',
    landingPhase: 'Phase 5 (pre-launch polish)',
  },
  'coverage-gap': {
    reason:
      'per-pack coverage adapters do not yet surface uncovered symbol ranges. ' +
      'Five of eight packs (typescript / java / kotlin / ruby / go) land in ' +
      'Phase 3.5 inside 2.5; remaining three (python / csharp / rust) decided ' +
      'mid-Phase-3.5 based on adapter complexity. ' +
      'Substitute: test-gap covers file-level untested; new uncovered functions ' +
      'inside an already-tested file remain invisible until Phase 3.5 lands.',
    landingPhase: 'Phase 3.5 (5 packs) / 2.6 (remaining)',
  },
  'flow-binding': {
    reason:
      'the identity + baseline-entry shape ship ahead of the producer so the ' +
      'integration gate can grandfather bindings the moment it lands. The gate ' +
      'evaluates the affected scope of a diff against committed contract ' +
      'snapshots (served.json / consumed.json) rather than a full-scan producer, ' +
      'so the flow-binding entries are minted by the gate path, not baseline-create. ' +
      'Substitute: none — net-new broken-integration detection is inert until the gate wires in.',
    landingPhase: 'Flow M3 (the integration gate)',
  },
  'model-schema-drift': {
    reason:
      'drift is a two-ref RELATION, not a standing finding: a change class exists ' +
      'only between a base and a head model set, so there is no full-scan prior ' +
      'side for baseline-create to capture. The drift gate mints these findings ' +
      'itself (mirror of flow-binding), gathering both sides fresh at check time. ' +
      'Substitute: none needed — the gate is the complete producer for this kind.',
    landingPhase: 'model-schema drift gate (ships with the kind)',
  },
  'code-reimplementation': {
    reason:
      'a structural-duplicate PAIR is a two-ref RELATION, not a standing finding: ' +
      'the seam gate gathers the duplicate-pair set at base AND head and mints only ' +
      'the pairs the diff INTRODUCES (a pair present at the base ref is grandfathered), ' +
      'mirror of flow-binding / model-schema-drift. A full-scan producer would FLOOD ' +
      'the gate on upgrade — an older baseline has zero entries of this kind, so every ' +
      'pre-existing duplicate would read net-new. Substitute: none — the gate is the ' +
      'complete producer for this kind.',
    landingPhase: 'seam gate (ships with the kind)',
  },
  'broken-flow': {
    reason:
      'a broken declared flow is a property of an ESTATE COMPOSITION (N member ' +
      'trees judged as one wave), not of any single tree a full-scan producer ' +
      'walks: the wave gate mints the kind from flow.v1 declarations against ' +
      'the composed served mesh. Substitute: none — the wave surface is the ' +
      'complete producer for this kind.',
    landingPhase: 'estate wave gate (4.4.0 WP7 — ships with the kind)',
  },
  'paired-change': {
    reason:
      'a paired-change violation is a property of ONE DIFF ("this change touched the ' +
      'if side of a declared pairing without touching the then side"), not of a tree: ' +
      'a full-scan producer has no diff to evaluate, so there is nothing to capture ' +
      'and nothing to grandfather. The paired-change gate mints the kind per check ' +
      'from the changed-path set. Substitute: none — the gate is the complete ' +
      'producer for this kind.',
    landingPhase: 'paired-change gate (ships with the kind)',
  },
});
