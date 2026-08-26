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
 * Verify is strict by construction: a single-slice lint order carries the
 * file's ENTIRE known finding set, so "the order's ids are absent AND no
 * net-new finding appeared in the envelope" collapses to "the file lints
 * clean". Anything remaining (an unfixable rule, a finding the fix
 * introduced) fails the recipe, the diff is discarded, and the order stays
 * open for the agent tier with the leftover rules named. A sliced order
 * (the file's findings span several orders) is refused: a file-scoped fix
 * cannot be verified per slice.
 */
import { tail } from '../../analyzers/tools/bounded-exec';
import { parseLocated, parseStructuredLocated } from '../../analyzers/custom-checks/parse';
import type { CustomCheckFinding } from '../../analyzers/custom-checks/types';
import { getLanguage } from '../../languages';
import type { LanguageId } from '../../languages/types';
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
  if (order.provenance.source === 'debt-slice' && order.provenance.of > 1) {
    return {
      kind: 'refused',
      reason:
        `the file's findings span ${order.provenance.of} sliced orders, and a file-scoped ` +
        'autofix cannot be verified one slice at a time; raise ' +
        'remediate.workOrders.maxSliceSize or leave this to the agent tier',
    };
  }
  const provider = getLanguage(pack as LanguageId)?.lintGate;
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
    return {
      kind: 'failed',
      step: 'verify-lint',
      output: tail(
        `${inFile.length} finding(s) remain in ${file} after the autofix ` +
          `(rules: ${rules.join(', ')}): not auto-fixable, or introduced by the fix; ` +
          'leaving the order to the agent tier',
      ),
    };
  }
  return { kind: 'applied', changedFiles: [file] };
}
