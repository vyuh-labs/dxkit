/**
 * Normalize `.dxkit/policy.json` custom-check config into runner `CustomCheckSpec`s.
 *
 * Pure module. Validation is defensive: a malformed entry (missing name, empty
 * command) is DROPPED with the reason surfaced via `normalizeCustomChecks`'s
 * `warnings`, never crashing the gate — a typo in one check must not disable the
 * others or the whole guardrail.
 *
 * This is the single adapter from the user-authored JSON shape to the runner's
 * spec; the pack-declared lint adapter (`lintProvidersToSpecs`) lands alongside
 * the lint capability. Both feed the SAME runner.
 */

import type { CustomCheckConfig, LintPolicy, RecallPolicy } from '../../baseline/policy';
import type { LanguageSupport } from '../../languages/types';
import type {
  LintGateContext,
  LintGateRecallContext,
  RecallInputMode,
} from '../../languages/capabilities/lint-gate';
import { activeLintGateProviders } from '../../languages';
import type { CustomCheckCommand, CustomCheckParse, CustomCheckSpec } from './types';

/** The reserved prefix for pack-declared built-in lint checks. */
export const LINT_CHECK_PREFIX = 'lint:';

export interface NormalizeResult {
  readonly specs: readonly CustomCheckSpec[];
  /** Human-readable reasons entries were dropped (surfaced to the user so a
   *  silently-ignored check is visible). */
  readonly warnings: readonly string[];
}

/**
 * Convert the policy's `checks` array to runner specs. Invalid entries are
 * skipped with a warning. Order is preserved (deterministic run order).
 */
export function normalizeCustomChecks(
  configs: readonly CustomCheckConfig[] | undefined,
): NormalizeResult {
  if (!configs || configs.length === 0) return { specs: [], warnings: [] };
  const specs: CustomCheckSpec[] = [];
  const warnings: string[] = [];
  const seenNames = new Set<string>();

  for (const raw of configs) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      warnings.push('a check entry has no `name` and was skipped');
      continue;
    }
    if (name.startsWith(LINT_CHECK_PREFIX)) {
      warnings.push(
        `check '${name}' uses the reserved '${LINT_CHECK_PREFIX}' prefix and was skipped`,
      );
      continue;
    }
    if (seenNames.has(name)) {
      warnings.push(`duplicate check name '${name}' — only the first is used`);
      continue;
    }
    const command = parseCommand(raw.command);
    if (!command) {
      warnings.push(`check '${name}' has no runnable \`command\` and was skipped`);
      continue;
    }
    seenNames.add(name);
    specs.push({
      name,
      command,
      blocking: raw.blocking !== false, // default true
      expectedExit: typeof raw.expectedExit === 'number' ? raw.expectedExit : 0,
      parse: normalizeParse(raw.parse),
    });
  }
  return { specs, warnings };
}

function parseCommand(cmd: CustomCheckConfig['command'] | undefined): CustomCheckCommand | null {
  if (typeof cmd === 'string') {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    return { bin: parts[0], args: parts.slice(1) };
  }
  if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((x) => typeof x === 'string' && x.length)) {
    return { bin: cmd[0], args: cmd.slice(1) };
  }
  return null;
}

function normalizeParse(parse: CustomCheckConfig['parse'] | undefined): CustomCheckParse {
  if (parse === undefined || parse === 'exit') return { mode: 'exit' };
  if (typeof parse === 'object' && typeof parse.regex === 'string' && parse.regex.length > 0) {
    return { mode: 'regex', pattern: parse.regex };
  }
  return { mode: 'exit' };
}

/**
 * Build `lint:<pack>` runner specs from the active packs' lint-GATE providers
 * (Rule 6). Returns [] when lint gating is disabled (default) or no active pack
 * declares a gate-able linter. The union is pack-driven: a new pack that
 * declares `lintGate` is picked up here with no edit (proven by the recipe
 * playbook). A pack whose `lintCommand` returns null (dormant / not configured
 * in this repo) contributes nothing.
 */
export function lintGateSpecs(
  packs: readonly LanguageSupport[],
  ctx: LintGateContext,
  lint: LintPolicy | undefined,
  recall?: RecallPolicy,
): CustomCheckSpec[] {
  if (!lint?.enabled) return [];
  const blocking = lint.blocking === true; // default warn-only
  const mode: RecallInputMode = recall?.inputs === 'locked' ? 'locked' : 'resolved';
  const specs: CustomCheckSpec[] = [];
  for (const { id, provider } of activeLintGateProviders(packs)) {
    const cmd = provider.lintCommand(ctx);
    if (cmd === null) continue;
    specs.push({
      name: `${LINT_CHECK_PREFIX}${id}`,
      command: { bin: cmd.bin, args: cmd.args },
      blocking,
      expectedExit: typeof cmd.expectedExit === 'number' ? cmd.expectedExit : 0,
      parse:
        cmd.parse.kind === 'regex'
          ? { mode: 'regex', pattern: cmd.parse.pattern }
          : { mode: 'structured', label: cmd.parse.label, parse: cmd.parse.parse },
      // What determines what THIS linter sees, beyond its argv (Rule 19).
      // Resolved by the pack, because only the pack knows its ecosystem
      // (Rule 6). A pack that throws here must not take the gate down with it —
      // recall inputs make attribution SHARPER, and failing to resolve them is
      // a reason to attribute less confidently, not to stop linting. An empty
      // set degrades to command-only recall, which is the pre-Rule-19 behavior.
      recallInputs: safeRecallInputs(id, provider, { ...ctx, mode }),
    });
  }
  return specs;
}

function safeRecallInputs(
  id: string,
  provider: { recallInputs(ctx: LintGateRecallContext): Record<string, string> },
  ctx: LintGateRecallContext,
): Record<string, string> {
  try {
    return provider.recallInputs(ctx);
  } catch (err) {
    if (process.env.DXKIT_DEBUG === '1') {
      process.stderr.write(
        `    [lint-gate] pack '${id}' recallInputs threw: ${(err as Error)?.message ?? String(err)}\n`,
      );
    }
    return {};
  }
}
