/**
 * Located lint orders (`lint-located`): one order per file. Blocking and
 * deferred custom-check findings arrive attributed; grandfathered debt is cut
 * by file, then by rule and line, into slices of at most `maxSliceSize`.
 * Binary (whole-command) custom-check findings carry no file to scope an
 * order to and are reported undispatchable with that reason.
 */
import type { RichBaselineEntry } from '../../baseline/types';
import type { UndispatchableGroup, WorkOrderFinding, WorkOrderProvenance } from './types';
import {
  VALUE_BAND,
  byteOrder,
  deriveBudget,
  doneFor,
  undispatch,
  type BudgetCapFor,
  type Draft,
  type Ranked,
} from './shared';

export type CustomCheckEntry = Extract<RichBaselineEntry, { kind: 'custom-check' }>;

export interface LintOrderContext {
  readonly maxSliceSize: number;
  readonly capFor: BudgetCapFor;
}

export function lintFinding(
  entry: CustomCheckEntry,
  attribution: WorkOrderFinding['attribution'],
): WorkOrderFinding {
  return {
    kind: 'custom-check',
    id: entry.id,
    attribution,
    evidence: {
      type: 'custom-check',
      check: entry.check,
      ...(entry.rule !== undefined ? { rule: entry.rule } : {}),
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
      ...(entry.message !== undefined ? { message: entry.message } : {}),
    },
  };
}

function lintDraft(
  file: string,
  findings: readonly WorkOrderFinding[],
  ctx: LintOrderContext,
  provenance: WorkOrderProvenance,
  idSuffix = '',
): Draft {
  return {
    id: `lint-located:${file}${idSuffix}`,
    class: 'lint-located',
    findings,
    envelope: { paths: [file], manifests: false },
    constraints: { forbidden: [] },
    done: doneFor('guardrail', findings),
    budget: deriveBudget(findings.length, ctx.capFor('lint-located')),
    provenance,
  };
}

/** Attributed (blocking / deferred) located findings: one order per file. */
export function attributedLintOrders(
  entries: ReadonlyArray<{
    readonly entry: CustomCheckEntry;
    readonly attribution: WorkOrderFinding['attribution'];
  }>,
  ctx: LintOrderContext,
  into: UndispatchableGroup[],
): Ranked[] {
  const byFile = new Map<string, WorkOrderFinding[]>();
  const binary: WorkOrderFinding[] = [];
  for (const { entry, attribution } of entries) {
    const f = lintFinding(entry, attribution);
    if (!entry.file) {
      binary.push(f);
      continue;
    }
    const list = byFile.get(entry.file) ?? [];
    list.push(f);
    byFile.set(entry.file, list);
  }
  undispatch(
    into,
    'binary (whole-command) custom-check findings carry no file to scope an order to',
    binary,
  );
  return [...byFile.entries()]
    .sort(([a], [b]) => byteOrder(a, b))
    .map(([file, findings]) => ({
      rank: [VALUE_BAND.otherBlocking, file],
      draft: lintDraft(file, findings, ctx, { source: 'guardrail-blocking' }),
    }));
}

/** Grandfathered debt: by file, then by rule and line, sliced. */
export function debtLintOrders(
  entries: readonly CustomCheckEntry[],
  ctx: LintOrderContext,
  into: UndispatchableGroup[],
): Ranked[] {
  const byFile = new Map<string, CustomCheckEntry[]>();
  const binary: WorkOrderFinding[] = [];
  for (const entry of entries) {
    if (!entry.file) {
      binary.push(lintFinding(entry, 'pre-existing'));
      continue;
    }
    const list = byFile.get(entry.file) ?? [];
    list.push(entry);
    byFile.set(entry.file, list);
  }
  undispatch(
    into,
    'binary (whole-command) custom-check findings carry no file to scope an order to',
    binary,
  );
  const max = Math.max(1, ctx.maxSliceSize);
  const out: Ranked[] = [];
  for (const [file, list] of [...byFile.entries()].sort(([a], [b]) => byteOrder(a, b))) {
    const sorted = [...list].sort(
      (a, b) => byteOrder(a.rule ?? '', b.rule ?? '') || (a.line ?? 0) - (b.line ?? 0),
    );
    const slices: CustomCheckEntry[][] = [];
    for (let i = 0; i < sorted.length; i += max) slices.push(sorted.slice(i, i + max));
    slices.forEach((slice, index) => {
      const findings = slice.map((e) => lintFinding(e, 'pre-existing'));
      out.push({
        rank: [VALUE_BAND.debt, `${file}#${index + 1}`],
        draft: lintDraft(
          file,
          findings,
          ctx,
          { source: 'debt-slice', file, slice: index + 1, of: slices.length },
          slices.length > 1 ? `#${index + 1}` : '',
        ),
      });
    });
  }
  return out;
}
