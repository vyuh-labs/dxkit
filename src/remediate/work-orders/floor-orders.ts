/**
 * Entry-floor orders: one `unresolved-import` order per manifest root the
 * importing files share (envelope = every importer + that root's manifest and
 * lockfile), and one `floor-failure` order per remaining failing check.
 * Findings come pre-attributed from the one comparator
 * (`attributeFloorFailures`); this module never re-derives attribution.
 *
 * Decomposition is keyed on the STRUCTURED data a check carries, never on a
 * label literal: `unresolved` pairs mint the unresolved-import class, and any
 * check with finding-level identities (`findings`, e.g. parsed test
 * failures) decomposes into per-finding attribution inside its floor-failure
 * order, so a grandfathered failure is never blamed on the agent.
 */
import type { AttributedFloorFailure } from '../../analyzers/correctness/attribution';
import { LOCKFILE_SYNC_LABEL } from '../../languages/capabilities/correctness';
import { FLOOR_FINDING_KIND, floorFindingId, type WorkOrderFinding } from './types';
import {
  INSTALL_FORBIDDEN,
  VALUE_BAND,
  byteOrder,
  deriveBudget,
  doneFor,
  manifestPaths,
  type BudgetCapFor,
  type InstallFor,
  type ManifestRoot,
  type Ranked,
} from './shared';

/** One failing floor check as the planner reads it: attribution already
 *  decided, the command as one string, structured per-finding data when the
 *  check decomposes. Built by `gather.ts` from whichever floor source it
 *  used (live run, baseline envelope, loop snapshot). */
export interface FloorFailureInput {
  readonly pack: string;
  readonly label: string;
  readonly command: string;
  readonly output?: string;
  readonly attribution: AttributedFloorFailure['attribution'];
  readonly precision?: AttributedFloorFailure['precision'];
  readonly netNewFindings?: readonly string[];
  /** Finding-level identities when the check decomposes (Rule 9's floor
   *  sibling: unresolved specifiers, parsed test-failure ids). */
  readonly findings?: readonly string[];
  readonly unresolved?: readonly { readonly specifier: string; readonly file: string }[];
}

export interface FloorOrderContext {
  readonly manifests: readonly ManifestRoot[];
  readonly installFor: InstallFor;
  readonly capFor: BudgetCapFor;
}

/** The dependency root whose directory is the longest prefix of `file`. */
function manifestRootFor(file: string, manifests: readonly ManifestRoot[]): ManifestRoot {
  let best: ManifestRoot = manifests.find((m) => m.dir === '') ?? { dir: '', files: [] };
  for (const m of manifests) {
    if (m.dir === '') continue;
    const prefix = m.dir.endsWith('/') ? m.dir : `${m.dir}/`;
    if (file.startsWith(prefix) && prefix.length > best.dir.length) best = m;
  }
  return best;
}

/** Per-finding attribution inside a decomposed check: net-new exactly when
 *  the comparator worked at finding precision and named it. */
function findingAttribution(
  check: FloorFailureInput,
  finding: string,
): WorkOrderFinding['attribution'] {
  if (check.precision !== 'finding') return check.attribution;
  return (check.netNewFindings ?? []).includes(finding) ? 'net-new' : 'pre-existing';
}

function unresolvedImportOrders(check: FloorFailureInput, ctx: FloorOrderContext): Ranked[] {
  // specifier -> every importer, then group specifiers by the manifest root
  // the importers share (a specifier imported from two roots is one finding
  // in the first root it is seen in; the fix declares it there).
  const importersOf = new Map<string, string[]>();
  for (const { specifier, file } of check.unresolved ?? []) {
    const list = importersOf.get(specifier) ?? [];
    if (!list.includes(file)) list.push(file);
    importersOf.set(specifier, list);
  }
  const byRoot = new Map<string, { root: ManifestRoot; findings: WorkOrderFinding[] }>();
  for (const [specifier, importers] of importersOf) {
    const root = manifestRootFor(importers[0], ctx.manifests);
    const bucket = byRoot.get(root.dir) ?? { root, findings: [] };
    bucket.findings.push({
      kind: FLOOR_FINDING_KIND,
      id: floorFindingId(check.pack, check.label, specifier),
      attribution: findingAttribution(check, specifier),
      evidence: {
        type: 'floor',
        pack: check.pack,
        label: check.label,
        command: check.command,
        specifier,
        importingFiles: [...importers].sort(byteOrder),
      },
    });
    byRoot.set(root.dir, bucket);
  }
  const out: Ranked[] = [];
  const install = ctx.installFor(check.pack);
  for (const { root, findings } of byRoot.values()) {
    const importers = [
      ...new Set(
        findings.flatMap((f) =>
          f.evidence.type === 'floor' ? (f.evidence.importingFiles ?? []) : [],
        ),
      ),
    ].sort(byteOrder);
    const anyNetNew = findings.some((f) => f.attribution === 'net-new');
    out.push({
      rank: [
        anyNetNew ? VALUE_BAND.netNewFloor : VALUE_BAND.preExistingFloor,
        `${check.pack}/${check.label}/${root.dir}`,
      ],
      draft: {
        id: `unresolved-import:${check.pack}:${root.dir || '.'}`,
        class: 'unresolved-import',
        findings,
        envelope: { paths: [...importers, ...manifestPaths(root)], manifests: true },
        constraints: { ...(install ? { install } : {}), forbidden: [INSTALL_FORBIDDEN] },
        done: doneFor('floor', findings),
        budget: deriveBudget(findings.length, ctx.capFor('unresolved-import')),
        ...(check.output !== undefined ? { outputTail: check.output } : {}),
        provenance: { source: 'entry-floor', check: floorFindingId(check.pack, check.label) },
      },
    });
  }
  return out;
}

/** A failing lockfile-sync check: the `stale-lockfile` class. The envelope
 *  is the owning dependency root's manifest + lockfile (the check runs at
 *  the repo root today, so that root owns it); the fix is a reinstall, so
 *  manifests may change and the lockfile-sync recipe serves it. */
function staleLockfileOrder(check: FloorFailureInput, ctx: FloorOrderContext): Ranked {
  const root = ctx.manifests.find((m) => m.dir === '') ?? { dir: '', files: [] };
  const finding: WorkOrderFinding = {
    kind: FLOOR_FINDING_KIND,
    id: floorFindingId(check.pack, check.label),
    attribution: check.attribution,
    evidence: { type: 'floor', pack: check.pack, label: check.label, command: check.command },
  };
  const install = ctx.installFor(check.pack);
  return {
    rank: [
      check.attribution === 'net-new' ? VALUE_BAND.netNewFloor : VALUE_BAND.preExistingFloor,
      `${check.pack}/${check.label}`,
    ],
    draft: {
      id: `stale-lockfile:${check.pack}`,
      class: 'stale-lockfile',
      findings: [finding],
      envelope: { paths: manifestPaths(root), manifests: true },
      constraints: { ...(install ? { install } : {}), forbidden: [INSTALL_FORBIDDEN] },
      done: doneFor('floor', [finding]),
      budget: deriveBudget(1, ctx.capFor('stale-lockfile')),
      ...(check.output !== undefined ? { outputTail: check.output } : {}),
      provenance: { source: 'entry-floor', check: floorFindingId(check.pack, check.label) },
    },
  };
}

export function floorOrders(
  failures: readonly FloorFailureInput[],
  ctx: FloorOrderContext,
): Ranked[] {
  const out: Ranked[] = [];
  for (const check of failures) {
    if (check.label === LOCKFILE_SYNC_LABEL) {
      out.push(staleLockfileOrder(check, ctx));
      continue;
    }
    if (check.unresolved && check.unresolved.length > 0) {
      out.push(...unresolvedImportOrders(check, ctx));
      continue;
    }
    // A check with finding-level identities decomposes into one finding per
    // identity (per-finding attribution); otherwise the check IS the finding.
    const findings: WorkOrderFinding[] =
      check.findings && check.findings.length > 0
        ? check.findings.map((f) => ({
            kind: FLOOR_FINDING_KIND,
            id: floorFindingId(check.pack, check.label, f),
            attribution: findingAttribution(check, f),
            evidence: {
              type: 'floor',
              pack: check.pack,
              label: check.label,
              command: check.command,
            },
          }))
        : [
            {
              kind: FLOOR_FINDING_KIND,
              id: floorFindingId(check.pack, check.label),
              attribution: check.attribution,
              evidence: {
                type: 'floor',
                pack: check.pack,
                label: check.label,
                command: check.command,
              },
            },
          ];
    const install = ctx.installFor(check.pack);
    const anyNetNew = findings.some((f) => f.attribution === 'net-new');
    out.push({
      rank: [
        anyNetNew ? VALUE_BAND.netNewFloor : VALUE_BAND.preExistingFloor,
        `${check.pack}/${check.label}`,
      ],
      draft: {
        id: `floor-failure:${check.pack}:${check.label}`,
        class: 'floor-failure',
        findings,
        // A generic floor failure names no file; the whole tree minus
        // manifests is the honest envelope (a build/test fix is code).
        envelope: { paths: [''], manifests: false },
        constraints: { ...(install ? { install } : {}), forbidden: [INSTALL_FORBIDDEN] },
        done: doneFor('floor', findings),
        budget: deriveBudget(findings.length, ctx.capFor('floor-failure')),
        ...(check.output !== undefined ? { outputTail: check.output } : {}),
        provenance: { source: 'entry-floor', check: floorFindingId(check.pack, check.label) },
      },
    });
  }
  return out;
}
