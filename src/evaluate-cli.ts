/**
 * `vyuh-dxkit evaluate` — the CLI shell over the zero-write trial. Thin by
 * design (mirror of `receipt-cli.ts`): argument shaping, progress lines,
 * output selection, exit codes. The trial itself is `src/evaluate/run.ts`;
 * the verdicts come from the one guardrail path.
 *
 * Exit code is ALWAYS 0 on a completed trial, including one with blocked
 * landings: evaluate is an advisory replay, not a gate. Scripts that want
 * pass/fail read the JSON (`totals.blocked`) or run `guardrail check`.
 */
import { writeFileSync } from 'node:fs';
import * as logger from './logger';
import { isLoopPreset } from './baseline/presets';
import { RefBaselineError } from './baseline/ref-baseline';
import { runEvaluate } from './evaluate/run';
import { redactEvidence } from './evaluate/redact';
import { renderEvaluateText } from './evaluate/render';
import { trustContextFromFlag } from './analysis-trust';

export interface EvaluateCliOptions {
  readonly base?: string;
  readonly head?: string;
  readonly lastPrs?: string;
  readonly preset?: string;
  readonly json?: boolean;
  readonly redact?: boolean;
  readonly untrusted?: boolean;
  readonly noIncremental?: boolean;
  readonly verbose?: boolean;
  /** Write the evidence JSON to this path (an explicit, user-requested
   *  write — the repo itself still receives nothing). */
  readonly out?: string;
}

export async function runEvaluateCli(cwd: string, opts: EvaluateCliOptions): Promise<void> {
  if (opts.preset !== undefined && !isLoopPreset(opts.preset)) {
    logger.fail(`Unknown --preset ${opts.preset}. Available: security-only (default), full-debt.`);
    process.exit(1);
  }
  const lastLandings = opts.lastPrs !== undefined ? Number(opts.lastPrs) : undefined;
  if (lastLandings !== undefined && (!Number.isInteger(lastLandings) || lastLandings < 1)) {
    logger.fail(`--last-prs needs a positive integer, got ${opts.lastPrs}.`);
    process.exit(1);
  }

  try {
    const doc = await runEvaluate({
      cwd,
      base: opts.base,
      head: opts.head,
      lastLandings,
      preset: opts.preset !== undefined && isLoopPreset(opts.preset) ? opts.preset : undefined,
      incremental: opts.noIncremental ? false : undefined,
      trust: trustContextFromFlag(!!opts.untrusted),
      verbose: opts.verbose,
      onProgress: (line) => logger.dim(line),
    });
    const output = opts.redact ? redactEvidence(doc) : doc;
    if (opts.out) {
      writeFileSync(opts.out, JSON.stringify(output, null, 2) + '\n');
      logger.info(`Evidence written to ${opts.out}`);
    }
    if (opts.json) {
      console.log(JSON.stringify(output, null, 2)); // slop-ok: the report body IS stdout
    } else {
      console.log(renderEvaluateText(output)); // slop-ok: the report body IS stdout
    }
  } catch (err) {
    if (err instanceof RefBaselineError) {
      logger.fail(err.message);
      logger.dim(`  ${err.hint}`);
      process.exit(1);
    }
    throw err;
  }
}
