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

import type { CustomCheckConfig } from '../../baseline/policy';
import type { CustomCheckCommand, CustomCheckParse, CustomCheckSpec } from './types';

export interface NormalizeResult {
  readonly specs: readonly CustomCheckSpec[];
  /** Human-readable reasons entries were dropped (surfaced to the user so a
   *  silently-ignored check is visible). */
  readonly warnings: readonly string[];
}

/** `lint:` is reserved for pack-declared built-in lint, so a user check can't
 *  collide with (or impersonate) a lint finding's identity namespace. */
const RESERVED_PREFIX = 'lint:';

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
    if (name.startsWith(RESERVED_PREFIX)) {
      warnings.push(`check '${name}' uses the reserved '${RESERVED_PREFIX}' prefix and was skipped`);
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
