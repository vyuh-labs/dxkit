/**
 * The work order: the ONE unit of remediation (remediate rethink, section 3A).
 *
 * A task is a goal ("fix lint"); a work order is a finite, verifiable,
 * product-scoped unit: the finding identities it must close (Rule 9), the
 * evidence dxkit already holds for each, the envelope the fix may touch, the
 * constraints the repo imposes, a done criterion the agent can run and the
 * frame re-runs, a budget derived from the finding set, and a tier decided by
 * the recipe registry. The planner (`planner.ts`) builds orders from the
 * finding sets dxkit already computes; the executors (recipes, the scoped
 * agent) consume them in later units.
 *
 * `WORK_ORDER_CLASSES` is the SPINE: each class declares where its findings
 * come from (its producers), which recipe serves it (or none), and which task
 * selects it. The task catalog's `selects` and the recipe registry's class
 * mapping are READS of this one table, so the three lists cannot drift.
 */
import type { FindingSeverity } from '../../baseline/types';
import { checkKey, type FloorAttribution } from '../../analyzers/correctness/attribution';

/** Where a class's findings are produced from. `pending` is a declared,
 *  reasoned absence (the `DEFERRED_KINDS` discipline), never a silent one. */
export type WorkOrderProducer =
  | 'entry-floor'
  | 'guardrail-blocking'
  | 'advisories'
  | 'debt-slice'
  | 'pending';

export interface WorkOrderClassDeclaration {
  readonly summary: string;
  /** Which source(s) mint findings of this class today. */
  readonly producers: readonly WorkOrderProducer[];
  /** Required when `producers` is `['pending']`: why there is no producer yet
   *  and what lands it. */
  readonly pendingReason?: string;
  /** The recipe id that serves this class, or null (agent only). */
  readonly recipe: string | null;
  /** The remediate task that selects this class. A string here so the type
   *  module stays a leaf; `tasks.ts` reads it through `classesSelectedBy`. */
  readonly task: string;
}

/** The built-in work-order classes: the one table the tasks, the recipes,
 *  and the planner's per-source builders read. */
export const WORK_ORDER_CLASSES = {
  'unresolved-import': {
    summary: 'an import specifier that does not resolve against the installed dependency tree',
    producers: ['entry-floor'],
    recipe: 'declare-dependency',
    task: 'fix-build',
  },
  'stale-lockfile': {
    summary: 'a dependency manifest whose lockfile no longer matches it',
    producers: ['pending'],
    pendingReason:
      'the lockfile-sync floor check (a correctness check with its own label) lands with the ' +
      'verify-tree-parity unit; until it is on the entry floor there is no structured signal ' +
      'to mint this class from, and guessing one from prose would be a lossy second producer',
    recipe: 'lockfile-sync',
    task: 'fix-build',
  },
  'dep-advisory': {
    summary: 'a vulnerable dependency, with every advisory that names it',
    producers: ['guardrail-blocking', 'advisories'],
    recipe: 'override-pin',
    task: 'fix-vulns',
  },
  'lint-located': {
    summary: 'located lint findings in one file',
    producers: ['guardrail-blocking', 'advisories', 'debt-slice'],
    recipe: 'lint-autofix',
    task: 'fix-lint',
  },
  'floor-failure': {
    summary: 'a failing correctness-floor check with no finer identity',
    producers: ['entry-floor'],
    recipe: null,
    task: 'fix-build',
  },
} as const satisfies Record<string, WorkOrderClassDeclaration>;

export type BuiltinWorkOrderClass = keyof typeof WORK_ORDER_CLASSES;

/** Open union: the built-ins plus any class a later unit registers. */
export type WorkOrderClass = BuiltinWorkOrderClass | (string & Record<never, never>);

export function isBuiltinWorkOrderClass(value: string): value is BuiltinWorkOrderClass {
  return Object.prototype.hasOwnProperty.call(WORK_ORDER_CLASSES, value);
}

/** The classes a task selects: a READ of the spine. */
export function classesSelectedBy(task: string): BuiltinWorkOrderClass[] {
  return (Object.keys(WORK_ORDER_CLASSES) as BuiltinWorkOrderClass[]).filter(
    (c) => WORK_ORDER_CLASSES[c].task === task,
  );
}

/** Evidence for a correctness-floor failure (the entry floor's own record). */
export interface FloorEvidence {
  readonly type: 'floor';
  readonly pack: string;
  readonly label: string;
  /** The failing command the agent re-runs to see the failure. */
  readonly command: string;
  /** For the import-resolution check: the unresolved specifier and every
   *  file the check saw importing it. */
  readonly specifier?: string;
  readonly importingFiles?: readonly string[];
}

/** Evidence for a dependency advisory (live scan first, baseline fallback). */
export interface DepAdvisoryEvidence {
  readonly type: 'dep-vuln';
  readonly package: string;
  readonly installedVersion?: string;
  readonly advisoryId: string;
  /** From the live scan when available; absent means "not known here". */
  readonly fixedVersion?: string;
  readonly reachable?: boolean;
  readonly severity?: FindingSeverity;
  /** Present for a deferred advisory: the day it re-blocks. */
  readonly expiresAt?: string;
}

/** Evidence for a custom-check (lint) finding. */
export interface CustomCheckEvidence {
  readonly type: 'custom-check';
  readonly check: string;
  readonly rule?: string;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
  /** Present for a deferred finding: the day it re-blocks. */
  readonly expiresAt?: string;
}

/** A finding dxkit holds only an identity for (an undispatchable entry of a
 *  kind with no class, an allowlist fingerprint with nothing to join). */
export interface NoEvidence {
  readonly type: 'none';
}

export type WorkOrderEvidence =
  | FloorEvidence
  | DepAdvisoryEvidence
  | CustomCheckEvidence
  | NoEvidence;

/** The floor vocabulary reused as-is (Rule 2: one attribution vocabulary);
 *  `deferred` names an allowlist-deferred finding inside its window. */
export type WorkOrderAttribution = FloorAttribution | 'deferred';

export interface WorkOrderFinding {
  /** A `BaselineEntry['kind']`, or `FLOOR_FINDING_KIND` for floor findings. */
  readonly kind: string;
  /** The durable identity (Rule 9), or a floor finding id (`floorFindingId`). */
  readonly id: string;
  readonly attribution: WorkOrderAttribution;
  readonly evidence: WorkOrderEvidence;
}

export const FLOOR_FINDING_KIND = 'floor-check' as const;

/** The one id formula for a floor finding: the canonical `checkKey` (the
 *  same key the floor snapshot and the attribution comparator join on),
 *  plus a `#finding` suffix where the check decomposes (an unresolved
 *  specifier, a parsed test-failure identity). */
export function floorFindingId(pack: string, label: string, finding?: string): string {
  const key = checkKey(pack, label);
  return finding === undefined ? key : `${key}#${finding}`;
}

/** What the fix may touch. Derived from the findings, never from the agent. */
export interface WorkOrderEnvelope {
  /** Repo-relative paths (files, or directory prefixes ending in `/`). */
  readonly paths: readonly string[];
  /** Whether dependency manifests + lockfiles inside `paths` may change. */
  readonly manifests: boolean;
}

export interface WorkOrderConstraints {
  /** The pack-declared install command, for the FRAME to run. Undefined when
   *  no active pack could name one: disclosed in the prompt, never guessed. */
  readonly install?: { readonly bin: string; readonly args: readonly string[] };
  /** Order-specific forbidden actions. The shared ground rules every agent
   *  prompt carries (`SHARED_RULES` in tasks.ts) are appended at render time,
   *  never restated here. */
  readonly forbidden: readonly string[];
}

/** The done criterion: the ids that must be ABSENT after the fix, checked by
 *  `verifier`, plus (always) "no net-new finding inside the envelope". */
export interface DoneCriterion {
  readonly absentIds: readonly string[];
  readonly verifier: 'floor' | 'guardrail';
  /** The command the agent runs (and the frame re-runs) to check. */
  readonly command: string;
}

export interface WorkOrderBudget {
  readonly turns: number;
  readonly minutes: number;
  readonly usd: number;
  /** The formula with its numbers, so every budget decision is disclosed. */
  readonly derivation: string;
}

export type WorkOrderTier = 'recipe' | 'agent';

export type WorkOrderProvenance =
  | { readonly source: 'entry-floor'; readonly check: string }
  | { readonly source: 'guardrail-blocking' }
  | {
      /** A per-package advisory order: how many of its findings came from
       *  the guardrail's blocking set and how many from active deferrals. */
      readonly source: 'advisories';
      readonly blocking: number;
      readonly deferred: number;
      readonly earliestExpiry?: string;
    }
  | {
      readonly source: 'debt-slice';
      readonly file: string;
      /** 1-based slice index and count when a unit was split by size. */
      readonly slice: number;
      readonly of: number;
      /** How many of the slice's findings were blocking / deferred (a file
       *  order unions every source; zero counts are omitted). */
      readonly blocking?: number;
      readonly deferred?: number;
    };

export interface WorkOrder {
  /** Stable within a plan: `<class>:<natural unit>[#slice]`. */
  readonly id: string;
  readonly class: WorkOrderClass;
  readonly findings: readonly WorkOrderFinding[];
  readonly envelope: WorkOrderEnvelope;
  readonly constraints: WorkOrderConstraints;
  readonly done: DoneCriterion;
  readonly budget: WorkOrderBudget;
  readonly tier: WorkOrderTier;
  /** The matching recipe id when `tier` is `recipe`. */
  readonly recipe?: string;
  /** The failing command's captured output tail, once per order (floor
   *  orders). Structured evidence lives on each finding. */
  readonly outputTail?: string;
  readonly provenance: WorkOrderProvenance;
}

/** A finding the planner could not place in any class, with the reason. */
export interface UndispatchableGroup {
  readonly reason: string;
  readonly findings: readonly WorkOrderFinding[];
}

export interface WorkOrderPlan {
  readonly orders: readonly WorkOrder[];
  readonly undispatchable: readonly UndispatchableGroup[];
}
