/**
 * Dependency-advisory orders: ONE order per package, unioning the guardrail's
 * blocking advisories, the active deferred advisories, and the baselined
 * dep-vuln debt that name it (a package in two sources is one unit of work,
 * never two ids). An advisory both blocking and deferred keeps BOTH facts:
 * it blocks now (attribution net-new) and its expiry window still counts
 * toward the order's expiring rank.
 *
 * Envelope: the owning dependency root's manifests when every finding agrees
 * on one, else every discovered root's manifests (a nested-root advisory must
 * never get an envelope excluding the files its fix edits: the root-only
 * class CLAUDE.md records).
 */
import { SEVERITY_RANK } from '../../fail-on';
import type { FindingSeverity } from '../../baseline/types';
import type { DepAdvisoryEvidence, WorkOrderFinding } from './types';
import {
  INSTALL_FORBIDDEN,
  VALUE_BAND,
  allManifestPaths,
  byteOrder,
  deriveBudget,
  doneFor,
  manifestPaths,
  type BudgetCapFor,
  type InstallFor,
  type ManifestRoot,
  type Ranked,
} from './shared';

/** One advisory as the planner reads it: from the live scan (fixed version /
 *  reachability known) or a baseline entry (identity + severity only). */
export interface AdvisoryInput {
  readonly id: string;
  readonly package: string;
  readonly installedVersion?: string;
  readonly advisoryId: string;
  readonly severity?: FindingSeverity;
  readonly fixedVersion?: string;
  readonly reachable?: boolean;
  /** The producing language pack, when the source records it (live scan). */
  readonly pack?: string;
  /** The dependency root that owns the vulnerable lockfile, when the source
   *  records it. Absent -> the envelope falls back to every root. */
  readonly rootDir?: string;
}

export interface AdvisoryOrderContext {
  readonly manifests: readonly ManifestRoot[];
  readonly installFor: InstallFor;
  readonly capFor: BudgetCapFor;
}

interface Bucket {
  findings: Map<string, WorkOrderFinding>;
  blocking: number;
  deferred: number;
  earliest?: string;
  packs: Set<string>;
  rootDirs: Set<string>;
  rootUnknown: boolean;
}

function evidenceOf(a: AdvisoryInput, expiresAt?: string): DepAdvisoryEvidence {
  return {
    type: 'dep-vuln',
    package: a.package,
    ...(a.installedVersion !== undefined ? { installedVersion: a.installedVersion } : {}),
    advisoryId: a.advisoryId,
    ...(a.fixedVersion !== undefined ? { fixedVersion: a.fixedVersion } : {}),
    ...(a.reachable !== undefined ? { reachable: a.reachable } : {}),
    ...(a.severity !== undefined ? { severity: a.severity } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
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

/** Highest severity in the set as a sort key (lower sorts first): the
 *  exported rank counts UP with severity, so it is negated here. */
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
  debt: readonly AdvisoryInput[],
  ctx: AdvisoryOrderContext,
): Ranked[] {
  const byPackage = new Map<string, Bucket>();
  const bucket = (pkg: string): Bucket => {
    const b = byPackage.get(pkg) ?? {
      findings: new Map<string, WorkOrderFinding>(),
      blocking: 0,
      deferred: 0,
      packs: new Set<string>(),
      rootDirs: new Set<string>(),
      rootUnknown: false,
    };
    byPackage.set(pkg, b);
    return b;
  };
  const note = (b: Bucket, a: AdvisoryInput) => {
    if (a.pack !== undefined) b.packs.add(a.pack);
    if (a.rootDir !== undefined) b.rootDirs.add(a.rootDir);
    else b.rootUnknown = true;
  };
  for (const a of blocking) {
    const b = bucket(a.package);
    b.findings.set(a.id, {
      kind: 'dep-vuln',
      id: a.id,
      attribution: 'net-new',
      evidence: evidenceOf(a),
    });
    b.blocking += 1;
    note(b, a);
  }
  for (const { advisory: a, expiresAt } of deferred) {
    const b = bucket(a.package);
    b.deferred += 1;
    if (b.earliest === undefined || expiresAt < b.earliest) b.earliest = expiresAt;
    const existing = b.findings.get(a.id);
    if (existing) {
      // Both blocking and deferred: it blocks NOW (attribution stays
      // net-new) and the expiry window is recorded on the evidence.
      const evidence = { ...(existing.evidence as DepAdvisoryEvidence), expiresAt };
      b.findings.set(a.id, { ...existing, evidence });
    } else {
      b.findings.set(a.id, {
        kind: 'dep-vuln',
        id: a.id,
        attribution: 'deferred',
        evidence: evidenceOf(a, expiresAt),
      });
      note(b, a);
    }
  }
  for (const a of debt) {
    const b = bucket(a.package);
    if (b.findings.has(a.id)) continue; // a blocking/deferred copy is richer
    b.findings.set(a.id, {
      kind: 'dep-vuln',
      id: a.id,
      attribution: 'pre-existing',
      evidence: evidenceOf(a),
    });
    note(b, a);
  }

  const out: Ranked[] = [];
  for (const [pkg, b] of [...byPackage.entries()].sort(([x], [y]) => byteOrder(x, y))) {
    const findings = [...b.findings.values()].sort((x, y) => byteOrder(x.id, y.id));
    // Owning root: when every finding that knows its root agrees (and none
    // is unknown), scope the envelope to it; else every discovered root.
    const paths =
      !b.rootUnknown && b.rootDirs.size === 1
        ? manifestPaths(
            ctx.manifests.find((m) => m.dir === [...b.rootDirs][0]) ?? {
              dir: [...b.rootDirs][0],
              files: [],
            },
          )
        : allManifestPaths(ctx.manifests);
    const install = ctx.installFor(b.packs.size === 1 ? [...b.packs][0] : undefined);
    const rank: Ranked['rank'] =
      b.earliest !== undefined
        ? [VALUE_BAND.expiringDeferral, b.earliest]
        : b.blocking > 0
          ? reachableSevere(findings)
            ? [VALUE_BAND.reachableSevere, severityKey(findings)]
            : [VALUE_BAND.otherBlocking, severityKey(findings)]
          : [VALUE_BAND.debt, severityKey(findings)];
    out.push({
      rank,
      draft: {
        id: `dep-advisory:${pkg}`,
        class: 'dep-advisory',
        findings,
        envelope: { paths, manifests: true },
        constraints: { ...(install ? { install } : {}), forbidden: [INSTALL_FORBIDDEN] },
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
