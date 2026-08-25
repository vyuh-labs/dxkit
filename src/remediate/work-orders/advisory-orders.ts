/**
 * Dependency-advisory orders: ONE order per package, unioning the guardrail's
 * blocking advisories and the active deferred advisories that name it
 * (a package both blocking and deferred is one unit of work, never two ids
 * that dedupe one away). Envelope = the root manifest + lockfile only.
 */
import { SEVERITY_RANK } from '../../fail-on';
import type { FindingSeverity } from '../../baseline/types';
import type { DepAdvisoryEvidence, WorkOrderFinding } from './types';
import {
  VALUE_BAND,
  byteOrder,
  deriveBudget,
  doneFor,
  type BudgetCapFor,
  type Ranked,
} from './shared';
import type { ManifestRoot } from './floor-orders';

/** One advisory as the planner reads it: from the live scan (fixed version /
 *  reachability known) or the baseline entry (identity + severity only). */
export interface AdvisoryInput {
  readonly id: string;
  readonly package: string;
  readonly installedVersion?: string;
  readonly advisoryId: string;
  readonly severity?: FindingSeverity;
  readonly fixedVersion?: string;
  readonly reachable?: boolean;
}

export interface AdvisoryOrderContext {
  readonly manifests: readonly ManifestRoot[];
  readonly install?: { readonly bin: string; readonly args: readonly string[] };
  readonly capFor: BudgetCapFor;
}

const INSTALL_FORBIDDEN =
  'installing, adding, or removing packages yourself (the frame runs the install command)';

function toFinding(
  a: AdvisoryInput,
  attribution: WorkOrderFinding['attribution'],
  expiresAt?: string,
): WorkOrderFinding {
  const evidence: DepAdvisoryEvidence = {
    type: 'dep-vuln',
    package: a.package,
    ...(a.installedVersion !== undefined ? { installedVersion: a.installedVersion } : {}),
    advisoryId: a.advisoryId,
    ...(a.fixedVersion !== undefined ? { fixedVersion: a.fixedVersion } : {}),
    ...(a.reachable !== undefined ? { reachable: a.reachable } : {}),
    ...(a.severity !== undefined ? { severity: a.severity } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  return { kind: 'dep-vuln', id: a.id, attribution, evidence };
}

function reachableSevere(findings: readonly WorkOrderFinding[]): boolean {
  return findings.some(
    (f) =>
      f.evidence.type === 'dep-vuln' &&
      f.evidence.reachable === true &&
      f.evidence.severity !== undefined &&
      SEVERITY_RANK[f.evidence.severity] >= SEVERITY_RANK.high,
  );
}

/** Highest severity in the set as a sort key (lower first): the exported
 *  rank counts UP with severity, so it is negated here. */
function severityKey(findings: readonly WorkOrderFinding[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const f of findings) {
    if (f.evidence.type === 'dep-vuln' && f.evidence.severity !== undefined)
      best = Math.min(best, -SEVERITY_RANK[f.evidence.severity]);
  }
  return best;
}

export function advisoryOrders(
  blocking: readonly AdvisoryInput[],
  deferred: ReadonlyArray<{ readonly advisory: AdvisoryInput; readonly expiresAt: string }>,
  ctx: AdvisoryOrderContext,
): Ranked[] {
  const byPackage = new Map<
    string,
    { findings: WorkOrderFinding[]; blocking: number; deferred: number; earliest?: string }
  >();
  const bucket = (pkg: string) => {
    const b = byPackage.get(pkg) ?? { findings: [], blocking: 0, deferred: 0 };
    byPackage.set(pkg, b);
    return b;
  };
  for (const a of blocking) {
    const b = bucket(a.package);
    b.findings.push(toFinding(a, 'net-new'));
    b.blocking += 1;
  }
  for (const { advisory, expiresAt } of deferred) {
    const b = bucket(advisory.package);
    if (b.findings.some((f) => f.id === advisory.id)) continue; // blocking already carries it
    b.findings.push(toFinding(advisory, 'deferred', expiresAt));
    b.deferred += 1;
    if (b.earliest === undefined || expiresAt < b.earliest) b.earliest = expiresAt;
  }
  const root = ctx.manifests.find((m) => m.dir === '') ?? { dir: '', files: [] };
  const out: Ranked[] = [];
  for (const [pkg, b] of [...byPackage.entries()].sort(([x], [y]) => byteOrder(x, y))) {
    const findings = [...b.findings].sort((x, y) => byteOrder(x.id, y.id));
    const rank: Ranked['rank'] =
      b.earliest !== undefined
        ? [VALUE_BAND.expiringDeferral, b.earliest]
        : reachableSevere(findings)
          ? [VALUE_BAND.reachableSevere, severityKey(findings)]
          : [VALUE_BAND.otherBlocking, severityKey(findings)];
    out.push({
      rank,
      draft: {
        id: `dep-advisory:${pkg}`,
        class: 'dep-advisory',
        findings,
        envelope: {
          paths: root.files.map((f) => (root.dir ? `${root.dir}/${f}` : f)),
          manifests: true,
        },
        constraints: {
          ...(ctx.install ? { install: ctx.install } : {}),
          forbidden: [INSTALL_FORBIDDEN],
        },
        done: doneFor('guardrail', findings),
        budget: deriveBudget(findings.length, ctx.capFor('dep-advisory')),
        provenance: {
          source: 'advisories',
          blocking: b.blocking,
          deferred: b.deferred,
          ...(b.earliest !== undefined ? { earliestExpiry: b.earliest } : {}),
        },
      },
    });
  }
  return out;
}
