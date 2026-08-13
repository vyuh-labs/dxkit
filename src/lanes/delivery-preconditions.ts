/**
 * The ONE delivery-preconditions prober (#286 / #287, 4.4.1 WP5).
 *
 * A repo's org configuration can make lane DELIVERY structurally
 * impossible while every agent-side step works: a branch-creation
 * ruleset whose exclusion covers `dxkit-**` (the hyphen artifact
 * branches) but not `dxkit/**` (the lanes' standing branches) 403s
 * every landing — observed live, where each of two stacked blockers
 * cost a full paid agent run plus an autopsy, though both were knowable
 * from three API reads before any agent existed.
 *
 * One module probes; many consumers read (Rule 2):
 *   - the LANE PREFLIGHT (remediate + dep-bump, land=pr): a
 *     refusal-shaped answer becomes a disclosed refusal BEFORE any
 *     spend, naming the ruleset and the remedy — Rule 20's
 *     skipped-environment discipline applied to the deliver layer;
 *   - `doctor`: a red "lanes cannot deliver here" finding at
 *     onboarding, day one;
 *   - `remediate plan` / `deps bump` plan surfaces: a per-branch
 *     delivery line.
 *
 * Fail-open discipline throughout: an unanswerable probe (no gh, API
 * error, insufficient scope) is `unknown` — disclosed as "could not
 * verify", and the caller PROCEEDS. The preflight must never invent a
 * refusal; only positive refusal evidence (an active `creation` rule on
 * a branch the lane must create) blocks before spend.
 */

import { execFileSync } from 'child_process';
import { DEP_BUMP_BRANCH, remediateBranchFor } from './branches';
import { REMEDIATE_TASKS } from '../remediate/tasks';

export type DeliveryVerdict = 'ok' | 'blocked' | 'restricted-paths' | 'unknown';

export interface BranchDeliveryProbe {
  readonly branch: string;
  readonly verdict: DeliveryVerdict;
  /** What the API said (rule types), or why the probe could not answer. */
  readonly evidence: string;
  /** Present on a refusal: the concrete config change that unblocks. */
  readonly remedy?: string;
}

export interface DeliveryPreconditions {
  readonly probes: readonly BranchDeliveryProbe[];
  /** True iff at least one standing branch has POSITIVE refusal evidence. */
  readonly anyBlocked: boolean;
  /** True iff nothing could be verified at all (no gh / API unreachable). */
  readonly unverifiable: boolean;
}

/** The standing branch names the lanes deliver on — derived from the same
 *  canonical constants the landers use, never a second list. */
export function standingLaneBranches(): string[] {
  return [...REMEDIATE_TASKS.map((t) => remediateBranchFor(t.id)), DEP_BUMP_BRANCH];
}

export type ApiProbe = (path: string) => string | null;

/** Real probe via the gh CLI (the ambient token). Null = unanswerable. */
export function makeGhApiProbe(cwd: string): ApiProbe {
  return (apiPath) => {
    try {
      return execFileSync('gh', ['api', apiPath], {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }
  };
}

/** `owner/repo` for the checkout, or null (not GitHub / no gh). */
export function repoSlug(cwd: string): string | null {
  try {
    const out = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const slug = (JSON.parse(out) as { nameWithOwner?: string }).nameWithOwner;
    return typeof slug === 'string' && slug.includes('/') ? slug : null;
  } catch {
    return null;
  }
}

/**
 * Probe one branch name against the repo's effective rules
 * (`GET /repos/{slug}/rules/branches/{branch}` — rulesets evaluate by
 * name pattern, so a branch that does not exist yet still answers).
 */
export function probeBranchDelivery(
  probe: ApiProbe,
  slug: string,
  branch: string,
): BranchDeliveryProbe {
  const raw = probe(`repos/${slug}/rules/branches/${encodeURIComponent(branch)}`);
  if (raw === null) {
    return {
      branch,
      verdict: 'unknown',
      evidence: 'could not verify: the branch-rules API was unreachable with the ambient token',
    };
  }
  let rules: Array<{ type?: string }> = [];
  try {
    rules = JSON.parse(raw) as Array<{ type?: string }>;
  } catch {
    return { branch, verdict: 'unknown', evidence: 'could not verify: unparseable rules payload' };
  }
  const types = rules.map((r) => r.type).filter((t): t is string => typeof t === 'string');
  // Positive refusal evidence: an active `creation` rule on a branch the
  // lane must CREATE means the push 403s (the live class). The bypass list
  // is not visible from this endpoint, so the remedy names both outs.
  if (types.includes('creation')) {
    return {
      branch,
      verdict: 'blocked',
      evidence: `an active branch-creation ruleset covers "${branch}" (rules: ${types.join(', ')})`,
      remedy:
        `exclude the lane branches from the ruleset (add "refs/heads/dxkit/**" to its ` +
        `exclusion patterns) or grant the delivering identity a ruleset bypass`,
    };
  }
  if (types.includes('file_path_restriction')) {
    return {
      branch,
      verdict: 'restricted-paths',
      evidence:
        `a file-path-restriction rule applies to "${branch}" — a landing touching the ` +
        `restricted paths will be refused (rules: ${types.join(', ')})`,
      remedy: 'keep lane tasks away from the restricted paths, or exclude the lane branches',
    };
  }
  return {
    branch,
    verdict: 'ok',
    evidence:
      types.length > 0
        ? `rules present, none delivery-blocking: ${types.join(', ')}`
        : 'no rules apply',
  };
}

/** Probe every standing lane branch. `branches` overrides for consumers
 *  that care about one lane (the dep-bump plan) or for tests. */
export function probeDeliveryPreconditions(
  cwd: string,
  opts: {
    readonly branches?: readonly string[];
    readonly probe?: ApiProbe;
    /** Injectable for tests: the `owner/repo` slug (skips the gh probe). */
    readonly slug?: string;
  } = {},
): DeliveryPreconditions {
  const branches = opts.branches ?? standingLaneBranches();
  const slug = opts.slug ?? repoSlug(cwd);
  if (slug === null) {
    return {
      probes: branches.map((branch) => ({
        branch,
        verdict: 'unknown' as const,
        evidence: 'could not verify: not a GitHub repo here, or the gh CLI is unavailable',
      })),
      anyBlocked: false,
      unverifiable: true,
    };
  }
  const probe = opts.probe ?? makeGhApiProbe(cwd);
  const probes = branches.map((branch) => probeBranchDelivery(probe, slug, branch));
  return {
    probes,
    anyBlocked: probes.some((p) => p.verdict === 'blocked'),
    unverifiable: probes.every((p) => p.verdict === 'unknown'),
  };
}

/** One human line per probe — shared by doctor, the plan surfaces, and the
 *  preflight disclosure (one phrasing, every consumer). */
export function describeDeliveryProbe(p: BranchDeliveryProbe): string {
  const head = `${p.branch}: ${p.verdict === 'ok' ? 'can deliver' : p.verdict.toUpperCase()}`;
  const remedy = p.remedy ? ` Remedy: ${p.remedy}.` : '';
  return `${head} — ${p.evidence}.${remedy}`;
}
