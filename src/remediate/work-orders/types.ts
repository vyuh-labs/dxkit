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
 * The class union is OPEN by design: the built-in classes are a registry
 * constant (one place), and a future unit may add a class without touching
 * every consumer. Consumers switch on the constant's keys, never on scattered
 * string literals.
 */
import type { FindingSeverity, IdentitySchemeVersion } from '../../baseline/types';
import type { FloorAttribution } from '../../analyzers/correctness/attribution';

/**
 * The built-in work-order classes. Each names a natural unit of repair with
 * its own envelope rule and (eventually) its own recipe.
 */
export const WORK_ORDER_CLASSES = {
  /** A bare import that does not resolve against the installed tree. */
  'unresolved-import': {
    summary: 'an import specifier that does not resolve against the installed dependency tree',
  },
  /** A manifest changed but the lockfile did not follow it. */
  'stale-lockfile': {
    summary: 'a dependency manifest whose lockfile no longer matches it',
  },
  /** A dependency advisory (all advisories of one package). */
  'dep-advisory': {
    summary: 'a vulnerable dependency, with every advisory that names it',
  },
  /** Located lint findings in one file. */
  'lint-located': {
    summary: 'located lint findings in one file',
  },
  /** A failing correctness-floor check with no finer identity. */
  'floor-failure': {
    summary: 'a failing correctness-floor check',
  },
} as const;

export type BuiltinWorkOrderClass = keyof typeof WORK_ORDER_CLASSES;

/** Open union: the built-ins plus any class a later unit registers. The
 *  intersection keeps autocomplete for the built-ins while admitting a
 *  registered extension class. */
export type WorkOrderClass = BuiltinWorkOrderClass | (string & Record<never, never>);

/** Is this one of the built-in classes (a type guard over the registry)? */
export function isBuiltinWorkOrderClass(value: string): value is BuiltinWorkOrderClass {
  return Object.prototype.hasOwnProperty.call(WORK_ORDER_CLASSES, value);
}

/** Evidence for a correctness-floor failure (the entry floor's own record). */
export interface FloorEvidence {
  readonly type: 'floor';
  readonly pack: string;
  readonly label: string;
  /** The failing command (bin + args) the agent re-runs to see the failure. */
  readonly command: string;
  /** Captured output tail (already bounded by the runner). */
  readonly outputTail?: string;
  /** For the import-resolution check: the unresolved specifier. */
  readonly specifier?: string;
  /** For the import-resolution check: the file that imports it, when the
   *  check's output named one. */
  readonly importingFile?: string;
}

/** Evidence for a dependency advisory (baseline entry + allowlist + scan). */
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
}

export type WorkOrderEvidence = FloorEvidence | DepAdvisoryEvidence | CustomCheckEvidence;

/**
 * Attribution of one finding relative to the developer / the run. The floor
 * vocabulary is reused as-is (Rule 2: one attribution vocabulary); `deferred`
 * names an allowlist-deferred finding inside its window, which is neither
 * net-new nor grandfathered debt: it re-blocks on a date.
 */
export type WorkOrderAttribution = FloorAttribution | 'deferred';

export interface WorkOrderFinding {
  /** The identity kind (a `BaselineEntry['kind']`, or a floor check's label
   *  namespace for floor findings, see `FLOOR_FINDING_KIND`). */
  readonly kind: string;
  /** The durable identity (Rule 9), or a floor finding id (`floorFindingId`). */
  readonly id: string;
  readonly attribution: WorkOrderAttribution;
  readonly evidence: WorkOrderEvidence;
}

/** Floor findings carry no baseline identity; they are keyed by check (and
 *  specifier where the check decomposes). This is the `kind` they carry. */
export const FLOOR_FINDING_KIND = 'floor-check' as const;

/** The one id formula for a floor finding: `pack/label` plus the finding-level
 *  identity where the check decomposes (the import-resolution specifier). */
export function floorFindingId(pack: string, label: string, finding?: string): string {
  return finding === undefined ? `${pack}/${label}` : `${pack}/${label}#${finding}`;
}

/** What the fix may touch. Derived from the findings, never from the agent. */
export interface WorkOrderEnvelope {
  /** Repo-relative paths (files or directory prefixes ending in `/`). */
  readonly paths: readonly string[];
  /** Whether dependency manifests + lockfiles inside `paths` may change. */
  readonly manifests: boolean;
}

export interface WorkOrderConstraints {
  /** The repo's own install command (pm-aware), for the frame to run; the
   *  agent is told to use exactly this and nothing else. */
  readonly install?: { readonly bin: string; readonly args: readonly string[] };
  /** Actions the order forbids, rendered verbatim into the prompt. */
  readonly forbidden: readonly string[];
}

/**
 * The done criterion: the ids that must be ABSENT after the fix, plus "no
 * net-new finding inside the envelope". Renderable as prose for the agent and
 * consumable as a structured check by the frame (same object, two readers).
 */
export interface DoneCriterion {
  readonly absentIds: readonly string[];
  /** The verifier that decides absence. */
  readonly verifier: 'floor' | 'guardrail';
  /** The command the agent runs (and the frame re-runs) to check. */
  readonly command: string;
  /** Always true today; declared so the frame's check is explicit. */
  readonly noNetNewInsideEnvelope: true;
  /** The identity scheme the ids were minted under (so a later scheme bump
   *  can migrate an in-flight order the same way a baseline is migrated). */
  readonly identityScheme: IdentitySchemeVersion;
}

export interface WorkOrderBudget {
  readonly turns: number;
  readonly minutes: number;
  readonly usd: number;
  /** The formula with its numbers, recorded so every budget decision is
   *  disclosed (the envelope discipline). */
  readonly derivation: string;
}

export type WorkOrderTier = 'recipe' | 'agent';

export type WorkOrderProvenance =
  | { readonly source: 'entry-floor'; readonly check: string }
  | { readonly source: 'guardrail-blocking' }
  | { readonly source: 'deferred-advisory'; readonly earliestExpiry: string }
  | {
      readonly source: 'debt-slice';
      readonly file?: string;
      /** 1-based slice index and count when a unit was split by size. */
      readonly slice: number;
      readonly of: number;
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
  /** Free-text evidence lines (the failing output, the advisory summary),
   *  rendered verbatim to the agent. */
  readonly evidence: readonly string[];
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
