/**
 * Helpers the recipe executors share: the owning-manifest-root derivation
 * (from the order's own envelope, never a second discovery walk), the one
 * resync-install runner (the lock-writing install with its declared
 * fallback doctrine, executed through the injected bounded exec), the
 * strict npm-name and concrete-semver shapes the registry's `matches` and
 * the executors both read, and the ONE policy-driven block-tier filter for
 * the OSV pre-checks.
 */
import * as path from 'path';
import { tail, type CommandExec, type CommandOutcome } from '../../analyzers/tools/bounded-exec';
import { classifyOsvSeverity, type OsvVuln } from '../../analyzers/tools/osv';
import type { FindingSeverity } from '../../baseline/types';
import { detectLockfile } from '../../package-manager';
import { resyncInstallFor, type ResyncInstall } from '../../package-manager-lockfile';
import type { WorkOrder } from '../work-orders/types';
import type { RecipeOutcome } from './types';

/**
 * A strict npm package-name shape (name, or @scope/name): lowercase-biased
 * URL-safe characters, first character alphanumeric. Load-bearing for the
 * Rule 11 argument-injection discipline, not just hygiene: an unresolved
 * "specifier" is attacker-influencable text from source code, and a
 * leading-dash value handed to a package-manager argv is a flag (a
 * `--registry=...` import would redirect the install). Everything outside
 * this shape is refused before any argv is built.
 */
const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i;

export function isValidNpmPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_PACKAGE_NAME.test(name);
}

/** A CONCRETE semver (x.y.z with optional prerelease/build), never a range.
 *  A range-shaped "fixed version" (`>=4.1.0`) cannot be pinned verbatim, so
 *  orders carrying one tier to the agent instead of guessing. */
const CONCRETE_SEMVER =
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function isConcreteSemver(version: string): boolean {
  return CONCRETE_SEMVER.test(version);
}

/** Semver precedence for CONCRETE versions, prerelease rules included: a
 *  release outranks its prereleases (1.2.3 > 1.2.3-beta.1), prerelease
 *  identifiers compare numerically when numeric, bytewise otherwise, and a
 *  longer identifier list wins over its prefix (semver.org section 11). */
export function compareConcreteSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core] = v.split('+');
    const [nums, ...preParts] = core.split('-');
    return {
      nums: nums.split('.').map(Number),
      pre: preParts.length > 0 ? preParts.join('-').split('.') : null,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The pin an override-pin order applies: the highest CONCRETE version among
 *  the known fixed versions, or null when any is range-shaped (refuse, never
 *  guess a range's meaning). */
export function pickPinVersion(versions: readonly string[]): string | null {
  if (versions.length === 0 || !versions.every(isConcreteSemver)) return null;
  return versions.reduce((best, v) => (compareConcreteSemver(v, best) > 0 ? v : best));
}

/**
 * The ONE policy-driven block-tier filter for the recipes' OSV pre-checks
 * (Rule 2.30): which advisories on a candidate version REFUSE the recipe is
 * the same question the guardrail's new-advisory classifier answers, so the
 * tier comes from the same normalized policy set
 * (`newAdvisoryBlockSeverities`), never a re-derived high-or-critical
 * literal. `unknown` OSV severities pass (false-negative bias; the re-audit
 * and the guardrail stay the backstop).
 */
export function osvBlockTier(
  vulns: readonly OsvVuln[],
  blockSeverities: ReadonlySet<FindingSeverity>,
): OsvVuln[] {
  return vulns.filter((v) => {
    const s = classifyOsvSeverity(v);
    return s !== 'unknown' && blockSeverities.has(s);
  });
}

/** The one infrastructure-shaped triage of a bounded-exec outcome: null when
 *  the command ran to completion cleanly; a named `failed` otherwise. The
 *  resync runner and the declare-dependency install share it. */
export function execStepFailure(
  step: string,
  label: string,
  outcome: CommandOutcome,
): Extract<RecipeOutcome, { kind: 'failed' }> | null {
  if (!outcome.available) {
    return { kind: 'failed', step, output: `${label}: binary not available here` };
  }
  if (outcome.timedOut) return { kind: 'failed', step, output: `${label} timed out` };
  if (outcome.overflowed) {
    return { kind: 'failed', step, output: `${label} overflowed the capture buffer` };
  }
  if (outcome.code !== 0) {
    return { kind: 'failed', step, output: tail(`${label}: ${outcome.output || 'non-zero exit'}`) };
  }
  return null;
}

/**
 * The dependency root an order's fix belongs to, derived from the order's
 * OWN envelope (the planner already scoped it): the directory of the one
 * `package.json` the envelope names. Two roots in one envelope means the
 * planner could not decide (the all-roots fallback); the recipe refuses
 * rather than guess which manifest to edit.
 */
export function owningManifestRoot(order: WorkOrder): string | null {
  const dirs = new Set(
    order.envelope.paths
      .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
      .map((p) => (p === 'package.json' ? '' : p.slice(0, -'/package.json'.length))),
  );
  return dirs.size === 1 ? [...dirs][0] : null;
}

/** The node package manager owning `rootDir` (repo-relative; '' = repo
 *  root), from the lockfile actually present (the ONE detector). */
export function nodePmAt(cwd: string, rootDir: string): ReturnType<typeof detectLockfile> {
  return detectLockfile(path.join(cwd, rootDir));
}

/**
 * Run the lock-writing install at a root, honoring the declared fallback
 * doctrine (the PM table's `fallback.matches` names the one failure shape
 * the fallback answers, never a blanket retry). Returns null on success, or
 * a `failed` outcome naming the step. Infrastructure (missing binary,
 * timeout, capture overflow) is a failure of THIS recipe run, named; the
 * order simply stays open for the agent tier.
 */
export function runResyncInstall(
  plan: ResyncInstall,
  rootAbs: string,
  exec: CommandExec,
): Extract<RecipeOutcome, { kind: 'failed' }> | null {
  const attempt = (argv: readonly string[]) => {
    const [bin, ...args] = argv;
    return exec({ bin, args }, rootAbs);
  };
  const primary = attempt(plan.argv);
  const primaryFailure = execStepFailure('install', plan.argv.join(' '), primary);
  if (primaryFailure === null) return null;
  if (primary.available && !primary.timedOut && !primary.overflowed && plan.fallback) {
    // The declared fallback runs ONLY on the failure shape it answers
    // (`fallback.matches`, from the one PM table), never as a blanket retry.
    if (plan.fallback.matches(primary.output)) {
      const fb = attempt(plan.fallback.argv);
      if (execStepFailure('install', plan.fallback.argv.join(' '), fb) === null) return null;
      return {
        kind: 'failed',
        step: 'install',
        output: tail(
          `${primary.output}\n--- fallback (${plan.fallback.argv.join(' ')}) ---\n${fb.output}`,
        ),
      };
    }
  }
  return primaryFailure;
}

export { resyncInstallFor };
