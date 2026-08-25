/**
 * The ONE planner (`planWorkOrders`): builds work orders from the finding
 * sets dxkit already computes. PURE over injected inputs: no I/O, no clock
 * read, no registry probe beyond the recipe registry it is handed. The I/O
 * adapter that assembles its inputs from a repo is `gather.ts` (Rule 2.30:
 * one place assembles planner inputs).
 *
 * Sources, in value order (section 3A):
 *   1. entry-floor failures, attributed (net-new first);
 *   2. the guardrail's blocking pairs, joined to their current entries;
 *   3. active allowlist deferrals, joined to their baseline entries
 *      (soonest expiry first);
 *   4. debt slices: custom-check entries by file, then by rule, capped by
 *      `maxSliceSize`.
 *
 * Grouping: one order per (class, natural unit). Unresolved imports group by
 * the manifest their importing files share; advisories group by package;
 * lint groups by file; a floor failure with no finer identity is one order
 * per check. A finding with no class lands in `undispatchable` with the
 * reason, never silently dropped.
 */
import type { CorrectnessFloorResult } from '../../analyzers/correctness/run';
import { IMPORT_RESOLUTION_LABEL } from '../../analyzers/correctness/run';
import type { AttributedFloorFailure } from '../../analyzers/correctness/attribution';
import type { ClassifiedPair } from '../../gate/result';
import type { AllowlistEntry } from '../../allowlist/file';
import type { FindingSeverity, RichBaselineEntry } from '../../baseline/types';
import { CURRENT_IDENTITY_SCHEME } from '../../baseline/types';
import type { RemediateBudget } from '../config';
import { dxkitCli } from '../../self-invocation';
import { matchRecipe, RECIPE_REGISTRY, type RecipeDeclaration } from './recipes-registry';
import {
  FLOOR_FINDING_KIND,
  floorFindingId,
  type DoneCriterion,
  type UndispatchableGroup,
  type WorkOrder,
  type WorkOrderBudget,
  type WorkOrderClass,
  type WorkOrderEnvelope,
  type WorkOrderFinding,
  type WorkOrderPlan,
  type WorkOrderProvenance,
} from './types';

/** Live-scan details a baseline entry does not carry (fixed version,
 *  reachability), keyed by fingerprint. Optional: absent reads as unknown. */
export interface AdvisoryDetail {
  readonly fixedVersion?: string;
  readonly reachable?: boolean;
}

/** A dependency root: the manifest and lockfile an unresolved import's fix
 *  touches. `dir` is repo-relative (`''` for the root), files are relative. */
export interface ManifestRoot {
  readonly dir: string;
  readonly files: readonly string[];
}

export interface PlannerInput {
  /** The entry floor with its attribution (null when no floor ran). */
  readonly entryFloor: {
    readonly result: CorrectnessFloorResult;
    readonly attributed: readonly AttributedFloorFailure[];
  } | null;
  /** Blocking guardrail pairs joined by `currentId` to their entries. */
  readonly blocking: ReadonlyArray<{
    readonly pair: ClassifiedPair;
    readonly entry: RichBaselineEntry;
  }>;
  /** Active deferrals joined to their baseline entries (null = no entry). */
  readonly deferred: ReadonlyArray<{
    readonly allow: AllowlistEntry;
    readonly entry: RichBaselineEntry | null;
  }>;
  /** Grandfathered custom-check entries (the lint backlog). */
  readonly debt: readonly RichBaselineEntry[];
  readonly advisoryDetails?: Readonly<Record<string, AdvisoryDetail>>;
  /** Dependency roots for envelope derivation; the first is the repo root. */
  readonly manifests: readonly ManifestRoot[];
  readonly install?: { readonly bin: string; readonly args: readonly string[] };
  readonly policy: {
    /** Largest number of findings one debt slice may carry. */
    readonly maxSliceSize: number;
    /** The policy caps every derived budget clamps to. */
    readonly budget: RemediateBudget;
  };
}

export interface PlannerOptions {
  readonly registry?: readonly RecipeDeclaration[];
}

/** Budget derivation constants, declared once (section 3C):
 *  `turns = clamp(base + perFinding * n, min, policy.max)`, same shape for
 *  minutes; usd scales with the turn fraction of the policy cap. */
export const BUDGET_DERIVATION = {
  baseTurns: 8,
  perFindingTurns: 4,
  minTurns: 10,
  baseMinutes: 5,
  perFindingMinutes: 2,
  minMinutes: 5,
} as const;

export const DEFAULT_MAX_SLICE_SIZE = 25;

/** Actions every order forbids, in the agent's own vocabulary. */
const SHARED_FORBIDDEN: readonly string[] = [
  'installing, adding, or removing packages yourself (the frame runs the install command)',
  'editing anything outside the envelope',
  'refreshing the baseline or editing .dxkit/baselines/ or .dxkit/allowlist.json',
  'disabling a rule, adding a suppression, or weakening a test to make a finding disappear',
];

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveBudget(findingCount: number, policy: RemediateBudget): WorkOrderBudget {
  const d = BUDGET_DERIVATION;
  const turns = clamp(d.baseTurns + d.perFindingTurns * findingCount, d.minTurns, policy.maxTurns);
  const minutes = clamp(
    d.baseMinutes + d.perFindingMinutes * findingCount,
    d.minMinutes,
    policy.maxMinutes,
  );
  const usd = Math.round((policy.maxUsd * turns) / policy.maxTurns) || 1;
  return {
    turns,
    minutes,
    usd: Math.min(usd, policy.maxUsd),
    derivation:
      `turns = clamp(${d.baseTurns} + ${d.perFindingTurns} * ${findingCount}, ${d.minTurns}, ` +
      `${policy.maxTurns}) = ${turns}; minutes = clamp(${d.baseMinutes} + ${d.perFindingMinutes} * ` +
      `${findingCount}, ${d.minMinutes}, ${policy.maxMinutes}) = ${minutes}; ` +
      `usd = round(${policy.maxUsd} * ${turns} / ${policy.maxTurns}) = ${usd}`,
  };
}

/** The tier decision: `recipe` when a registry entry matches, else `agent`. */
export function assignTier(
  order: Omit<WorkOrder, 'tier' | 'recipe'>,
  registry: readonly RecipeDeclaration[] = RECIPE_REGISTRY,
): WorkOrder {
  const recipe = matchRecipe({ ...order, tier: 'agent' }, registry);
  return recipe ? { ...order, tier: 'recipe', recipe: recipe.id } : { ...order, tier: 'agent' };
}

function doneFor(
  verifier: DoneCriterion['verifier'],
  findings: readonly WorkOrderFinding[],
): DoneCriterion {
  return {
    absentIds: findings.map((f) => f.id),
    verifier,
    command: dxkitCli(verifier === 'floor' ? 'floor check' : 'guardrail check'),
    noNetNewInsideEnvelope: true,
    identityScheme: CURRENT_IDENTITY_SCHEME,
  };
}

/** The importing file the import-resolution check names in its output line
 *  for `specifier`. The check reports the file only in prose today; this is
 *  the ONE reader of that line shape. */
function importingFileFor(output: string | undefined, specifier: string): string | undefined {
  if (!output) return undefined;
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`'${escaped}' does not resolve[^\\n]*\\(imported by ([^)]+)\\)`).exec(
    output,
  );
  return m?.[1]?.trim();
}

/** The dependency root whose directory is the longest prefix of `file`. */
function manifestRootFor(
  file: string | undefined,
  manifests: readonly ManifestRoot[],
): ManifestRoot {
  const root = manifests[0] ?? { dir: '', files: [] };
  if (!file) return root;
  let best = root;
  for (const m of manifests) {
    if (m.dir === '') continue;
    const prefix = m.dir.endsWith('/') ? m.dir : `${m.dir}/`;
    if (file.startsWith(prefix) && prefix.length > (best.dir ? best.dir.length + 1 : 0)) best = m;
  }
  return best;
}

function manifestPaths(root: ManifestRoot): string[] {
  return root.files.map((f) => (root.dir ? `${root.dir}/${f}` : f));
}

function truncateTail(output: string | undefined, lines = 20): string | undefined {
  if (!output) return undefined;
  const all = output.split('\n');
  return all.length <= lines ? output : all.slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// Per-source builders. Each returns partial orders (everything but tier).

type Draft = Omit<WorkOrder, 'tier' | 'recipe'>;

interface Ranked {
  readonly draft: Draft;
  /** Lower sorts first. Band, then a within-band key. */
  readonly rank: readonly [number, number | string];
}

function floorOrders(input: PlannerInput): Ranked[] {
  const out: Ranked[] = [];
  if (!input.entryFloor) return out;
  for (const attributed of input.entryFloor.attributed) {
    const check = attributed.check;
    if (check.status !== 'fail') continue;
    const command = [check.bin, ...(check.args ?? [])].filter(Boolean).join(' ').trim();
    const tail = truncateTail(check.output);
    const band = attributed.attribution === 'net-new' ? 0 : 4;

    if (check.label === IMPORT_RESOLUTION_LABEL && check.findings && check.findings.length > 0) {
      const netNew = new Set(attributed.netNewFindings ?? []);
      // Group specifiers by the manifest root their importing files share.
      const byRoot = new Map<string, { root: ManifestRoot; findings: WorkOrderFinding[] }>();
      for (const specifier of check.findings) {
        const importingFile = importingFileFor(check.output, specifier);
        const root = manifestRootFor(importingFile, input.manifests);
        const key = root.dir;
        const bucket = byRoot.get(key) ?? { root, findings: [] };
        bucket.findings.push({
          kind: FLOOR_FINDING_KIND,
          id: floorFindingId(check.pack, check.label, specifier),
          attribution:
            attributed.precision === 'finding'
              ? netNew.has(specifier)
                ? 'net-new'
                : 'pre-existing'
              : attributed.attribution,
          evidence: {
            type: 'floor',
            pack: check.pack,
            label: check.label,
            command,
            ...(tail !== undefined ? { outputTail: tail } : {}),
            specifier,
            ...(importingFile !== undefined ? { importingFile } : {}),
          },
        });
        byRoot.set(key, bucket);
      }
      for (const { root, findings } of byRoot.values()) {
        const importers = [
          ...new Set(
            findings
              .map((f) => (f.evidence.type === 'floor' ? f.evidence.importingFile : undefined))
              .filter((f): f is string => typeof f === 'string'),
          ),
        ];
        const envelope: WorkOrderEnvelope = {
          paths: [...importers, ...manifestPaths(root)],
          manifests: true,
        };
        const anyNetNew = findings.some((f) => f.attribution === 'net-new');
        out.push({
          rank: [anyNetNew ? 0 : 4, `${check.pack}/${check.label}/${root.dir}`],
          draft: {
            id: `unresolved-import:${check.pack}:${root.dir || '.'}`,
            class: 'unresolved-import',
            findings,
            envelope,
            constraints: {
              ...(input.install ? { install: input.install } : {}),
              forbidden: SHARED_FORBIDDEN,
            },
            done: doneFor('floor', findings),
            budget: deriveBudget(findings.length, input.policy.budget),
            evidence: tail ? [tail] : [],
            provenance: { source: 'entry-floor', check: `${check.pack}/${check.label}` },
          },
        });
      }
      continue;
    }

    const finding: WorkOrderFinding = {
      kind: FLOOR_FINDING_KIND,
      id: floorFindingId(check.pack, check.label),
      attribution: attributed.attribution,
      evidence: {
        type: 'floor',
        pack: check.pack,
        label: check.label,
        command,
        ...(tail !== undefined ? { outputTail: tail } : {}),
      },
    };
    out.push({
      rank: [band, `${check.pack}/${check.label}`],
      draft: {
        id: `floor-failure:${check.pack}:${check.label}`,
        class: 'floor-failure',
        findings: [finding],
        // A generic floor failure names no file; the whole tree minus
        // manifests is the honest envelope (a build/test fix is code).
        envelope: { paths: [''], manifests: false },
        constraints: {
          ...(input.install ? { install: input.install } : {}),
          forbidden: SHARED_FORBIDDEN,
        },
        done: doneFor('floor', [finding]),
        budget: deriveBudget(1, input.policy.budget),
        evidence: tail ? [tail] : [],
        provenance: { source: 'entry-floor', check: `${check.pack}/${check.label}` },
      },
    });
  }
  return out;
}

function advisoryFinding(
  entry: Extract<RichBaselineEntry, { kind: 'dep-vuln' }>,
  attribution: WorkOrderFinding['attribution'],
  detail: AdvisoryDetail | undefined,
  expiresAt: string | undefined,
): WorkOrderFinding {
  return {
    kind: 'dep-vuln',
    id: entry.id,
    attribution,
    evidence: {
      type: 'dep-vuln',
      package: entry.package,
      ...(entry.installedVersion !== undefined ? { installedVersion: entry.installedVersion } : {}),
      advisoryId: entry.advisoryId,
      ...(detail?.fixedVersion !== undefined ? { fixedVersion: detail.fixedVersion } : {}),
      ...(detail?.reachable !== undefined ? { reachable: detail.reachable } : {}),
      ...(entry.severity !== undefined ? { severity: entry.severity } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  };
}

function advisoryOrder(
  pkg: string,
  findings: readonly WorkOrderFinding[],
  input: PlannerInput,
  provenance: WorkOrderProvenance,
): Draft {
  const root = input.manifests[0] ?? { dir: '', files: [] };
  return {
    id: `dep-advisory:${pkg}`,
    class: 'dep-advisory',
    findings,
    envelope: { paths: manifestPaths(root), manifests: true },
    constraints: {
      ...(input.install ? { install: input.install } : {}),
      forbidden: SHARED_FORBIDDEN,
    },
    done: doneFor('guardrail', findings),
    budget: deriveBudget(findings.length, input.policy.budget),
    evidence: findings.map((f) => {
      const e = f.evidence as Extract<WorkOrderFinding['evidence'], { type: 'dep-vuln' }>;
      return (
        `${e.package}${e.installedVersion ? `@${e.installedVersion}` : ''}: ${e.advisoryId}` +
        (e.severity ? ` (${e.severity})` : '') +
        (e.fixedVersion ? `, fixed in ${e.fixedVersion}` : ', no fixed version known here') +
        (e.reachable === true ? ', reachable' : '') +
        (e.expiresAt ? `, deferred until ${e.expiresAt}` : '')
      );
    }),
    provenance,
  };
}

function lintFinding(
  entry: Extract<RichBaselineEntry, { kind: 'custom-check' }>,
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

function lintOrder(
  file: string,
  findings: readonly WorkOrderFinding[],
  input: PlannerInput,
  provenance: WorkOrderProvenance,
  idSuffix = '',
): Draft {
  return {
    id: `lint-located:${file}${idSuffix}`,
    class: 'lint-located',
    findings,
    envelope: { paths: [file], manifests: false },
    constraints: { forbidden: SHARED_FORBIDDEN },
    done: doneFor('guardrail', findings),
    budget: deriveBudget(findings.length, input.policy.budget),
    evidence: findings.map((f) => {
      const e = f.evidence as Extract<WorkOrderFinding['evidence'], { type: 'custom-check' }>;
      return `${e.file}${e.line !== undefined ? `:${e.line}` : ''} ${e.rule ?? e.check}${e.message ? `: ${e.message}` : ''}`;
    }),
    provenance,
  };
}

function reachableSevere(findings: readonly WorkOrderFinding[]): boolean {
  return findings.some(
    (f) =>
      f.evidence.type === 'dep-vuln' &&
      f.evidence.reachable === true &&
      (f.evidence.severity === 'critical' || f.evidence.severity === 'high'),
  );
}

function bestSeverity(findings: readonly WorkOrderFinding[]): number {
  let best = 9;
  for (const f of findings) {
    if (f.evidence.type === 'dep-vuln' && f.evidence.severity)
      best = Math.min(best, SEVERITY_RANK[f.evidence.severity]);
  }
  return best;
}

function blockingOrders(input: PlannerInput, undispatchable: UndispatchableGroup[]): Ranked[] {
  const out: Ranked[] = [];
  const byPackage = new Map<string, WorkOrderFinding[]>();
  const byFile = new Map<string, WorkOrderFinding[]>();
  const noClass: WorkOrderFinding[] = [];
  for (const { entry } of input.blocking) {
    if (entry.kind === 'dep-vuln') {
      const list = byPackage.get(entry.package) ?? [];
      list.push(advisoryFinding(entry, 'net-new', input.advisoryDetails?.[entry.id], undefined));
      byPackage.set(entry.package, list);
    } else if (entry.kind === 'custom-check' && entry.file) {
      const list = byFile.get(entry.file) ?? [];
      list.push(lintFinding(entry, 'net-new'));
      byFile.set(entry.file, list);
    } else {
      noClass.push({
        kind: entry.kind,
        id: entry.id,
        attribution: 'net-new',
        evidence:
          entry.kind === 'custom-check'
            ? lintFinding(entry, 'net-new').evidence
            : { type: 'custom-check', check: entry.kind },
      });
    }
  }
  for (const [pkg, findings] of byPackage) {
    const draft = advisoryOrder(pkg, findings, input, { source: 'guardrail-blocking' });
    out.push({ draft, rank: [reachableSevere(findings) ? 2 : 3, bestSeverity(findings)] });
  }
  for (const [file, findings] of byFile) {
    out.push({
      draft: lintOrder(file, findings, input, { source: 'guardrail-blocking' }),
      rank: [3, file],
    });
  }
  if (noClass.length > 0) {
    undispatchable.push({
      reason:
        'blocking findings whose kind has no work-order class yet ' +
        `(${[...new Set(noClass.map((f) => f.kind))].join(', ')})`,
      findings: noClass,
    });
  }
  return out;
}

function deferredOrders(input: PlannerInput, undispatchable: UndispatchableGroup[]): Ranked[] {
  const out: Ranked[] = [];
  const byPackage = new Map<string, { findings: WorkOrderFinding[]; earliest: string }>();
  const unjoined: WorkOrderFinding[] = [];
  const noClass: WorkOrderFinding[] = [];
  for (const { allow, entry } of input.deferred) {
    const expiresAt = allow.expiresAt ?? '';
    if (!entry) {
      unjoined.push({
        kind: allow.kind,
        id: allow.fingerprint,
        attribution: 'deferred',
        evidence: { type: 'custom-check', check: allow.kind },
      });
      continue;
    }
    if (entry.kind !== 'dep-vuln') {
      noClass.push({
        kind: entry.kind,
        id: entry.id,
        attribution: 'deferred',
        evidence: { type: 'custom-check', check: entry.kind },
      });
      continue;
    }
    const bucket = byPackage.get(entry.package) ?? { findings: [], earliest: expiresAt };
    bucket.findings.push(
      advisoryFinding(entry, 'deferred', input.advisoryDetails?.[entry.id], expiresAt),
    );
    if (expiresAt < bucket.earliest) bucket.earliest = expiresAt;
    byPackage.set(entry.package, bucket);
  }
  for (const [pkg, { findings, earliest }] of byPackage) {
    out.push({
      draft: advisoryOrder(pkg, findings, input, {
        source: 'deferred-advisory',
        earliestExpiry: earliest,
      }),
      rank: [1, earliest],
    });
  }
  if (unjoined.length > 0) {
    undispatchable.push({
      reason:
        'deferred allowlist entries whose fingerprint is not in the baseline (nothing to join)',
      findings: unjoined,
    });
  }
  if (noClass.length > 0) {
    undispatchable.push({
      reason: `deferred findings whose kind has no work-order class yet (${[...new Set(noClass.map((f) => f.kind))].join(', ')})`,
      findings: noClass,
    });
  }
  return out;
}

function debtOrders(input: PlannerInput, undispatchable: UndispatchableGroup[]): Ranked[] {
  const out: Ranked[] = [];
  const byFile = new Map<string, Extract<RichBaselineEntry, { kind: 'custom-check' }>[]>();
  const binary: WorkOrderFinding[] = [];
  const otherKinds: WorkOrderFinding[] = [];
  for (const entry of input.debt) {
    if (entry.kind !== 'custom-check') {
      otherKinds.push({
        kind: entry.kind,
        id: entry.id,
        attribution: 'pre-existing',
        evidence: { type: 'custom-check', check: entry.kind },
      });
      continue;
    }
    if (!entry.file) {
      binary.push(lintFinding(entry, 'pre-existing'));
      continue;
    }
    const list = byFile.get(entry.file) ?? [];
    list.push(entry);
    byFile.set(entry.file, list);
  }
  const max = Math.max(1, input.policy.maxSliceSize);
  for (const [file, entries] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Within a file, order by rule then line so a slice is one rule's worth
    // of work wherever possible.
    const sorted = [...entries].sort(
      (a, b) => (a.rule ?? '').localeCompare(b.rule ?? '') || (a.line ?? 0) - (b.line ?? 0),
    );
    const slices: (typeof sorted)[] = [];
    for (let i = 0; i < sorted.length; i += max) slices.push(sorted.slice(i, i + max));
    slices.forEach((slice, index) => {
      const findings = slice.map((e) => lintFinding(e, 'pre-existing'));
      out.push({
        draft: lintOrder(
          file,
          findings,
          input,
          { source: 'debt-slice', file, slice: index + 1, of: slices.length },
          slices.length > 1 ? `#${index + 1}` : '',
        ),
        rank: [5, `${file}#${index + 1}`],
      });
    });
  }
  if (binary.length > 0) {
    undispatchable.push({
      reason: 'binary (whole-command) custom-check findings carry no file to scope an order to',
      findings: binary,
    });
  }
  if (otherKinds.length > 0) {
    undispatchable.push({
      reason: `debt entries whose kind has no work-order class yet (${[...new Set(otherKinds.map((f) => f.kind))].join(', ')})`,
      findings: otherKinds,
    });
  }
  return out;
}

function compareRank(a: Ranked, b: Ranked): number {
  if (a.rank[0] !== b.rank[0]) return a.rank[0] - b.rank[0];
  const x = a.rank[1];
  const y = b.rank[1];
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y));
}

/** Build the plan. Pure; deterministic for the same input. */
export function planWorkOrders(input: PlannerInput, opts: PlannerOptions = {}): WorkOrderPlan {
  const registry = opts.registry ?? RECIPE_REGISTRY;
  const undispatchable: UndispatchableGroup[] = [];
  const ranked = [
    ...floorOrders(input),
    ...blockingOrders(input, undispatchable),
    ...deferredOrders(input, undispatchable),
    ...debtOrders(input, undispatchable),
  ].sort(compareRank);
  // One order per id: a package both blocking and deferred keeps the
  // higher-value (earlier) one.
  const seen = new Set<string>();
  const orders: WorkOrder[] = [];
  for (const { draft } of ranked) {
    if (seen.has(draft.id)) continue;
    seen.add(draft.id);
    orders.push(assignTier(draft, registry));
  }
  return { orders, undispatchable };
}

/** The orders a task selects, by class. Open-ended tasks select nothing. */
export function selectOrders(plan: WorkOrderPlan, classes: readonly WorkOrderClass[]): WorkOrder[] {
  const wanted = new Set<string>(classes);
  return plan.orders.filter((o) => wanted.has(o.class));
}
