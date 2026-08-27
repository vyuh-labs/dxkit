/**
 * Which install tolerances THIS repo authorizes (the authorization half of
 * the install-strategy capability; the pack supplies the mechanism). One
 * resolver, three sources, each disclosed:
 *
 *   1. `.dxkit/policy.json:dependencies.tolerate` (a list of tolerance
 *      classes): the repo's declared answer, which REPLACES the default set
 *      for every policy-settable class (`[]` turns the peer-conflict fallback
 *      off; `['peer-conflict']` keeps it).
 *   2. Observed repo config: an `.npmrc` with `legacy-peer-deps=true` is the
 *      repo already declaring the peer-conflict tolerance to npm itself.
 *      Derived, never guessed; it authorizes the class even when policy
 *      omitted it, because the repo's own install runs that way.
 *   3. The class's declared default (`TOLERANCE_CLASSES[...].authorization`):
 *      `default-on` classes apply absent any declaration, `intrinsic` classes
 *      always apply (they are not a deviation of the tree), `declared`
 *      classes apply only through 1 or 2.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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
  /** `dependencies.tolerate` entries that name no known class: disclosed,
   *  never silently dropped. */
  readonly unknown: readonly string[];
}

/** The policy path the knob lives at (documented in the policy guide). */
export const TOLERATE_POLICY_PATH = 'dependencies.tolerate';

/** The repo-observed sources, per class: pure file reads under `cwd`. A new
 *  class with an observable repo signal declares its probe here. */
const OBSERVED: Readonly<Partial<Record<ToleranceClass, (cwd: string) => boolean>>> = {
  'peer-conflict': npmrcHasLegacyPeerDeps,
};

function npmrcHasLegacyPeerDeps(cwd: string): boolean {
  const npmrc = join(cwd, '.npmrc');
  if (!existsSync(npmrc)) return false;
  try {
    return readFileSync(npmrc, 'utf8')
      .split('\n')
      .some((l) => l.trim() === 'legacy-peer-deps=true');
  } catch {
    return false;
  }
}

/** Resolve the tolerances of the repo at `cwd`. Pure file reads; total. */
export function resolveTolerances(cwd: string): ResolvedTolerances {
  const tolerated = new Set<ToleranceClass>();
  const sources = new Map<ToleranceClass, ToleranceSource>();
  const unknown: string[] = [];

  const section = readPolicySection(cwd, 'dependencies');
  const declared = Array.isArray(section?.tolerate) ? (section.tolerate as unknown[]) : null;
  const policySet = new Set<ToleranceClass>();
  if (declared !== null) {
    for (const entry of declared) {
      if (
        typeof entry === 'string' &&
        (ALL_TOLERANCE_CLASSES as readonly string[]).includes(entry)
      ) {
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
    if (OBSERVED[cls]?.(cwd)) {
      tolerated.add(cls);
      sources.set(cls, 'repo-config');
      continue;
    }
    if (declared !== null) {
      if (policySet.has(cls)) {
        tolerated.add(cls);
        sources.set(cls, 'policy');
      }
      continue;
    }
    if (doctrine === 'default-on') {
      tolerated.add(cls);
      sources.set(cls, 'default');
    }
  }
  return { tolerated, sources, unknown };
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
  return { tolerated, sources, unknown: [] };
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
  return `install tolerances: ${parts.join(', ')}${unknown}`;
}
