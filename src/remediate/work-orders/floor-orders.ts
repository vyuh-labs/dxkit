/**
 * Entry-floor orders: one `unresolved-import` order per manifest root the
 * importing files share (envelope = every importer + that root's manifest and
 * lockfile), and one `floor-failure` order per failing check with no finer
 * identity. Findings come pre-attributed from the one comparator
 * (`attributeFloorFailures`); this module never re-derives attribution.
 */
import { IMPORT_RESOLUTION_LABEL } from '../../analyzers/correctness/run';
import type { AttributedFloorFailure } from '../../analyzers/correctness/attribution';
import { FLOOR_FINDING_KIND, floorFindingId, type WorkOrderFinding } from './types';
import {
  VALUE_BAND,
  byteOrder,
  deriveBudget,
  doneFor,
  type BudgetCapFor,
  type Ranked,
} from './shared';

/** One failing floor check as the planner reads it: attribution already
 *  decided, the command as one string, the structured unresolved pairs when
 *  the check decomposes. Built by `gather.ts` from whichever floor source it
 *  used (live run, baseline envelope, loop snapshot). */
export interface FloorFailureInput {
  readonly pack: string;
  readonly label: string;
  readonly command: string;
  readonly output?: string;
  readonly attribution: AttributedFloorFailure['attribution'];
  readonly precision?: AttributedFloorFailure['precision'];
  readonly netNewFindings?: readonly string[];
  readonly unresolved?: readonly { readonly specifier: string; readonly file: string }[];
}

/** A dependency root: the manifest and lockfile an unresolved import's fix
 *  touches. `dir` is repo-relative (`''` for the root), files are relative. */
export interface ManifestRoot {
  readonly dir: string;
  readonly files: readonly string[];
}

export interface FloorOrderContext {
  readonly manifests: readonly ManifestRoot[];
  readonly install?: { readonly bin: string; readonly args: readonly string[] };
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

function manifestPaths(root: ManifestRoot): string[] {
  return root.files.map((f) => (root.dir ? `${root.dir}/${f}` : f));
}

const INSTALL_FORBIDDEN =
  'installing, adding, or removing packages yourself (the frame runs the install command)';

function unresolvedImportOrders(check: FloorFailureInput, ctx: FloorOrderContext): Ranked[] {
  const pairs = check.unresolved ?? [];
  const netNew = new Set(check.netNewFindings ?? []);
  // specifier -> every importer, then group specifiers by the manifest root
  // the importers share (a specifier imported from two roots is one finding
  // in the first root it is seen in; the fix declares it there).
  const importersOf = new Map<string, string[]>();
  for (const { specifier, file } of pairs) {
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
      attribution:
        check.precision === 'finding'
          ? netNew.has(specifier)
            ? 'net-new'
            : 'pre-existing'
          : check.attribution,
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
        constraints: {
          ...(ctx.install ? { install: ctx.install } : {}),
          forbidden: [INSTALL_FORBIDDEN],
        },
        done: doneFor('floor', findings),
        budget: deriveBudget(findings.length, ctx.capFor('unresolved-import')),
        ...(check.output !== undefined ? { outputTail: check.output } : {}),
        provenance: { source: 'entry-floor', check: `${check.pack}/${check.label}` },
      },
    });
  }
  return out;
}

export function floorOrders(
  failures: readonly FloorFailureInput[],
  ctx: FloorOrderContext,
): Ranked[] {
  const out: Ranked[] = [];
  for (const check of failures) {
    if (
      check.label === IMPORT_RESOLUTION_LABEL &&
      check.unresolved &&
      check.unresolved.length > 0
    ) {
      out.push(...unresolvedImportOrders(check, ctx));
      continue;
    }
    const finding: WorkOrderFinding = {
      kind: FLOOR_FINDING_KIND,
      id: floorFindingId(check.pack, check.label),
      attribution: check.attribution,
      evidence: { type: 'floor', pack: check.pack, label: check.label, command: check.command },
    };
    out.push({
      rank: [
        check.attribution === 'net-new' ? VALUE_BAND.netNewFloor : VALUE_BAND.preExistingFloor,
        `${check.pack}/${check.label}`,
      ],
      draft: {
        id: `floor-failure:${check.pack}:${check.label}`,
        class: 'floor-failure',
        findings: [finding],
        // A generic floor failure names no file; the whole tree minus
        // manifests is the honest envelope (a build/test fix is code).
        envelope: { paths: [''], manifests: false },
        constraints: {
          ...(ctx.install ? { install: ctx.install } : {}),
          forbidden: [INSTALL_FORBIDDEN],
        },
        done: doneFor('floor', [finding]),
        budget: deriveBudget(1, ctx.capFor('floor-failure')),
        ...(check.output !== undefined ? { outputTail: check.output } : {}),
        provenance: { source: 'entry-floor', check: `${check.pack}/${check.label}` },
      },
    });
  }
  return out;
}
