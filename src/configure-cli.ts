/**
 * `vyuh-dxkit configure [--plan|--apply] [--json]` — the DETERMINISTIC config
 * planner (CLAUDE.md Rule 16 capability).
 *
 * As dxkit's capability surface grows, "what should this repo configure, and to
 * what value?" becomes a real question. The answer must be REPRODUCIBLE — the
 * same repo yielding the same config on every run and in every environment —
 * not a judgment call an agent makes differently each time. So the decision
 * lives in code, not in a skill's prose: each capability declares a pure
 * `planConfig` on its registry descriptor (`src/discovery/commands.ts`) that
 * computes its config from observable repo facts, and this command is the thin
 * surface over `gatherConfigPlan`.
 *
 *   - `configure` / `--plan` (default): compute + show the plan. Every line
 *     cites the fact(s) that forced it (`evidence`) — no agent subjectivity.
 *   - `--apply`: merge-write the plan into `.dxkit/policy.json`, preserving
 *     every existing key (the #68 non-clobber discipline). Idempotent — the
 *     planners go silent once a section is pinned, so re-running is a no-op.
 *
 * Registry-driven + future-proof: `gatherConfigPlan` iterates the capability
 * registry, so a capability that lands tomorrow with its own `planConfig` joins
 * the plan automatically — this file never changes. The `dxkit-onboard` skill
 * is the conversational driver: it runs `--plan`, shows it, gets the user's
 * confirmation, then runs `--apply`.
 */
import * as logger from './logger';
import { gatherConfigPlan, type ConfigPlanItem, type ConfigContext } from './discovery/commands';
import { deepMergePolicy, mergeIntoPolicyFile } from './baseline/policy-write';

export interface ConfigureOptions {
  /** Write the plan into policy.json (default is plan-only, no write). */
  readonly apply?: boolean;
  /** Verify mode: exit non-zero if any recommended config is still un-applied.
   *  For CI — makes the deterministic plan an enforceable invariant, not just a
   *  suggestion a model may or may not follow. */
  readonly check?: boolean;
  readonly json?: boolean;
  /** Test seam: inject the baseline visibility / default-ref probes so the
   *  plan is deterministic without a live `gh` / git call. */
  readonly probes?: Omit<ConfigContext, 'cwd'>;
}

export function runConfigure(cwd: string, opts: ConfigureOptions = {}): void {
  const plan = gatherConfigPlan(cwd, opts.probes ?? {});

  if (opts.check) {
    checkAndReport(plan, opts);
    return;
  }
  if (opts.apply) {
    applyAndReport(cwd, plan, opts);
    return;
  }
  renderPlan(plan, opts);
}

/**
 * `configure check` — the enforceable drift detector. Exits non-zero when the
 * plan is NON-EMPTY, i.e. a capability the registry exposes has recommended
 * config that policy.json hasn't applied yet (a newly-shipped capability, or a
 * section someone removed). This is the teeth behind determinism: a coding
 * agent that hand-edits policy.json instead of running `configure`, and misses
 * a section, is caught here in CI regardless of which model drove it.
 *
 * By design it does NOT flag a section that IS set to a non-computed value —
 * the planner treats a pinned section as a deliberate override and stays silent
 * on it, so `check` respects overrides too. It verifies COMPLETENESS (nothing
 * recommended is missing), not that every value matches the default.
 */
function checkAndReport(plan: readonly ConfigPlanItem[], opts: ConfigureOptions): void {
  const ok = plan.length === 0;
  if (opts.json) {
    console.log(JSON.stringify({ schema: 'configure-check.v1', ok, pending: plan }, null, 2)); // slop-ok
    if (!ok) process.exitCode = 1;
    return;
  }

  logger.header('dxkit configure check');
  console.log(''); // slop-ok
  if (ok) {
    logger.info('policy.json reflects the computed plan — no pending configuration.');
    return;
  }
  logger.warn(`${plan.length} recommended section(s) are not applied:`);
  for (const item of plan) logger.dim(`  • ${item.section} → ${item.summary} (${item.evidence})`);
  console.log(''); // slop-ok
  logger.dim('Run `vyuh-dxkit configure --apply` to bring policy.json in line.');
  process.exitCode = 1;
}

/** `configure` / `configure --plan` — show the computed plan, no write. */
function renderPlan(plan: readonly ConfigPlanItem[], opts: ConfigureOptions): void {
  if (opts.json) {
    console.log(JSON.stringify({ schema: 'configure.v1', plan }, null, 2)); // slop-ok
    return;
  }

  logger.header('dxkit configure (plan — nothing written)');
  if (plan.length === 0) {
    console.log(''); // slop-ok
    logger.info('Nothing to configure — every capability is already pinned or has no signal here.');
    return;
  }
  console.log(''); // slop-ok
  for (const item of plan) {
    logger.info(`${item.section} → ${item.summary}`);
    logger.dim(`  ${item.reason}`);
    logger.dim(`  evidence: ${item.evidence}${item.skill ? ` · skill: ${item.skill}` : ''}`);
  }
  console.log(''); // slop-ok
  logger.dim('Deterministic: the same repo yields this exact plan every run.');
  logger.dim('Apply it with `vyuh-dxkit configure --apply` (merges into .dxkit/policy.json,');
  logger.dim('preserving your existing settings).');
}

/** `configure --apply` — merge-write the plan, then report what changed. */
function applyAndReport(
  cwd: string,
  plan: readonly ConfigPlanItem[],
  opts: ConfigureOptions,
): void {
  const result = applyConfigPlan(cwd, plan);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { schema: 'configure-apply.v1', changed: result.changed, sections: result.sections, plan },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  logger.header('dxkit configure --apply');
  if (plan.length === 0) {
    console.log(''); // slop-ok
    logger.info('Nothing to configure — every capability is already pinned or has no signal here.');
    return;
  }
  console.log(''); // slop-ok
  if (!result.changed) {
    logger.info('.dxkit/policy.json already matches the plan — no change.');
    return;
  }
  for (const item of plan) logger.info(`  ✓ ${item.section} → ${item.summary}`);
  console.log(''); // slop-ok
  logger.info(`Wrote ${result.sections.length} section(s) into .dxkit/policy.json.`);
  logger.dim('Commit it so every developer + CI share the same posture.');
}

/** Outcome of an apply: whether the file changed + which sections were merged. */
export interface ApplyResult {
  readonly changed: boolean;
  readonly sections: readonly string[];
}

/**
 * Deep-merge every plan item's `patch` into `.dxkit/policy.json`, PRESERVING
 * every existing key. The read-merge-write mechanics live in the canonical
 * policy merge-writer (`mergeIntoPolicyFile`, Rule 2); this wrapper folds the
 * plan's patches into one merged patch and reports which sections it carried.
 * A malformed existing policy is left intact and reported via the return
 * (`changed: false`), never overwritten.
 */
export function applyConfigPlan(cwd: string, plan: readonly ConfigPlanItem[]): ApplyResult {
  const sections = plan.map((p) => p.section);
  if (plan.length === 0) return { changed: false, sections };

  let patch: Record<string, unknown> = {};
  for (const item of plan) patch = deepMergePolicy(patch, item.patch);
  const outcome = mergeIntoPolicyFile(cwd, patch);
  return { changed: outcome.changed, sections };
}
