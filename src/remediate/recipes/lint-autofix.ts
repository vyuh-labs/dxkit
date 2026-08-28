/**
 * The `lint-autofix` recipe: a `lint-located` order (one file's located lint
 * findings) is fixed by the PACK linter's own fix mode, scoped to that file
 * (`LintGateProvider.fixCommand`, Rule 6: the ecosystem's fixer comes from
 * the pack, never a hardcoded eslint string here). One execution both writes
 * the fixes and reports the remaining findings through the pack's own
 * parser, validated by the seam's ONE located-finding boundary
 * (`parseLocated` / `parseStructuredLocated`, Rule 17), so the recipe's
 * verify reads the leftovers of the very command that fixed.
 *
 * Verify: the file must lint clean afterwards for a full apply. When rules
 * remain and EVERY one of them is among the order's own rules, the failure
 * carries them structurally (`leftoverRules`) so the grouped runner can
 * evaluate each slice-order of the file individually: the fix runs ONCE
 * per file, slices whose rules are all gone apply, and unfixed slices fall
 * to the agent tier. A leftover rule OUTSIDE the order's own set (net-new,
 * or unparsed) fails the whole attempt plain, and the runner discards the
 * diff: a fix that mints findings never lands.
 */
import { tail } from '../../analyzers/tools/bounded-exec';
import { parseLocated, parseStructuredLocated } from '../../analyzers/custom-checks/parse';
import type { CustomCheckFinding } from '../../analyzers/custom-checks/types';
import { getLanguage } from '../../languages';
import type { LanguageId } from '../../languages/types';
import { environmentRefusal, exemptionReason, packDeclaration } from './shared';
import type { WorkOrder } from '../work-orders/types';
import type { RecipeExecuteContext, RecipeOutcome } from './types';

/** The pack behind a built-in lint check name (`lint:<pack>`), or null for
 *  a user-declared check (which has no pack fixer to call). */
export function lintPackOf(check: string): string | null {
  return check.startsWith('lint:') ? check.slice('lint:'.length) : null;
}

export async function executeLintAutofix(
  order: WorkOrder,
  ctx: RecipeExecuteContext,
): Promise<RecipeOutcome> {
  const first = order.findings[0]?.evidence;
  if (!first || first.type !== 'custom-check' || !first.file) {
    return { kind: 'refused', reason: 'the order carries no located custom-check evidence' };
  }
  const file = first.file;
  const pack = lintPackOf(first.check);
  if (pack === null) {
    return {
      kind: 'refused',
      reason:
        `'${first.check}' is a user-declared check, and dxkit does not know its fixer; only ` +
        'pack lint gates have a declared fix mode',
    };
  }
  // The pack's declared lintFix capability (the rider over
  // `lintGate.fixCommand`, Rule 2): an exemption refuses with the declared
  // reason; the registry's `matches` already tiers such orders to the agent.
  const declaration = packDeclaration(pack, 'lintFix');
  if (declaration !== undefined && declaration.kind === 'exemption') {
    return { kind: 'refused', reason: exemptionReason(pack, declaration) };
  }
  const provider = getLanguage(pack as LanguageId)?.lintGate;
  // Rule 20, decided before anything spawns: the gate's declared execution
  // requirement gates the fix run with a disclosed refusal (the same
  // doctrine as the dependency recipes), so a missing JDK or Go toolchain
  // reads as routing, never as a fix failure.
  if (provider !== undefined) {
    const envRefusal = environmentRefusal(
      `the ${pack} pack's linter fix mode`,
      (cwd) => provider.execution(cwd),
      ctx.cwd,
    );
    if (envRefusal) return envRefusal;
  }
  const fix = provider?.fixCommand?.({ cwd: ctx.cwd, files: [file] }) ?? null;
  if (fix === null) {
    return {
      kind: 'refused',
      reason: provider?.fixCommand
        ? `the ${pack} pack's linter fix mode is not resolvable in this repo`
        : `the ${pack} pack declares no linter fix mode`,
    };
  }

  const run = ctx.exec({ bin: fix.bin, args: fix.args }, ctx.cwd);
  if (!run.available) {
    return { kind: 'failed', step: 'fix', output: `${fix.bin} is not available here` };
  }
  if (run.timedOut) return { kind: 'failed', step: 'fix', output: 'the fix run timed out' };
  if (run.overflowed) {
    return { kind: 'failed', step: 'fix', output: 'the fix run overflowed the capture buffer' };
  }

  // The same run's output IS the verify input: remaining findings, through
  // the seam's validating boundary (repo-relative POSIX file, deduped).
  const remaining: CustomCheckFinding[] =
    fix.parse.kind === 'structured'
      ? parseStructuredLocated(first.check, true, fix.parse.parse, run.output, ctx.cwd)
      : parseLocated(first.check, true, fix.parse.pattern, run.output, ctx.cwd);
  const inFile = remaining.filter((f) => f.file === file || f.file === undefined);
  if (inFile.length > 0) {
    const rules = [...new Set(inFile.map((f) => f.rule ?? '(unparsed)'))].sort();
    const known = new Set(
      order.findings.map((f) => (f.evidence.type === 'custom-check' ? f.evidence.rule : undefined)),
    );
    // Structured leftovers ONLY when every remaining rule is one the order
    // already knew about: an unknown or unparsed rule is net-new (or
    // unattributable), and the whole attempt must fail plain so the runner
    // discards the diff.
    const allKnown = rules.every((r) => known.has(r));
    return {
      kind: 'failed',
      step: 'verify-lint',
      output: tail(
        `${inFile.length} finding(s) remain in ${file} after the autofix ` +
          `(rules: ${rules.join(', ')}): ` +
          (allKnown
            ? 'not auto-fixable; the unfixed orders fall to the agent tier'
            : 'not all among the order findings (net-new or unparsed); discarding the fix'),
      ),
      ...(allKnown ? { leftoverRules: rules } : {}),
    };
  }
  return { kind: 'applied', changedFiles: [file] };
}
