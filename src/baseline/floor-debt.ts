/**
 * Floor DEBT — the committed, agent-readable inventory of the repo's
 * pre-existing correctness-floor state (broken build, failing tests),
 * captured at baseline time.
 *
 * # What this is, and deliberately is not
 *
 * A failing floor check is a pass/fail SIGNAL, not a finding (CLAUDE.md
 * Rule 15): it carries no fingerprint, enters no matcher, and can never be
 * allowlisted — you don't grandfather a syntax error by identity, you fix
 * it. This envelope does not change that. It exists for the OTHER half of
 * the adoption story: once the gates are armed and regressions are blocked,
 * a cleanup agent needs a durable, detailed record of the debt it should
 * burn down — WHICH checks were failing when the baseline was captured,
 * with the reproduction command and the actual compiler/test output, not
 * just "kotlin compile failed".
 *
 * The envelope is informational: the guardrail verdict never reads it. The
 * gate's own comparison base is always LIVE (the loop's entry snapshot, the
 * CI floor's merge-base run), because stored build errors go stale the
 * moment anything changes. Consumers are told the same: `vyuh-dxkit debt`
 * re-runs the floor for ground truth and uses this envelope for provenance
 * ("failing since the baseline was captured") and prioritization.
 *
 * Capture is BOUNDED (a generous per-check budget) so `baseline create`
 * cannot hang on a pathological suite; a check that exceeds it records
 * honestly as `skipped-timeout`, never as pass or fail.
 */
import { execFileSync } from 'child_process';
import { detectActiveLanguages } from '../languages';
import type { LanguageSupport } from '../languages/types';
import {
  runCorrectnessFloor,
  type CommandExec,
  type CorrectnessStatus,
} from '../analyzers/correctness/run';
import { describeUnmetRequirement, hostOf } from '../execution';

/** Per-check budget for baseline-time capture. Generous — this is a one-time
 *  inventory pass, not a hook — but bounded, so a capture can never hang. */
const BASELINE_FLOOR_TIMEOUT_MS = 600_000;

/** One floor check as recorded in the baseline envelope. */
export interface FloorDebtCheck {
  readonly pack: string;
  readonly label: string;
  /** The reproduction command (bin + args) an agent runs to see the
   *  failure itself. Empty for requirement-level skips. */
  readonly command: string;
  readonly status: CorrectnessStatus;
  /** Captured output tail on `fail` (the actual compiler/test errors), or
   *  the disclosed reason on an unavailable skip. */
  readonly output?: string;
  /** Human-phrased environment boundary on `skipped-environment` — what is
   *  needed and where the check would run (Rule 20 disclosure). */
  readonly unmet?: string;
}

/** The committed floor-debt envelope on a BaselineFile. */
export interface FloorDebt {
  readonly capturedAtCommit: string | null;
  readonly capturedAt: string;
  readonly checks: ReadonlyArray<FloorDebtCheck>;
}

/** The failing subset — the debt itself. */
export function failingFloorDebt(debt: FloorDebt): ReadonlyArray<FloorDebtCheck> {
  return debt.checks.filter((c) => c.status === 'fail');
}

/**
 * Run the full-scope floor and record it as a debt envelope. Returns null
 * when no active pack provides a floor (the envelope is then omitted — a
 * repo with no floor has no floor debt, which is different from "all
 * green"). `exec`/`packs`/`now` are injectable for tests.
 */
export function captureFloorDebt(
  cwd: string,
  opts: {
    readonly exec?: CommandExec;
    readonly packs?: readonly LanguageSupport[];
    readonly timeoutMs?: number;
    readonly now?: () => Date;
  } = {},
): FloorDebt | null {
  const packs = (opts.packs ?? detectActiveLanguages(cwd)).filter((p) => p.correctness);
  if (packs.length === 0) return null;
  const result = runCorrectnessFloor({
    cwd,
    changedFiles: [],
    scope: 'full',
    packs,
    timeoutMs: opts.timeoutMs ?? BASELINE_FLOOR_TIMEOUT_MS,
    exec: opts.exec,
  });
  const host = hostOf();
  const checks: FloorDebtCheck[] = result.checks.map((c) => ({
    pack: c.pack as string,
    label: c.label,
    command: [c.bin, ...(c.args ?? [])].filter(Boolean).join(' '),
    status: c.status,
    ...(c.output !== undefined ? { output: c.output } : {}),
    ...(c.unmet !== undefined ? { unmet: describeUnmetRequirement(c.unmet, host) } : {}),
  }));
  let capturedAtCommit: string | null = null;
  try {
    capturedAtCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* no commit / not a repo — informational field stays null */
  }
  return {
    capturedAtCommit,
    capturedAt: (opts.now?.() ?? new Date()).toISOString(),
    checks,
  };
}
