/**
 * The trust context for one analysis run — WHO controls the tree being
 * analyzed, and therefore whether repo-declared EXECUTABLE content may run:
 * extension plugins (a `require` of repo JS), custom-check / pack-lint
 * commands (a spawn of a repo-declared command line), and dependency audits
 * that build the project (pip-audit's PEP-517 path).
 *
 * Why a TYPED, REQUIRED context instead of an optional boolean: the optional
 * `untrusted?: boolean` shape shipped the class twice — a call site that
 * simply omits the flag silently defaults to TRUSTED, and nothing forces the
 * omission to be a decision. First the flow gate ran plugins on untrusted
 * PR trees (fixed by forwarding the boolean); then the custom-check/lint
 * sink turned out to be ungated entirely (found in the 4.2 sweep — repo
 * check commands executed on `guardrail check --untrusted`). Every
 * plugin-capable seam now takes `trust: AnalysisTrustContext` as a REQUIRED
 * parameter, so a new path that forgets it FAILS TO COMPILE, and the
 * arch-check bans re-introducing an optional `untrusted?:` carrier.
 *
 * The context is constructed at the BOUNDARY (CLI flag parsing, hook
 * entries) via the constructors below and threaded through unchanged —
 * consumers read `repoExecutionAllowed`, never re-derive it.
 */

/** Where the analyzed tree came from — the provenance the authority derives
 *  from. Display/attestation value; the decision bit is
 *  `repoExecutionAllowed`. */
export type AnalysisTreeSource =
  /** The operator's own working tree (local CLI, hooks, the loop). */
  | 'local-workspace'
  /** CI running the repo's own branch (push / merge to a branch the repo's
   *  writers control). */
  | 'ci-own-branch'
  /** Content NOT controlled by the repo's writers — a PR from a fork, any
   *  tree passed with `--untrusted`. Repo-declared code must not execute. */
  | 'untrusted-content';

export interface AnalysisTrustContext {
  readonly source: AnalysisTreeSource;
  /**
   * May repo-declared executable content (plugins, check commands, project
   * builds) run against this tree? Derived from `source` by the
   * constructors — never set free-form.
   */
  readonly repoExecutionAllowed: boolean;
}

/** The operator's own tree: repo-declared code may run. The EXPLICIT default
 *  for local commands — explicit because the whole point of the typed
 *  context is that "trusted" is a stated decision, not an omission. */
export function trustedLocalContext(): AnalysisTrustContext {
  return { source: 'local-workspace', repoExecutionAllowed: true };
}

/** CI on the repo's own branch (push / scheduled): same authority as the
 *  repo's writers — repo-declared code may run. */
export function trustedCiContext(): AnalysisTrustContext {
  return { source: 'ci-own-branch', repoExecutionAllowed: true };
}

/** Untrusted content (fork PR, `--untrusted`): repo-declared code must NOT
 *  execute. Read-only analysis only; every skipped capability disclosed. */
export function untrustedContentContext(): AnalysisTrustContext {
  return { source: 'untrusted-content', repoExecutionAllowed: false };
}

/** Boundary adapter for the `--untrusted` CLI flag (and any legacy boolean
 *  carrier): converts ONCE at the edge; everything past the boundary
 *  threads the typed context. */
export function trustContextFromFlag(untrusted: boolean): AnalysisTrustContext {
  return untrusted ? untrustedContentContext() : trustedLocalContext();
}

/** One-line disclosure phrase for a capability skipped under this context. */
export function describeTrustSkip(what: string): string {
  return `${what} not executed: this tree is untrusted content (repo-declared code does not run on it); a trusted run (own branch / local) covers it`;
}
