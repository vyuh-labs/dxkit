/**
 * Custom-check → baseline-entry producer.
 *
 * Turns the failures the custom-check runner captured (user-declared checks +
 * built-in lint) into `custom-check` baseline entries, so a PRE-EXISTING check
 * failure is grandfathered and only a NET-NEW one gates. Identity comes from the
 * canonical `identityFor` (Rule 9): located findings hash (check, file,
 * lineWindow, rule); binary findings hash the check name.
 *
 * The findings are gathered ONCE by the orchestrator (into
 * `ProducerContext.customCheckFindings`) and passed here — this producer is a
 * pure map, never a shell-out.
 */

import { identityFor } from '../finding-identity';
import type { CustomCheckFinding } from '../../analyzers/custom-checks/types';
import type { RichBaselineEntry } from '../types';

export function customCheckFindingsToBaselineEntries(
  findings: readonly CustomCheckFinding[],
): RichBaselineEntry[] {
  return findings.map((f) => {
    const id = identityFor({
      kind: 'custom-check',
      check: f.check,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.rule !== undefined ? { rule: f.rule } : {}),
    });
    return {
      id,
      kind: 'custom-check' as const,
      check: f.check,
      blocking: f.blocking,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.rule !== undefined ? { rule: f.rule } : {}),
      ...(f.message !== undefined ? { message: f.message } : {}),
    };
  });
}
