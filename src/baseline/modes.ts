/**
 * Baseline mode resolution — single source of truth for picking
 * between `committed-full`, `committed-sanitized`, and `ref-based`.
 *
 * # The three modes
 *
 *   - **`committed-full`** — Rich entries committed to git under
 *     `.dxkit/baselines/<name>.json`. The default behavior dxkit
 *     has had since baselines existed. Best for private repos with
 *     small teams; the human-readable locator fields make `baseline
 *     show` and block-time hints maximally useful.
 *
 *   - **`committed-sanitized`** — The file is still committed, but
 *     every entry is stripped to `{ id, kind, sanitized: true }`
 *     before write (see `./sanitize.ts`). The cross-run matching
 *     contract is preserved (identity fingerprints are unchanged);
 *     human-readable locators are gone. Best for compliance-
 *     conscious private repos where broad internal read access
 *     makes location disclosures material.
 *
 *   - **`ref-based`** — No baseline file is committed. The prior
 *     side of the guardrail diff is computed at check time from a
 *     git ref (default: `origin/<default-branch>`) via
 *     `git worktree add`. Zero disclosure surface; best for public
 *     repos. Cost is a longer check (gather runs twice — once
 *     against the ref, once against HEAD).
 *
 * # Resolution precedence
 *
 *   1. **CLI flag** — `--mode=<X>` (and `--ref=<R>`). Highest
 *      precedence. Overrides everything else.
 *   2. **Policy file** — `baseline.mode` / `baseline.ref` in
 *      `.dxkit/policy.json`. Pins the choice repo-wide so every
 *      developer + every CI job uses the same posture.
 *   3. **Visibility-derived default** — probes
 *      `gh repo view --json visibility` (see `./visibility.ts`)
 *      and picks:
 *        - `'public'` → `ref-based`
 *        - `'private'` / `'internal'` → `committed-full`
 *        - `'unknown'` → `committed-full` (safe default + warning)
 *
 * `committed-sanitized` is never auto-picked. It's the explicit
 * opt-in for compliance-conscious private repos. The reasoning:
 *
 *   - For public repos, sanitized-in-git is strictly worse than
 *     ref-based — you're still committing the fingerprint set,
 *     and ref-based gives the same matching contract without
 *     storing anything.
 *   - For typical private repos with small teams, full content
 *     is more useful.
 *
 * So sanitized lives between those two extremes and customers
 * opt in via `policy.json` or `--mode=committed-sanitized`.
 *
 * # Why one resolver
 *
 * Every consumer (the `baseline create` orchestrator, the
 * `guardrail check` orchestrator, doctor checks, future modes-
 * aware tooling) calls `resolveBaselineMode` and reads the
 * returned `ResolvedMode`. Scattered `if (visibility === 'public')`
 * branches would drift independently as the rules evolve; this
 * module is the single edit point.
 *
 * Pure module — no I/O of its own. The visibility probe is
 * injectable via `probeVisibility` so tests can simulate every
 * path without going through `execSync('gh ...')`.
 */

import { execSync } from 'child_process';
import { detectRepoVisibility } from './visibility';
import type { RepoVisibility } from './visibility';

/** The three modes. Keep this union ordered the same way as
 *  `BASELINE_MODES` (declared below) so help text + arch checks
 *  match. */
export type BaselineMode = 'committed-full' | 'committed-sanitized' | 'ref-based';

/** Canonical enumeration of the mode strings. Consumers wanting to
 *  iterate every mode (CLI flag validation, help text, doctor)
 *  import this rather than re-listing the union members. */
export const BASELINE_MODES: ReadonlyArray<BaselineMode> = Object.freeze([
  'committed-full',
  'committed-sanitized',
  'ref-based',
]);

/** Where the resolver picked the mode from. Surfaced to the
 *  runtime log + doctor + agent skills so customers see WHY
 *  `committed-full` was picked over `ref-based`. */
export type ModeSource =
  | 'cli'
  | 'policy'
  | 'auto-public'
  | 'auto-private'
  | 'auto-internal'
  | 'auto-unknown';

/** Resolution outcome carrying the chosen mode + the audit trail
 *  + the resolved ref (for ref-based). Consumers read
 *  `mode` to dispatch and `explanation` to log. */
export interface ResolvedMode {
  readonly mode: BaselineMode;
  readonly source: ModeSource;
  /** One-line human-readable explanation suitable for the runtime
   *  log. Always populated. */
  readonly explanation: string;
  /** Git ref used when `mode === 'ref-based'`. Resolved from CLI,
   *  policy, or the repo's default-branch upstream tracking ref.
   *  Undefined when mode is not ref-based. */
  readonly ref?: string;
}

/** Input shape for the resolver. Every field is optional so the
 *  same function handles "no flags, no policy" and "explicit
 *  everything" without branching on call site. */
export interface ResolveModeOptions {
  readonly cwd: string;
  /** Explicit CLI flag value. Highest precedence when present. */
  readonly cliMode?: BaselineMode;
  /** `baseline.mode` field from `.dxkit/policy.json`. Second
   *  precedence. */
  readonly policyMode?: BaselineMode;
  /** Explicit CLI ref value (`--ref=<R>`). Only consulted when
   *  the resolved mode is `ref-based`. */
  readonly cliRef?: string;
  /** `baseline.ref` field from `.dxkit/policy.json`. */
  readonly policyRef?: string;
  /** Injectable for tests; production omits and the resolver
   *  calls `detectRepoVisibility` directly. */
  readonly probeVisibility?: (cwd: string) => RepoVisibility;
  /** Injectable for tests; production omits and the resolver
   *  shells out to `git symbolic-ref refs/remotes/origin/HEAD`. */
  readonly probeDefaultRef?: (cwd: string) => string | undefined;
}

/**
 * Resolve the baseline mode for a given run. Pure over its inputs
 * apart from the optional probe functions (which default to
 * `detectRepoVisibility` + `probeOriginHeadRef` and ARE I/O-bound).
 * The returned `ResolvedMode` carries everything callers need to
 * dispatch + log.
 */
export function resolveBaselineMode(opts: ResolveModeOptions): ResolvedMode {
  if (opts.cliMode !== undefined) {
    return finalize(opts, opts.cliMode, 'cli');
  }
  if (opts.policyMode !== undefined) {
    return finalize(opts, opts.policyMode, 'policy');
  }
  const probe = opts.probeVisibility ?? detectRepoVisibility;
  const visibility = probe(opts.cwd);
  switch (visibility) {
    case 'public':
      return finalize(opts, 'ref-based', 'auto-public');
    case 'private':
      return finalize(opts, 'committed-full', 'auto-private');
    case 'internal':
      return finalize(opts, 'committed-full', 'auto-internal');
    case 'unknown':
      return finalize(opts, 'committed-full', 'auto-unknown');
  }
}

/**
 * Internal: stamp the explanation + resolve the ref (for ref-based)
 * onto the outcome. Centralized so every code path emits the same
 * shape.
 */
function finalize(opts: ResolveModeOptions, mode: BaselineMode, source: ModeSource): ResolvedMode {
  const explanation = explanationFor(mode, source);
  if (mode !== 'ref-based') return { mode, source, explanation };
  const ref = resolveRef(opts);
  return { mode, source, explanation, ref };
}

function resolveRef(opts: ResolveModeOptions): string {
  if (opts.cliRef) return opts.cliRef;
  if (opts.policyRef) return opts.policyRef;
  const probe = opts.probeDefaultRef ?? probeOriginHeadRef;
  return probe(opts.cwd) ?? 'origin/main';
}

/**
 * Probe `git symbolic-ref refs/remotes/origin/HEAD` to learn the
 * remote's default branch. Returns `'origin/<branch>'` on success,
 * `undefined` on any failure (no remote, no fetch ever ran, etc.).
 *
 * Public for testing — production callers go through
 * `resolveBaselineMode`'s `opts.probeDefaultRef` injection.
 */
export function probeOriginHeadRef(cwd: string): string | undefined {
  try {
    const out = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    // Output shape: "refs/remotes/origin/main" → strip the prefix.
    if (out.startsWith('refs/remotes/')) return out.slice('refs/remotes/'.length);
    return undefined;
  } catch {
    return undefined;
  }
}

function explanationFor(mode: BaselineMode, source: ModeSource): string {
  switch (source) {
    case 'cli':
      return `mode=${mode} (--mode flag)`;
    case 'policy':
      return `mode=${mode} (.dxkit/policy.json: baseline.mode)`;
    case 'auto-public':
      return `mode=${mode} (auto: gh detected a public repo)`;
    case 'auto-private':
      return `mode=${mode} (auto: gh detected a private repo)`;
    case 'auto-internal':
      return `mode=${mode} (auto: gh detected an internal repo)`;
    case 'auto-unknown':
      return `mode=${mode} (auto: visibility not detectable via gh; defaulting to private posture)`;
  }
}

/**
 * Parse a string into a `BaselineMode`. Returns `null` for unknown
 * values so the CLI surfaces a helpful error including the full
 * accepted list. Used by `--mode=<X>` flag parsing.
 */
export function parseBaselineMode(raw: string): BaselineMode | null {
  return (BASELINE_MODES as ReadonlyArray<string>).includes(raw) ? (raw as BaselineMode) : null;
}
