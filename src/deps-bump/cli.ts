/**
 * `vyuh-dxkit deps bump` — console/JSON front-end over the deterministic
 * bump lane (`runDepsBump`). Dry-run by default; `--apply` executes the
 * bumps and verifies (floor + guardrail); `--land pr` additionally lands
 * manifest + lockfile on the standing branch and opens/updates the one
 * reviewable PR (the scheduled workflow's path).
 *
 * Exit code: 0 for a clean outcome (planned / applied / landed /
 * nothing-to-do), 1 when the lane refused or the floor went red — the
 * scheduled workflow surfaces that as a job failure with the ledger in the
 * step summary.
 */

import * as fs from 'fs';
import * as logger from '../logger';
import { trustedLocalContext } from '../analysis-trust';
import { runDepsBump, type DepsBumpResult } from './run';

export interface DepsBumpCliOptions {
  readonly apply: boolean;
  readonly allowMajor: boolean;
  readonly land: 'pr' | 'none';
  readonly json: boolean;
}

export async function runDepsBumpCli(cwd: string, opts: DepsBumpCliOptions): Promise<number> {
  const result = await runDepsBump({
    cwd,
    // Local/CI default-branch execution — the lane's only supported surface.
    trust: trustedLocalContext(),
    apply: opts.apply,
    allowMajor: opts.allowMajor,
    land: opts.land,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(projectJson(result), null, 2) + '\n');
  } else {
    renderConsole(result, opts);
  }
  // The ledger doubles as the CI job summary when running under Actions.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, result.ledger + '\n');
    } catch {
      // best-effort — a summary write failure must not fail the lane
    }
  }
  return result.outcome === 'refused' || result.outcome === 'floor-red' ? 1 : 0;
}

function projectJson(result: DepsBumpResult): Record<string, unknown> {
  return {
    schema: 'deps-bump.v1',
    outcome: result.outcome,
    bumps: result.plan.bumps,
    applied: result.applied,
    skipped: result.plan.skipped,
    ...(result.floor !== undefined
      ? { floor: { ran: result.floor.ran, blocks: result.floor.blocks } }
      : {}),
    ...(result.guardrailVerdict !== undefined ? { guardrailVerdict: result.guardrailVerdict } : {}),
    ...(result.land !== undefined ? { land: result.land } : {}),
    ...(result.note !== undefined ? { note: result.note } : {}),
    ledger: result.ledger,
  };
}

function renderConsole(result: DepsBumpResult, opts: DepsBumpCliOptions): void {
  logger.header('dxkit deps bump');
  const { plan } = result;
  if (result.outcome === 'nothing-to-do') {
    logger.info('No bumpable dependency vulnerabilities — nothing to do.');
  } else if (result.outcome === 'planned') {
    logger.info(`Plan (dry run — pass --apply to execute): ${plan.bumps.length} bump(s).`);
    for (const b of plan.bumps) {
      const from = b.fromVersion ? `${b.fromVersion} → ` : '→ ';
      logger.info(
        `  ${b.parent} ${from}${b.toVersion}${b.breaking ? ' (major)' : ''}  ` +
          `[${b.maxSeverity}] closes ${b.advisories.join(', ')}`,
      );
    }
  } else {
    for (const b of result.applied) {
      logger.info(
        `  ${b.parent} → ${b.toVersion}: ${b.applied ? 'applied' : `FAILED (${b.failure ?? 'install error'})`}`,
      );
    }
    if (result.floor) {
      (result.floor.blocks ? logger.fail : logger.success)(
        `Correctness floor (full): ${result.floor.blocks ? 'FAILED' : 'passed'}`,
      );
    }
    if (result.guardrailVerdict) logger.info(`Guardrail: ${result.guardrailVerdict}`);
    if (result.land) {
      logger.info(
        `Landed: ${result.land.outcome}${result.land.prUrl ? ` — ${result.land.prUrl}` : ''}`,
      );
    }
  }
  if (result.note) logger.warn(result.note);
  if (plan.skipped.length > 0) {
    logger.dim(
      `Not bumped (disclosed): ${plan.skipped.length} advisory/ies — see --json or the ledger.`,
    );
  }
  if (result.outcome === 'planned' && !opts.apply && plan.bumps.length > 0) {
    logger.dim(
      '  Apply + verify: vyuh-dxkit deps bump --apply   (add --land pr to open the standing PR)',
    );
  }
}
