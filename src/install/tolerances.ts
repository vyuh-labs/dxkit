/**
 * Which install tolerances THIS repo authorizes (the authorization half of
 * the install-strategy capability; the pack supplies the mechanism). One
 * resolver, three sources, in PRECEDENCE order, each disclosed:
 *
 *   1. `.dxkit/policy.json:dependencies.tolerate` (a list of policy-settable
 *      tolerance classes — the same list the policy schema's enum renders,
 *      `policyTolerances()`): the repo's EXPLICIT answer, which replaces the
 *      default set (`[]` turns the peer-conflict fallback off;
 *      `['peer-conflict']` keeps it) and OUTRANKS observed repo config — an
 *      explicit opt-out is a decision, and observed config overriding it
 *      would make the knob unable to say no. The conflict is disclosed.
 *   2. Observed repo config (only when policy says nothing): an `.npmrc`
 *      with `legacy-peer-deps=true` is the repo already declaring the
 *      peer-conflict tolerance to npm itself. Derived through the ONE probe
 *      (`npmrcDeclaresLegacyPeerDeps`, shared with doctor), never guessed.
 *   3. The class's declared default (`TOLERANCE_CLASSES[...].authorization`):
 *      `default-on` classes apply absent any declaration; `intrinsic`
 *      classes always apply (they are not a deviation of the tree and not a
 *      policy decision — one named in policy is reported in `unknown`).
 *
 * Entries the resolver cannot accept (a typo, an intrinsic class) land in
 * `unknown`; policy-vs-observed disagreements land in `conflicts`. Both are
 * DISCLOSURES with render homes (doctor, the remediate verification ledger)
 * — never silently dropped.
 */
import { npmrcDeclaresLegacyPeerDeps } from '../languages/node-install';
import { readPolicySection } from '../baseline/policy-text';
import {
  ALL_TOLERANCE_CLASSES,
  toleranceDoctrine,
  policyTolerances,
  type ToleranceClass,
} from '../languages/capabilities/install-strategy';

export type ToleranceSource = 'policy' | 'repo-config' | 'default';

export interface ResolvedTolerances {
  /** The authorized classes (intrinsic classes always present). */
  readonly tolerated: ReadonlySet<ToleranceClass>;
  /** Where each authorized class came from, for the disclosures. */
  readonly sources: ReadonlyMap<ToleranceClass, ToleranceSource>;
  /** `dependencies.tolerate` entries the resolver cannot accept (not a
   *  policy-settable class): disclosed, never silently dropped. */
  readonly unknown: readonly string[];
  /** Policy-vs-observed disagreements (an explicit opt-out over an .npmrc
   *  that declares the tolerance): the decision stands with policy, the
   *  disagreement is disclosed. */
  readonly conflicts: readonly string[];
}

/** The policy path the knob lives at (documented in the policy guide). */
export const TOLERATE_POLICY_PATH = 'dependencies.tolerate';

/** The repo-observed sources, per class: pure file reads under `cwd`,
 *  through the owning pack's ONE probe. A new class with an observable repo
 *  signal declares its probe (and its human name, for the conflict
 *  disclosure) here. */
const OBSERVED: Readonly<
  Partial<Record<ToleranceClass, { probe: (cwd: string) => boolean; what: string }>>
> = {
  'peer-conflict': { probe: npmrcDeclaresLegacyPeerDeps, what: '.npmrc legacy-peer-deps=true' },
};

/** Resolve the tolerances of the repo at `cwd` (the REPO ROOT: policy and
 *  observed config live there, so resolve ONCE and thread the result — a
 *  nested dependency root has no policy of its own). Pure file reads;
 *  total. */
export function resolveTolerances(cwd: string): ResolvedTolerances {
  const tolerated = new Set<ToleranceClass>();
  const sources = new Map<ToleranceClass, ToleranceSource>();
  const unknown: string[] = [];
  const conflicts: string[] = [];

  const settable = policyTolerances();
  const section = readPolicySection(cwd, 'dependencies');
  const declared = Array.isArray(section?.tolerate) ? (section.tolerate as unknown[]) : null;
  const policySet = new Set<ToleranceClass>();
  if (declared !== null) {
    for (const entry of declared) {
      // ONE accepted list, the same one the policy schema's enum renders: an
      // intrinsic class here is not a policy decision and reads as unknown,
      // with the disclosure naming it.
      if (typeof entry === 'string' && (settable as readonly string[]).includes(entry)) {
        policySet.add(entry as ToleranceClass);
      } else {
        unknown.push(String(entry));
      }
    }
  }

  for (const cls of ALL_TOLERANCE_CLASSES) {
    const doctrine = toleranceDoctrine(cls).authorization;
    if (doctrine === 'intrinsic') {
      tolerated.add(cls);
      sources.set(cls, 'default');
      continue;
    }
    const observed = OBSERVED[cls];
    const observedHit = observed !== undefined && observed.probe(cwd);
    if (declared !== null) {
      // Explicit policy is the decision; observed config disagreeing with an
      // explicit opt-out is disclosed, never silently overridden.
      if (policySet.has(cls)) {
        tolerated.add(cls);
        sources.set(cls, 'policy');
      } else if (observedHit) {
        conflicts.push(
          `${observed.what} declares the ${cls} tolerance, but ${TOLERATE_POLICY_PATH} omits ` +
            'it: the policy opt-out stands (dxkit installs will not retry), while the repo ' +
            'config still changes plain npm behavior; align the two',
        );
      }
      continue;
    }
    if (observedHit) {
      tolerated.add(cls);
      sources.set(cls, 'repo-config');
      continue;
    }
    if (doctrine === 'default-on') {
      tolerated.add(cls);
      sources.set(cls, 'default');
    }
  }
  return { tolerated, sources, unknown, conflicts };
}

/** The tolerance set for a caller that has no repo (a generic render, a
 *  unit test): the declared defaults. */
export function defaultResolvedTolerances(): ResolvedTolerances {
  const tolerated = new Set<ToleranceClass>();
  const sources = new Map<ToleranceClass, ToleranceSource>();
  for (const cls of ALL_TOLERANCE_CLASSES) {
    if (toleranceDoctrine(cls).authorization !== 'declared') {
      tolerated.add(cls);
      sources.set(cls, 'default');
    }
  }
  return { tolerated, sources, unknown: [], conflicts: [] };
}

/** The disclosure lines a surface should WARN with (unknown policy entries,
 *  policy-vs-observed conflicts); empty on the common clean resolution. */
export function toleranceWarnings(t: ResolvedTolerances): string[] {
  return [
    ...t.unknown.map(
      (entry) =>
        `${TOLERATE_POLICY_PATH} names '${entry}', which is not a policy-settable install ` +
        `tolerance (settable: ${policyTolerances().join(', ')}); the entry is ignored`,
    ),
    ...t.conflicts,
  ];
}

/** One-line disclosure of the resolved tolerances for a ledger. */
export function describeTolerances(t: ResolvedTolerances): string {
  const settable = policyTolerances();
  const parts = settable.map((cls) =>
    t.tolerated.has(cls) ? `${cls} (${t.sources.get(cls)})` : `${cls} (not tolerated)`,
  );
  const unknown =
    t.unknown.length > 0
      ? `; unknown ${TOLERATE_POLICY_PATH} entries ignored: ${t.unknown.join(', ')}`
      : '';
  const conflicts = t.conflicts.length > 0 ? `; ${t.conflicts.join('; ')}` : '';
  return `install tolerances: ${parts.join(', ')}${unknown}${conflicts}`;
}
