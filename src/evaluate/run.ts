/**
 * The zero-write trial runner — `vyuh-dxkit evaluate`.
 *
 * Replays the guardrail gate over historical ref pairs (a single
 * `--base`/`--head` pair, or the last N landings of the current branch)
 * and reports what the gate WOULD have blocked — without writing anything
 * to the repository: no `.dxkit/`, no baseline file, no refs, no hooks.
 *
 * The zero-write guarantee is structural, not best-effort: the gate NEVER
 * runs with the user's repo as its working directory. Each landing's head
 * side is checked out into a disposable `withRefWorktree` temp dir and the
 * guardrail runs from there (`cliMode: 'ref-based'` diffing against the
 * landing's base), so every cache the pipeline writes (`.dxkit/cache/…`)
 * lands in the temp worktree and is torn down with it. Pinned by
 * `test/evaluate/zero-write.test.ts`.
 *
 * Everything here is composition of existing gate machinery — the trial
 * must never fork a verdict path (one concept, one code path): the diff is
 * `runGuardrailCheck`, the posture is `policyForPreset`, the checkout is
 * `withRefWorktree`.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { runGuardrailCheck } from '../baseline/check';
import { scopeForPolicy } from '../baseline/gather-scope';
import { DEFAULT_POLICY_FILENAME, resolvePolicy } from '../baseline/policy';
import { DEFAULT_LOOP_PRESET, type LoopPreset, policyForPreset } from '../baseline/presets';
import { RefBaselineError, resolveRefToSha, withRefWorktree } from '../baseline/ref-baseline';
import {
  buildErrorEvidence,
  buildEvidenceDoc,
  buildRunEvidence,
  type EvaluateEvidenceDoc,
  type EvaluateRunEvidence,
  runLabel,
} from './evidence';
import { enumerateLandings, type LandingPair } from './pr-ranges';

export interface EvaluateOptions {
  readonly cwd: string;
  /** Single-pair mode: replay exactly this base→head diff. */
  readonly base?: string;
  readonly head?: string;
  /** History mode: replay the last N landings of `ref` (default HEAD).
   *  Used when `base`/`head` are not given; defaults to 10. */
  readonly lastLandings?: number;
  readonly preset?: LoopPreset;
  /** Incremental scanning (changed-files-scoped semgrep, manifest-gated
   *  dep audit) — the same soundness argument as the CI ref-based gate.
   *  Default true; `--no-incremental` opts out for a full-tree replay. */
  readonly incremental?: boolean;
  readonly untrusted?: boolean;
  readonly verbose?: boolean;
  /** Per-landing progress line, wired to stderr by the CLI. */
  readonly onProgress?: (line: string) => void;
}

/** A ref pair the trial will replay, resolved to SHAs up front so an
 *  unresolvable ref fails fast with a targeted message. */
interface ResolvedPair {
  readonly pair: LandingPair;
}

function currentBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '(unknown)';
  }
}

/** A raw 40-hex ref renders friendlier shortened; named refs stay verbatim. */
function displayRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref;
}

function resolveExplicitPair(cwd: string, base: string, head: string): ResolvedPair {
  const baseSha = resolveRefToSha(cwd, base);
  if (!baseSha) throw new RefBaselineError(`Cannot resolve --base ${base}.`, fetchHint(base));
  const headSha = resolveRefToSha(cwd, head);
  if (!headSha) throw new RefBaselineError(`Cannot resolve --head ${head}.`, fetchHint(head));
  return {
    pair: {
      baseSha,
      headSha,
      subject: `${displayRef(base)}..${displayRef(head)}`,
      committedAt: '',
      prNumber: undefined,
    },
  };
}

function fetchHint(ref: string): string {
  return `Run \`git fetch origin\` (or \`git fetch --unshallow\` on a shallow clone) so ${ref} is reachable locally.`;
}

/**
 * Run the trial. Per-landing failures do not abort the run — they become
 * `error` rows in the evidence so a 20-landing replay with one unreadable
 * ref still reports the other 19.
 */
export async function runEvaluate(opts: EvaluateOptions): Promise<EvaluateEvidenceDoc> {
  const cwd = path.resolve(opts.cwd);
  const preset = opts.preset ?? DEFAULT_LOOP_PRESET;
  const presetSource: 'flag' | 'default' = opts.preset ? 'flag' : 'default';
  const incremental = opts.incremental ?? true;
  const untrusted = opts.untrusted ?? false;

  // The base policy is the repo's committed policy when one exists (the
  // user's current intent), else the compiled-in defaults — so the trial
  // works on a repo with no dxkit install at all. The preset then replaces
  // the blocking posture, exactly as the loop Stop-gate does.
  const hasRepoPolicy = existsSync(path.join(cwd, DEFAULT_POLICY_FILENAME));
  const applied = policyForPreset(preset, resolvePolicy(undefined, cwd));
  // Scope the gather exactly the way the Stop-gate does for this policy —
  // the replay measures the gate the user would actually run, and a
  // security-only trial skips the analyzers it can never block on.
  const scope = scopeForPolicy(applied.policy);

  let pairs: ResolvedPair[];
  let trialRef: string;
  if (opts.base || opts.head) {
    if (!opts.base || !opts.head) {
      throw new RefBaselineError(
        'evaluate needs both --base and --head (or neither, for the last-landings replay).',
        'Example: vyuh-dxkit evaluate --base origin/main~5 --head origin/main',
      );
    }
    pairs = [resolveExplicitPair(cwd, opts.base, opts.head)];
    trialRef = `${displayRef(opts.base)}..${displayRef(opts.head)}`;
  } else {
    const count = opts.lastLandings ?? 10;
    const landings = enumerateLandings(cwd, count);
    if (landings.length === 0) {
      throw new RefBaselineError(
        'No landings found to replay: the current branch has no first-parent history with a base side.',
        'Point evaluate at a branch with merged history, or pass an explicit --base/--head pair.',
      );
    }
    pairs = landings.map((pair) => ({ pair }));
    trialRef = 'HEAD';
  }

  const runs: EvaluateRunEvidence[] = [];
  for (const { pair } of pairs) {
    const started = Date.now();
    opts.onProgress?.(`evaluating ${runLabel(pair)} (${pair.headSha.slice(0, 8)})…`);
    try {
      // The head side gets its own disposable worktree; the gate runs FROM
      // that worktree, never from the user's repo (the zero-write spine).
      // Worktrees share the object DB, so the base SHA resolves inside it.
      const result = await withRefWorktree({ cwd, ref: pair.headSha }, (headWorktree) =>
        runGuardrailCheck({
          cwd: headWorktree,
          cliMode: 'ref-based',
          cliRef: pair.baseSha,
          policy: applied.policy,
          flowMode: applied.flowMode,
          schemaMode: applied.schemaMode,
          scope,
          incremental,
          untrusted,
          verbose: opts.verbose,
        }),
      );
      runs.push(buildRunEvidence(result, { pair, durationMs: Date.now() - started }));
    } catch (err) {
      const e = err as Error & { hint?: string };
      runs.push(
        buildErrorEvidence(pair, Date.now() - started, {
          message: e.message,
          hint: e.hint,
        }),
      );
    }
  }

  return buildEvidenceDoc({
    branch: currentBranch(cwd),
    ref: trialRef,
    preset,
    presetSource,
    policyBase: hasRepoPolicy ? 'repo-policy' : 'defaults',
    incremental,
    untrusted,
    runs,
  });
}
