/**
 * `vyuh-dxkit gate <dir>` — the one-shot tree gate (4.4.0 WP2 / P0-1).
 *
 * Judges a DIRECTORY (a freshly generated package, an exported tree — no
 * git, no init, no repo install) through the ONE engine: subject =
 * tree, prior = `fresh` (empty — everything net-new by construction) or
 * `tree-baseline` (`--baseline <dir>`, the generated-vs-edited diff),
 * policy = `--policy <file>` or the tree's own `.dxkit/policy.json` or
 * the compiled-in default. On top of the finding diff it runs the
 * correctness floor ("does it compile, do its tests pass") — the part
 * of a verdict findings cannot carry.
 *
 * Trust (a DECLARED boundary, decision #2 of the 4.4.0 plan): the
 * subject tree is UNTRUSTED by default — dxkit will not execute code
 * from a tree it is merely judging, so the floor and command-shaped
 * custom checks are disclosed skips until the caller passes
 * `--trusted` (a generated package the caller owns, a sandboxed
 * consumer). Declarative text rules and every pure analyzer run either
 * way.
 *
 * Exit codes (gate-owned; `guardrail check` keeps its own contract):
 * 0 passed · 1 blocked · 2 cannot gate. Derived from the ONE verdict
 * derivation (`verdictCounts`) plus the floor — never `blocks ? 1 : 0`.
 */

import * as path from 'path';
import { runGate } from './gate/engine';
import type { GuardrailCheckResult } from './gate/result';
import { resolveGateMode } from './baseline/modes';
import { resolvePolicy } from './baseline/policy';
import { trustContextFromFlag } from './analysis-trust';
import { renderConsole, verdictCounts, type VerdictCounts } from './baseline/check-renderers';
import { buildWireVerdict } from './gate/verdict';
import {
  describeCorrectnessFloor,
  runCorrectnessFloor,
  type CorrectnessFloorResult,
} from './analyzers/correctness/run';
import {
  attributeFloorFailures,
  type AttributedFloorFailure,
  type FloorBaseCheck,
} from './analyzers/correctness/attribution';
import { detectActiveLanguages } from './languages';

export interface GateCommandOptions {
  /** Prior tree for the generated-vs-edited diff (H2). Absent = fresh. */
  readonly baselineDir?: string;
  /** Explicit policy document (P0-3). Falls back to the tree's own
   *  `.dxkit/policy.json`, then the compiled-in default. */
  readonly policyPath?: string;
  readonly json?: boolean;
  /** Consent to EXECUTE the tree's code (floor + command checks). */
  readonly trusted?: boolean;
  readonly verbose?: boolean;
  /** Test seam: injected floor runner (the ExecutorSeams pattern). */
  readonly seams?: {
    readonly runFloor?: typeof runCorrectnessFloor;
  };
}

/** Why the floor did not run — a disclosed cause, never a silent skip. */
export interface FloorSkip {
  readonly cause: 'untrusted';
  readonly detail: string;
}

export interface GateCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
  /** The verdict word the exit code was derived from (floor-aware). */
  readonly verdict: string;
  readonly result: GuardrailCheckResult;
  readonly counts: VerdictCounts;
  /** Present when the floor ran (subject side). */
  readonly floor?: CorrectnessFloorResult;
  /** Net-new floor failures after attribution vs the baseline tree
   *  (or vs the empty prior — everything net-new by construction). */
  readonly floorNetNew: ReadonlyArray<AttributedFloorFailure>;
  /** Present when the floor was skipped, with the declared cause. */
  readonly floorSkipped?: FloorSkip;
}

/** Map a floor check status onto the attribution comparator's base shape. */
function toBaseCheck(c: CorrectnessFloorResult['checks'][number]): FloorBaseCheck {
  return {
    pack: c.pack,
    label: c.label,
    status: c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : 'skipped',
    ...(c.findings !== undefined ? { findings: c.findings } : {}),
  };
}

/**
 * Run the gate over a tree. Pure composition of existing machinery —
 * the engine judges, the floor runner executes, the ONE attribution
 * comparator decides fault, and the ONE verdict derivation plus the
 * floor picks the exit code. No verdict path is forked here.
 */
export async function runGateCommand(
  dir: string,
  options: GateCommandOptions = {},
): Promise<GateCommandOutcome> {
  const subjectDir = path.resolve(dir);
  const baselineDir =
    options.baselineDir !== undefined ? path.resolve(options.baselineDir) : undefined;
  const mode = resolveGateMode(baselineDir !== undefined ? { baselineDir } : {});
  const policy = resolvePolicy(options.policyPath, subjectDir);
  // --trusted is the consent flag; its ABSENCE is the untrusted posture.
  const trust = trustContextFromFlag(!options.trusted);

  const result = await runGate({ kind: 'tree', dir: subjectDir }, mode, policy, {
    trust,
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });
  const counts = verdictCounts(result);

  // The correctness floor — only with consent to execute (the floor runs
  // the tree's own compile + tests). Skipping is DISCLOSED, and per the
  // shared acceptance philosophy a skipped check is never a passed check:
  // the verdict word stays whatever the findings earned, but the receipt
  // says the floor did not run and why.
  let floor: CorrectnessFloorResult | undefined;
  let floorNetNew: AttributedFloorFailure[] = [];
  let floorSkipped: FloorSkip | undefined;
  if (trust.repoExecutionAllowed) {
    const runFloor = options.seams?.runFloor ?? runCorrectnessFloor;
    floor = runFloor({
      cwd: subjectDir,
      changedFiles: [],
      scope: 'full',
      packs: detectActiveLanguages(subjectDir),
    });
    // Attribution through the ONE comparator (Rule 2): fresh mode has no
    // base — everything is this tree's own fault by construction
    // (absentMeans 'net-new'). Tree-baseline mode captures the base
    // tree's floor with the same runner, so a failure the generated
    // baseline already had is pre-existing, never blamed on the edit.
    let base: FloorBaseCheck[] | null = null;
    if (baselineDir !== undefined) {
      const baseFloor = runFloor({
        cwd: baselineDir,
        changedFiles: [],
        scope: 'full',
        packs: detectActiveLanguages(baselineDir),
      });
      base = baseFloor.checks.map(toBaseCheck);
    }
    floorNetNew = attributeFloorFailures(floor, base, { absentMeans: 'net-new' }).filter(
      (a) => a.attribution === 'net-new',
    );
  } else {
    floorSkipped = {
      cause: 'untrusted',
      detail:
        'correctness floor skipped: the tree is untrusted (dxkit will not execute code it is ' +
        'merely judging). Pass --trusted to consent to running its compile + tests.',
    };
  }

  // Exit-code derivation: the one verdict derivation first, then the
  // floor. A net-new floor failure is a BLOCK (fail-closed on a real
  // failure — Rule 15); a refusal (CANNOT GATE) maps to the gate's own
  // exit 2. Precedence mirrors verdictWordFrom: a definite regression
  // outranks a refusal.
  const floorBlocks = floorNetNew.length > 0;
  let exitCode: 0 | 1 | 2;
  let verdict: string;
  if (counts.verdict === 'BLOCKED' || floorBlocks) {
    exitCode = 1;
    verdict = 'BLOCKED';
  } else if (counts.verdict === 'CANNOT GATE') {
    exitCode = 2;
    verdict = 'CANNOT GATE';
  } else {
    exitCode = 0;
    verdict = counts.verdict;
  }

  return {
    exitCode,
    verdict,
    result,
    counts,
    ...(floor !== undefined ? { floor } : {}),
    floorNetNew,
    ...(floorSkipped !== undefined ? { floorSkipped } : {}),
  };
}

/**
 * Render the outcome: human console text, or the frozen `verdict.v1`
 * wire document (P0-2 — stable JSON on stdout; the workbench renders,
 * dxkit decides). `guardrail check --json` keeps its own payload shape
 * untouched this release.
 */
export function renderGateOutcome(outcome: GateCommandOutcome, json: boolean): string {
  if (json) {
    return JSON.stringify(buildWireVerdict(outcome, renderGateReceipt(outcome)), null, 2);
  }
  return renderGateReceipt(outcome);
}

/** The human receipt — also embedded verbatim in the verdict.v1 doc. */
function renderGateReceipt(outcome: GateCommandOutcome): string {
  const lines: string[] = [renderConsole(outcome.result)];
  if (outcome.floor) {
    lines.push('', describeCorrectnessFloor(outcome.floor));
    if (outcome.floorNetNew.length > 0) {
      lines.push(
        `Floor: ${outcome.floorNetNew.length} net-new failure(s) — the gate BLOCKS on a broken floor.`,
      );
    }
  } else if (outcome.floorSkipped) {
    lines.push(
      '',
      `Floor: SKIPPED (${outcome.floorSkipped.cause}) — ${outcome.floorSkipped.detail}`,
    );
  }
  lines.push('', `Gate verdict: ${outcome.verdict} (exit ${outcome.exitCode})`);
  return lines.join('\n');
}

/** Actionable failure hint for the CLI wrapper. */
export function gateFailureHint(err: Error): string {
  return `gate failed: ${err.message}`;
}
