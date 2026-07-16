/**
 * Brownfield policy + status classifier.
 *
 * The matcher in `git-aware-match.ts` emits raw `MatchPair`s with one
 * of four statuses (persisted / relocated / added / removed) plus a
 * confidence score and structured reasons. The guardrail check needs
 * a richer taxonomy — the difference between "developer introduced
 * a new finding" and "a scanner update surfaced a finding that was
 * always there" matters enormously for whether to block a PR.
 *
 * This module is the bridge. It takes a `MatchPair` plus optional
 * context (severity, scanner-version diff, config diff) and a
 * `BrownfieldPolicy`, then emits a `ClassifyResult` carrying the
 * post-policy `FindingStatus`, the block/warn verdict, and the
 * composed reason chain.
 *
 * Pure module — no I/O, deterministic over its inputs.
 *
 * Producer wiring note: today's classifier emits a subset of the full
 * `FindingStatus` taxonomy. Reservations for `probable_existing`,
 * `newly_detected`, and `fixed` are declared in the type space so
 * Phase 3's baseline-metadata work can light them up incrementally
 * without re-shaping consumer code.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BaselineMode, BaselineAnchor } from './modes';
import type { FindingSeverity, FindingStatus } from './types';

/**
 * Optional `baseline.*` block in `.dxkit/policy.json`. Pins the
 * mode + (when ref-based) the comparison ref repo-wide so every
 * developer + every CI job uses the same posture. Both fields are
 * optional; when absent the resolver in `./modes.ts` falls back to
 * visibility-derived defaults.
 *
 * Schema example:
 *
 *   {
 *     "baseline": {
 *       "mode": "ref-based",
 *       "ref": "origin/main"
 *     }
 *   }
 */
export interface BaselineSection {
  readonly mode?: BaselineMode;
  /** Git ref to compare against in `ref-based` mode. When absent,
   *  the resolver probes `origin/HEAD` and falls back to
   *  `'origin/main'`. */
  readonly ref?: string;
  /**
   * WHERE the committed anchor lives, for committed modes. It decouples the
   * baseline store from the protected default branch so the after-merge refresh
   * can stay fast + automated without a direct push to `main` (which branch
   * protection rejects — see `enforcement.ts`).
   *
   *   - `'tree'` (default when the branch is unprotected): the anchor is
   *     committed into the working tree on the default branch and refreshed by a
   *     direct push. Simplest; only valid when direct pushes are allowed.
   *   - `'branch'` (default when the default branch is protected): the anchor
   *     lives on a separate unprotected branch (`anchorRef`, default
   *     `dxkit-baselines`). The refresh direct-pushes THERE (allowed — protection
   *     targets `main`), and each check hydrates the anchor from it. Fast,
   *     automated, no PR, no deadlock.
   *   - `'cache'`: the anchor is stored in the CI cache keyed by the main SHA;
   *     no git write at all. A cold cache falls back to a live re-gather for that
   *     one check. CI-only (a local run cannot read the CI cache).
   */
  readonly anchor?: BaselineAnchor;
  /** Branch that stores the anchor when `anchor: 'branch'`. Default
   *  `'dxkit-baselines'`. Must NOT be a protection-covered branch. */
  readonly anchorRef?: string;
}

/**
 * Per-finding-kind overrides that escalate specific guardrail rules
 * beyond the generic `block` / `warn` lists. Each rule maps to a
 * common product-level concern; the classifier checks them when the
 * relevant context fields are present.
 */
export interface BrownfieldBlockRules {
  /** Block any newly-introduced secret regardless of confidence. */
  readonly newSecret?: boolean;
  /** Block any newly-introduced critical security finding. */
  readonly newCriticalSecurity?: boolean;
  /** Block any newly-introduced high-severity security finding. */
  readonly newHighSecurity?: boolean;
  /** Block any newly-introduced critical dependency vulnerability. */
  readonly newCriticalDependencyVulnerability?: boolean;
  /** Block any newly-introduced high-severity reachable dep vuln. */
  readonly newHighReachableDependencyVulnerability?: boolean;
  /** Block a newly-introduced dependency carrying a malicious-code
   *  advisory (OSV `MAL-*`, the CWE-506 family, a malware-titled GHSA),
   *  REGARDLESS of CVSS severity: install-time malware executes at
   *  install, so severity scores and code-reachability are the wrong
   *  lens. Classified by the one canonical predicate,
   *  `src/analyzers/security/malicious.ts`. */
  readonly newMaliciousDependency?: boolean;
  /** Block when an untested source file is added in a changed file. */
  readonly newUntestedChangedSource?: boolean;
  /** Block any newly-introduced severe quality issue in changed files. */
  readonly newSevereQualityIssueInChangedFiles?: boolean;
}

/**
 * One user-declared custom check in `.dxkit/policy.json:checks`. dxkit runs it
 * as a first-class gate citizen alongside its own scanners: it executes the
 * command, fingerprints each failure as a `custom-check` finding, and gates on
 * NET-NEW failures (a pre-existing failure is grandfathered) uniformly across
 * pre-push / CI / the loop Stop-gate. dxkit becomes the gate runner for ALL of a
 * repo's invariants, not just its own scanners.
 *
 * SECURITY: the command is executed. It comes ONLY from the repo's own committed
 * policy.json — the same trust boundary as the repo's npm scripts / CI config.
 * dxkit never runs a check from a CLI flag or any untrusted source.
 *
 * Schema example:
 *
 *   {
 *     "checks": [
 *       { "name": "check:seam", "command": "npm run check:seam" },
 *       { "name": "licenses", "command": ["make", "check-licenses"], "blocking": false },
 *       {
 *         "name": "custom-lint",
 *         "command": "npx eslint . -f unix",
 *         "parse": { "regex": "^(?<file>[^:]+):(?<line>\\d+):\\d+:\\s+(?<message>.*?)\\s+\\[(?<rule>[^\\]]+)\\]$" }
 *       }
 *     ]
 *   }
 */
export interface CustomCheckConfig {
  /** Stable label — becomes the finding's durable identity key. `lint:*` is
   *  reserved for pack-declared built-in lint. */
  readonly name: string;
  /** The command: a single string (whitespace-split; no shell — for a pipeline
   *  use a script) or an argv array. */
  readonly command: string | readonly string[];
  /** Net-new failure blocks (default true) or only warns (false). */
  readonly blocking?: boolean;
  /** Exit code meaning "pass" (default 0). */
  readonly expectedExit?: number;
  /** Output→findings extraction. `'exit'` (default): one binary finding per
   *  failure. `{ regex }`: one located finding per matching line, via named
   *  `(?<file>)(?<line>)(?<rule>)(?<message>)` capture groups. */
  readonly parse?: 'exit' | { readonly regex: string };
}

/**
 * `.dxkit/policy.json:lint` — opt-in gating on pack-declared built-in lint
 * (`LanguageSupport.lint`). Off by default: a lint gate is noisy on a repo that
 * hasn't opted in, so it ships dormant. When enabled, dxkit synthesizes a
 * `lint:<pack>` custom check per active language pack, running through the SAME
 * runner as user checks (lint is a consumer of the custom-check seam, not a
 * parallel path).
 */
export interface LintPolicy {
  /** Turn on pack-declared lint gating (default false). */
  readonly enabled?: boolean;
  /** Net-new lint findings block (default false — warn only). */
  readonly blocking?: boolean;
}

/**
 * `.dxkit/policy.json:recall` — tuning for recall attribution (CLAUDE.md
 * Rule 19), which decides whether a finding delta may be blamed on the
 * developer or must be reported as "cannot attribute".
 *
 * Guardrail TUNING, not a posture knob: it refines a gate the repo already
 * adopted rather than opting into a capability, so it carries no Rule 16
 * discovery contract — same class as `confidence` / `blockRules` /
 * `largeFileThreshold`.
 */
export interface RecallPolicy {
  /**
   * How tool versions are resolved into recall inputs.
   *
   *  - `'resolved'` (default) — what ACTUALLY ran. If a developer's machine
   *    and CI resolve different plugin versions they genuinely produce
   *    different findings, and that is worth surfacing rather than hiding.
   *  - `'locked'` — the DECLARED range from the manifest, which does not move
   *    when a caret resolves forward. Fewer re-baselines, for repos that
   *    tolerate dev != CI.
   */
  readonly inputs?: 'resolved' | 'locked';
}

/**
 * `.dxkit/policy.json:reports` — opt-in report snapshots published to the
 * dedicated `dxkit-reports` side ref on merge to the default branch. Off by
 * default; the on-merge workflow + `vyuh-dxkit report snapshot` read it.
 */
export interface ReportsPolicy {
  /** Publish a snapshot on merge to the default branch (the workflow trigger). */
  readonly onMerge?: boolean;
  /** Which reports to publish under `latest/` (default: health + dashboard). */
  readonly kinds?: ReadonlyArray<string>;
  /** Side ref the snapshots + `report-history.jsonl` live on. Default
   *  `dxkit-reports` (kept distinct from the baseline anchor). */
  readonly anchorRef?: string;
  /** Retention: how many history entries / full snapshots to keep. */
  readonly retain?: { readonly history?: number; readonly snapshots?: number };
}

/**
 * Brownfield-mode policy. The product promise — "existing debt is
 * allowed; new regressions are blocked" — flows from these settings.
 */
export interface BrownfieldPolicy {
  readonly mode: 'brownfield';
  /** Statuses that fail the guardrail check (non-zero exit code). */
  readonly block: ReadonlyArray<FindingStatus>;
  /** Statuses that emit a warning but don't fail. */
  readonly warn: ReadonlyArray<FindingStatus>;
  /**
   * Per-severity confidence thresholds. A `relocated` or `persisted`
   * match with confidence below the per-severity threshold demotes
   * to `'uncertain'` — the policy can warn rather than silently
   * accept a low-confidence pairing.
   */
  readonly confidence: Readonly<Record<FindingSeverity, number>>;
  /** Per-kind block-on-new overrides. */
  readonly blockRules: BrownfieldBlockRules;
  /**
   * Finding kinds whose `added` classification only blocks when the
   * finding overlaps lines actually changed in the current diff.
   *
   * Some upstream scanners (notably semgrep on large codebases) are
   * non-deterministic across runs — parallel rule execution + per-
   * rule timeouts mean each run discovers a slightly different
   * subset of the full match space. When the baseline missed a real
   * finding and a later scan catches it on UNCHANGED code, the
   * matcher legitimately reports `added` — but the developer
   * didn't introduce it.
   *
   * For kinds listed here, an `added` finding outside the diff's
   * changed lines gets demoted to `uncertain` (a warn status).
   * Findings inside changed lines still block — that's where the
   * developer actually wrote code.
   *
   * Default: `['code', 'hygiene']` — the kinds with confirmed
   * scanner-wobble risk. Customers can extend (`'duplication'`,
   * `'large-file'`) or clear it (block on everything regardless of
   * diff overlap) via `.dxkit/policy.json`.
   */
  readonly addedRequiresChangedLines: ReadonlyArray<string>;
  /**
   * Line count above which a source file is flagged `large-file`. Optional;
   * defaults to the canonical `LARGE_FILE_THRESHOLD_LINES` (500) when unset, so
   * a repo can tune the bar to its own norms without a code change:
   *
   *   { "largeFileThreshold": 800 }
   *
   * Identity is path-based, so raising/lowering it only changes WHICH files are
   * flagged, never a fingerprint — no baseline migration.
   */
  readonly largeFileThreshold?: number;
  /** Opt-in report snapshots on merge (see ReportsPolicy). */
  readonly reports?: ReportsPolicy;
  /**
   * Baseline-mode pinning. When absent, the resolver in `./modes.ts`
   * falls back to visibility-derived defaults
   * (`'public'` → `ref-based`; `'private'` / `'internal'` /
   * `'unknown'` → `committed-full`). Customers pin this to lock the
   * posture across all developers + CI jobs:
   *
   *   - `'committed-full'`: rich entries committed (default for
   *     private repos with small teams).
   *   - `'committed-sanitized'`: stripped entries committed
   *     (compliance-conscious private repos).
   *   - `'ref-based'`: no committed baseline; computed from a git
   *     ref at check time (default for public repos).
   */
  readonly baseline?: BaselineSection;
  /**
   * User-declared custom checks — repo invariants dxkit runs as gate citizens.
   * Absent/empty ⟹ no custom checks (the default). Normalized to runner specs
   * by `policyChecksToSpecs` (`src/analyzers/custom-checks/config.ts`).
   */
  readonly checks?: readonly CustomCheckConfig[];
  /**
   * Opt-in gating on pack-declared built-in lint. Absent ⟹ disabled (the
   * default — lint ships dormant).
   */
  readonly lint?: LintPolicy;
  /**
   * Recall-attribution tuning (Rule 19). Absent ⟹ `inputs: 'resolved'`.
   */
  readonly recall?: RecallPolicy;
  /**
   * Code-graph freshness transport. Absent/`'off'` ⟹ the graph is rebuilt on
   * demand by each consumer (the default). `'cache'` installs the
   * `dxkit-graph-refresh` workflow, which rebuilds `graph.json` on merge to the
   * default branch and stores it in the Actions cache (NEVER git — no repo
   * bloat) so the guardrail run restores it instead of a cold rebuild. Opt-in
   * because it's a CI-performance optimization, not a correctness gate.
   */
  readonly graph?: GraphSection;
}

/** `graph.*` block in `.dxkit/policy.json`. */
export interface GraphSection {
  /** `'cache'` → install the graph-refresh workflow (Actions-cache transport);
   *  `'off'`/absent → rebuild on demand (the default). */
  readonly refresh?: 'cache' | 'off';
}

/**
 * Default brownfield policy. Captures the conservative posture from
 * the agentic-brownfield strategy: block only on high-confidence new
 * regressions; warn on the categories that suggest a problem might
 * be real but might also be drift; legacy debt is permitted.
 *
 * Confidence thresholds: secrets + critical security demand a tight
 * confidence threshold (a low-confidence persisted secret pairing
 * gets demoted to uncertain and warned, not blocked). Lower-severity
 * findings can pair on weaker signal because the cost of a false
 * "secret is new" event is much higher than a false "TODO is new."
 */
export const DEFAULT_BROWNFIELD_POLICY: BrownfieldPolicy = Object.freeze({
  mode: 'brownfield',
  block: Object.freeze(['added'] as ReadonlyArray<FindingStatus>),
  warn: Object.freeze([
    'probable_existing',
    'newly_detected',
    'tooling_drift',
    'config_drift',
    'uncertain',
  ] as ReadonlyArray<FindingStatus>),
  confidence: Object.freeze({
    critical: 0.75,
    high: 0.8,
    medium: 0.85,
    low: 0.9,
  }),
  blockRules: Object.freeze({
    newSecret: true,
    newCriticalSecurity: true,
    newHighSecurity: true,
    newCriticalDependencyVulnerability: true,
    newHighReachableDependencyVulnerability: true,
    newMaliciousDependency: true,
    newUntestedChangedSource: true,
    newSevereQualityIssueInChangedFiles: true,
  }),
  addedRequiresChangedLines: Object.freeze(['code', 'hygiene']),
});

/** Conventional location for a per-repo brownfield policy. Loaded
 *  automatically by `resolvePolicy` when present. */
export const DEFAULT_POLICY_FILENAME = path.join('.dxkit', 'policy.json');

/**
 * Load a brownfield policy with the three-step resolution order
 * shared by `createBaseline` and `runGuardrailCheck`:
 *
 *   1. `policyPath` (explicit `--policy <p>` flag). Errors if the
 *      path is supplied but unreadable / malformed.
 *   2. `<cwd>/.dxkit/policy.json` (conventional). Silently skipped
 *      when absent so consumers without a policy get the defaults.
 *   3. `DEFAULT_BROWNFIELD_POLICY` (compiled-in fallback).
 *
 * Customer fields shallow-merge over the default. The
 * `confidence` / `blockRules` blocks deep-merge by key. Unknown
 * fields are preserved — the classifier ignores what it doesn't
 * know, so forward-compatible policy files don't break old dxkit.
 */
export function resolvePolicy(policyPath: string | undefined, cwd: string): BrownfieldPolicy {
  let resolvedPath: string | undefined = policyPath;
  if (!resolvedPath) {
    const conventional = path.join(cwd, DEFAULT_POLICY_FILENAME);
    if (fs.existsSync(conventional)) resolvedPath = conventional;
  }
  if (!resolvedPath) return DEFAULT_BROWNFIELD_POLICY;
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`policy file not readable: ${resolvedPath} (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy file is not valid JSON: ${resolvedPath} (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`policy file root is not an object: ${resolvedPath}`);
  }
  const obj = parsed as Partial<BrownfieldPolicy>;
  return {
    ...DEFAULT_BROWNFIELD_POLICY,
    ...obj,
    confidence: { ...DEFAULT_BROWNFIELD_POLICY.confidence, ...(obj.confidence ?? {}) },
    blockRules: { ...DEFAULT_BROWNFIELD_POLICY.blockRules, ...(obj.blockRules ?? {}) },
    block: obj.block ?? DEFAULT_BROWNFIELD_POLICY.block,
    warn: obj.warn ?? DEFAULT_BROWNFIELD_POLICY.warn,
    addedRequiresChangedLines:
      obj.addedRequiresChangedLines ?? DEFAULT_BROWNFIELD_POLICY.addedRequiresChangedLines,
    // A non-positive / non-finite / non-number JSON value is ignored so a
    // malformed policy silently falls back to the canonical default rather than
    // disabling the large-file signal (e.g. threshold 0 → everything flagged).
    largeFileThreshold: normalizeLargeFileThreshold(obj.largeFileThreshold),
    mode: 'brownfield',
  };
}

/** Accept only a positive, finite number as an override; anything else → unset
 *  (the producer then falls back to `LARGE_FILE_THRESHOLD_LINES`). */
function normalizeLargeFileThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Convenience wrapper for callers that don't take a `--policy`
 * override (e.g., `createBaseline`). Loads the conventional file if
 * present; returns defaults otherwise.
 */
export function loadPolicyFromCwd(cwd: string): BrownfieldPolicy {
  return resolvePolicy(undefined, cwd);
}
