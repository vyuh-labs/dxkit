/**
 * License-aware deep-SAST engine resolver.
 *
 * Interprocedural SAST is not free-and-unconditional the way dxkit's
 * bundled scanners are: CodeQL's CLI license permits free analysis only
 * for open-source repos or under GitHub Advanced Security; Snyk Code is
 * the customer's own licensed engine. So "which engine do we use for
 * deep SAST?" is a decision that depends on repo visibility, what the
 * customer already licenses, and explicit consent — exactly the shape
 * of the baseline-mode resolver (see `src/baseline/modes.ts`), and kept
 * deliberately parallel to it.
 *
 * This module decides; it does not run anything. The caller (the
 * `ingest` CLI, the `dxkit-ingest` skill) acts on the decision —
 * including prompting for consent when `requiresConsent` is set, so an
 * engine never runs on private code without the user accepting the
 * license terms.
 *
 * Pure: the only I/O is the visibility probe, which is injectable for
 * tests.
 */
import { detectRepoVisibility } from '../baseline/visibility';
import type { RepoVisibility } from '../baseline/visibility';

/** Engines the resolver can recommend. `none` means "no licensed
 *  interprocedural engine is available — stay on the bundled
 *  community semgrep tier." */
export type DeepSastEngine = 'snyk-code' | 'codeql' | 'none';

export type DeepSastSource =
  | 'flag' // explicit --engine
  | 'snyk-configured' // SNYK_TOKEN + org/project present
  | 'visibility-public' // OSS → CodeQL is licensed
  | 'visibility-private'; // private/internal/unknown → consent needed

export interface DeepSastDecision {
  readonly engine: DeepSastEngine;
  readonly source: DeepSastSource;
  /** True when the caller MUST obtain explicit user consent before
   *  running the engine — i.e. CodeQL against a non-public repo, where
   *  free use requires GitHub Advanced Security. Ingesting an engine the
   *  customer already licenses (Snyk) never requires consent. */
  readonly requiresConsent: boolean;
  /** One-line human explanation of how the engine was chosen. */
  readonly explanation: string;
  /** Present when there is a licensing constraint the caller should
   *  surface verbatim. */
  readonly licenseNote?: string;
}

export interface ResolveDeepSastOptions {
  readonly cwd: string;
  /** Explicit engine override (`--engine`). Highest precedence. */
  readonly engineFlag?: DeepSastEngine;
  /** Whether a Snyk token + org/project are configured (env/config).
   *  When true, ingesting the customer's own Snyk Code results is the
   *  zero-license-friction default. */
  readonly snykConfigured?: boolean;
  /** Injectable for tests; defaults to the real cached probe. */
  readonly visibilityProbe?: (cwd: string) => RepoVisibility;
}

const GHAS_NOTE =
  "CodeQL's license permits free use on open-source repos, academic " +
  'research, or under GitHub Advanced Security. This repo is not public — ' +
  'confirm you have GitHub Advanced Security (or ingest an engine you ' +
  'already license, e.g. Snyk) before running CodeQL.';

/**
 * Resolve which deep-SAST engine to use. Precedence:
 *   1. explicit `--engine` flag
 *   2. a configured Snyk token (ingest the customer's own results —
 *      license-safe, no consent)
 *   3. repo visibility: public → CodeQL (licensed for OSS); otherwise
 *      CodeQL gated behind consent (GHAS), so the caller can prompt or
 *      fall back.
 */
export function resolveDeepSastEngine(opts: ResolveDeepSastOptions): DeepSastDecision {
  const probe = opts.visibilityProbe ?? detectRepoVisibility;

  // 1. Explicit override.
  if (opts.engineFlag) {
    const engine = opts.engineFlag;
    if (engine === 'codeql') {
      const visibility = probe(opts.cwd);
      const consent = visibility !== 'public';
      return {
        engine,
        source: 'flag',
        requiresConsent: consent,
        explanation: `engine=codeql (--engine)${consent ? '; consent required (non-public repo)' : ''}`,
        ...(consent ? { licenseNote: GHAS_NOTE } : {}),
      };
    }
    return {
      engine,
      source: 'flag',
      requiresConsent: false,
      explanation: `engine=${engine} (--engine)`,
    };
  }

  // 2. Snyk configured → ingest the customer's own licensed results.
  if (opts.snykConfigured) {
    return {
      engine: 'snyk-code',
      source: 'snyk-configured',
      requiresConsent: false,
      explanation: 'engine=snyk-code (SNYK_TOKEN + project configured; quota-free read)',
    };
  }

  // 3. Visibility-derived default.
  const visibility = probe(opts.cwd);
  if (visibility === 'public') {
    return {
      engine: 'codeql',
      source: 'visibility-public',
      requiresConsent: false,
      explanation: 'engine=codeql (public repo; CodeQL is licensed for open source)',
    };
  }
  return {
    engine: 'codeql',
    source: 'visibility-private',
    requiresConsent: true,
    explanation: `engine=codeql (visibility=${visibility}; consent required before running)`,
    licenseNote: GHAS_NOTE,
  };
}
