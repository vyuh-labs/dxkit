/**
 * Deletion protection for dxkit's anchor side branches — the PREVENT layer of
 * the deleted-anchor class (doctor DETECTS a missing anchor branch;
 * `baseline publish` / the refresh workflow SELF-HEAL it; this stops the
 * deletion from happening at all).
 *
 * The anchor side branches (`dxkit-baselines` on the `branch` baseline
 * transport, `dxkit-reports` for on-merge report snapshots) are deliberately
 * unprotected against pushes — the refresh force-pushes orphan commits by
 * design — but nothing should DELETE them: a deleted baseline anchor silently
 * strands the guardrail's committed baseline until the next refresh. A
 * repository ruleset with ONLY the `deletion` rule expresses exactly that:
 * pushes (including forced) stay allowed, deletion is blocked.
 *
 * Mirror of the enforcement module's shape (pure classifier + injectable
 * reads): `anchorRefsFromPolicy` resolves WHICH refs need protecting from the
 * same committed policy every other consumer reads (Rule 2);
 * `planAnchorRuleset` is a pure function from (refs, existing ruleset) to the
 * action to take — unit-testable without GitHub; the thin IO in
 * `setup-branch-protection.ts` executes the plan through an injectable
 * `gh` caller.
 */
import { loadPolicyFromCwd } from './baseline/policy';
import { DEFAULT_ANCHOR_REF } from './baseline/modes';
import { DEFAULT_REPORTS_REF } from './reports/snapshot';

/** Name of the dxkit-owned ruleset. The planner recognizes ONLY this ruleset
 *  as its own — it never edits a customer's rulesets. */
export const ANCHOR_RULESET_NAME = 'dxkit-anchor-branches';

/** Subset of GitHub's repository-ruleset shape that the planner touches. */
export interface RulesetDetail {
  readonly id?: number;
  readonly name: string;
  readonly target?: string;
  readonly enforcement?: string;
  readonly conditions?: {
    readonly ref_name?: { readonly include?: string[]; readonly exclude?: string[] };
  };
  readonly rules?: Array<{ readonly type: string }>;
}

export interface AnchorRulesetPlan {
  readonly action: 'none' | 'create' | 'update';
  /** Human-readable why (rendered in dry-run and no-op output). */
  readonly reason: string;
  /** Branch names (not fully-qualified refs) the plan protects. */
  readonly refs: readonly string[];
  /** Payload for POST (create) or PUT (update). */
  readonly payload?: RulesetDetail;
  /** Ruleset id to PUT to when action is 'update'. */
  readonly rulesetId?: number;
}

/**
 * Which side branches carry a dxkit anchor, per the committed policy — the
 * same sections the writers and readers resolve from, so protect/publish/read
 * can never disagree about which branches matter:
 *   - `baseline.anchor: 'branch'` → its `anchorRef` (default `dxkit-baselines`)
 *   - `reports.onMerge: true`     → its `anchorRef` (default `dxkit-reports`)
 */
export function anchorRefsFromPolicy(cwd: string): string[] {
  let policy;
  try {
    policy = loadPolicyFromCwd(cwd);
  } catch {
    return [];
  }
  const refs: string[] = [];
  if (policy.baseline?.anchor === 'branch') {
    refs.push(policy.baseline.anchorRef ?? DEFAULT_ANCHOR_REF);
  }
  if (policy.reports?.onMerge === true) {
    refs.push(policy.reports.anchorRef ?? DEFAULT_REPORTS_REF);
  }
  return [...new Set(refs)];
}

const qualify = (branch: string): string => `refs/heads/${branch}`;

/**
 * Pure planner: given the anchor branches to protect and dxkit's OWN existing
 * ruleset (null when absent), decide create / update / nothing.
 *
 * The ruleset carries ONLY the `deletion` rule — never `non_fast_forward`
 * (the baseline anchor is force-pushed orphan commits by design) and never
 * required checks (a gated side branch is the refresh deadlock the transport
 * exists to avoid). An update merges missing refs into the include list and
 * preserves everything else on the ruleset (non-clobber, same discipline as
 * the policy merge-writer).
 */
export function planAnchorRuleset(
  refs: readonly string[],
  existing: RulesetDetail | null,
): AnchorRulesetPlan {
  if (refs.length === 0) {
    return {
      action: 'none',
      reason:
        "no anchor side branches configured (baseline.anchor is not 'branch' and " +
        'reports.onMerge is off)',
      refs,
    };
  }
  const wanted = refs.map(qualify);

  if (!existing) {
    return {
      action: 'create',
      reason: `no '${ANCHOR_RULESET_NAME}' ruleset yet`,
      refs,
      payload: {
        name: ANCHOR_RULESET_NAME,
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: wanted, exclude: [] } },
        rules: [{ type: 'deletion' }],
      },
    };
  }

  const include = existing.conditions?.ref_name?.include ?? [];
  const missing = wanted.filter((r) => !include.includes(r));
  const hasDeletion = (existing.rules ?? []).some((r) => r.type === 'deletion');
  const active = existing.enforcement === 'active';
  if (missing.length === 0 && hasDeletion && active) {
    return {
      action: 'none',
      reason: `'${ANCHOR_RULESET_NAME}' already blocks deletion of ${refs.join(', ')}`,
      refs,
    };
  }

  // PUT body: the existing ruleset with the gaps filled, minus its `id` (the
  // id addresses the endpoint, not the payload).
  const rest: RulesetDetail & { id?: number } = { ...existing };
  delete rest.id;
  return {
    action: 'update',
    reason:
      missing.length > 0
        ? `'${ANCHOR_RULESET_NAME}' exists but does not cover ${missing.join(', ')}`
        : !hasDeletion
          ? `'${ANCHOR_RULESET_NAME}' exists but lost its deletion rule`
          : `'${ANCHOR_RULESET_NAME}' exists but is not active`,
    refs,
    ...(existing.id !== undefined ? { rulesetId: existing.id } : {}),
    payload: {
      ...rest,
      enforcement: 'active',
      conditions: {
        ...existing.conditions,
        ref_name: {
          include: [...include, ...missing],
          exclude: existing.conditions?.ref_name?.exclude ?? [],
        },
      },
      rules: hasDeletion ? existing.rules : [...(existing.rules ?? []), { type: 'deletion' }],
    },
  };
}
