/**
 * `vyuh-dxkit setup-branch-protection` — configures branch protection
 * on the repo's default branch with dxkit's guardrail workflow listed
 * as a required status check. Without this step, the dxkit-guardrails
 * workflow we install only runs informationally — PRs can merge even
 * if the guardrail fails. With it, merges are blocked on guardrail
 * failures.
 *
 * Wraps `gh api -X PUT repos/{owner}/{repo}/branches/{branch}/protection`
 * with a JSON payload that:
 *   1. Adds `dxkit-guardrails` to required status checks
 *   2. Preserves any other required checks already configured
 *      (idempotent merge — don't clobber customer policy)
 *   3. Doesn't force a review-count policy by default (set --require-reviews=N if wanted)
 *
 * Edge cases handled:
 *   - gh CLI missing → preflight fails with clear install instructions
 *   - No github.com remote → resolveOwnerRepo throws GhError with suggestion
 *   - Customer not admin (HTTP 403) → ghApi throws with admin-asks suggestion
 *   - Workflow file missing → warn before applying (the protection rule
 *     would otherwise block ALL PRs until the workflow exists)
 *   - Existing protection rule with different required checks → merge
 *     dxkit-guardrails into the list instead of replacing
 */

import * as fs from 'fs';
import { dxkitCli } from './self-invocation';
import * as path from 'path';
import * as logger from './logger';
import {
  GhError,
  ghApi,
  preflightGhCli,
  renderGhError,
  resolveDefaultBranch,
  resolveOwnerRepo,
} from './setup-gh';
import {
  classifyEnforcement,
  probeEnforcementReads,
  GUARDRAIL_CHECK,
  LEGACY_GUARDRAIL_CHECK,
} from './enforcement';

export interface SetupBranchProtectionOpts {
  /** Branch to protect. Defaults to the repo's default branch. */
  branch?: string;
  /** Number of required PR reviews. Default 0 (don't force a policy). */
  requireReviews?: number;
  /** Force overwrite of existing required checks. Default merge. */
  force?: boolean;
  /** Preview only: print the exact change and DO NOT write to the repo. This is
   *  the default for `vyuh-dxkit protect` (dxkit never silently reconfigures a
   *  repo's settings — you apply explicitly with `--apply` / `--yes`). */
  dryRun?: boolean;
}

/** Shape of GitHub's branch protection payload — partial subset we touch. */
interface ProtectionPayload {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
  } | null;
  enforce_admins: boolean;
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
    required_approving_review_count: number;
  } | null;
  restrictions: null;
}

const REQUIRED_CHECK = GUARDRAIL_CHECK;

function readExistingProtection(
  cwd: string,
  owner: string,
  repo: string,
  branch: string,
): ProtectionPayload | null {
  try {
    return ghApi(`repos/${owner}/${repo}/branches/${branch}/protection`, {
      cwd,
      method: 'GET',
    }) as ProtectionPayload;
  } catch (e) {
    if (e instanceof GhError && e.httpStatus === 404) {
      // No protection rule exists yet — that's expected for the
      // common case where we're the first to configure one.
      return null;
    }
    throw e;
  }
}

/**
 * Build the protection payload by merging dxkit-guardrails into any
 * existing required-checks list. Preserves customer-configured
 * required checks, review counts, and admin-enforcement settings.
 */
function buildPayload(
  existing: ProtectionPayload | null,
  opts: SetupBranchProtectionOpts,
): ProtectionPayload {
  // Existing required checks — preserve, then ensure dxkit-guardrails is in the
  // set. Drop the LEGACY `guardrail` context if present: the workflow no longer
  // emits it, so leaving it required would block every PR on a phantom check.
  const existingChecks = (existing?.required_status_checks?.contexts ?? []).filter(
    (c) => c !== LEGACY_GUARDRAIL_CHECK,
  );
  const mergedChecks = opts.force
    ? [REQUIRED_CHECK]
    : [...new Set([...existingChecks, REQUIRED_CHECK])];

  // Reviews policy — only override when the customer passed --require-reviews.
  // Without it, preserve whatever was there (or set null if no prior rule).
  let reviews: ProtectionPayload['required_pull_request_reviews'] = null;
  if (opts.requireReviews !== undefined && opts.requireReviews > 0) {
    reviews = {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: opts.requireReviews,
    };
  } else if (existing?.required_pull_request_reviews) {
    reviews = existing.required_pull_request_reviews;
  }

  return {
    required_status_checks: { strict: false, contexts: mergedChecks },
    enforce_admins: existing?.enforce_admins ?? false,
    required_pull_request_reviews: reviews,
    restrictions: null, // user/team push restrictions — out of scope here
  };
}

function checkWorkflowFile(cwd: string): boolean {
  const wfPath = path.join(cwd, '.github', 'workflows', 'dxkit-guardrails.yml');
  return fs.existsSync(wfPath);
}

export async function runSetupBranchProtection(
  cwd: string,
  opts: SetupBranchProtectionOpts = {},
): Promise<void> {
  logger.header('vyuh-dxkit setup-branch-protection');

  if (!preflightGhCli('setup-branch-protection')) {
    process.exitCode = 1;
    return;
  }

  let ownerRepo;
  try {
    ownerRepo = resolveOwnerRepo(cwd);
  } catch (e) {
    if (e instanceof GhError) {
      process.exitCode = renderGhError(e, 'Resolve repo');
      return;
    }
    throw e;
  }
  const { owner, repo } = ownerRepo;

  const branch = opts.branch ?? resolveDefaultBranch(cwd);

  // Warn if the workflow file isn't present — protection-by-name would
  // otherwise block ALL PRs until the workflow is added.
  if (!checkWorkflowFile(cwd)) {
    logger.warn(
      'No .github/workflows/dxkit-guardrails.yml found. Applying branch protection ' +
        'now would block every PR until that workflow exists.',
    );
    logger.dim(`  → Run \`${dxkitCli('init --with-ci --yes')}\` first to scaffold the workflow.`);
    process.exitCode = 1;
    return;
  }

  // Read the branch's EFFECTIVE enforcement first (classic protection AND
  // repository rulesets). Two things depend on it:
  //   - if the guardrail is already required, there's nothing to do;
  //   - if a RULESET governs the branch, dxkit must not write a conflicting
  //     classic protection rule — the check belongs in the ruleset, which dxkit
  //     won't silently rewrite. Point the user at it instead.
  try {
    const state = classifyEnforcement(branch, probeEnforcementReads(cwd, branch));
    if (state.guardrailRequired) {
      logger.success(
        `${owner}/${repo}#${branch} already requires the ${REQUIRED_CHECK} check — nothing to do.`,
      );
      return;
    }
    if (state.rulesetGoverned) {
      console.log(''); // slop-ok
      logger.warn(`${owner}/${repo}#${branch} is governed by a repository ruleset.`);
      logger.dim(
        `  → dxkit will not create a conflicting classic branch-protection rule alongside it.`,
      );
      logger.dim(`  → Add '${REQUIRED_CHECK}' to that ruleset's required status checks:`);
      logger.dim(`     https://github.com/${owner}/${repo}/settings/rules`);
      return;
    }
  } catch (e) {
    // Fail-open: if we couldn't read enforcement (gh error, no scope), fall
    // through to the classic path below, which does its own guarded read.
    if (!(e instanceof GhError)) throw e;
  }

  logger.info(`Resolving existing protection on ${owner}/${repo}#${branch}...`);
  let existing;
  try {
    existing = readExistingProtection(cwd, owner, repo, branch);
  } catch (e) {
    if (e instanceof GhError) {
      process.exitCode = renderGhError(e, 'Read existing protection');
      return;
    }
    throw e;
  }
  if (existing) {
    logger.info(
      `  → Found ${existing.required_status_checks?.contexts.length ?? 0} existing required check(s); ` +
        `dxkit-guardrails ${
          existing.required_status_checks?.contexts.includes(REQUIRED_CHECK)
            ? 'already in list'
            : 'will be merged in'
        }.`,
    );
  } else {
    logger.info('  → No existing protection rule; creating one with dxkit-guardrails as required.');
  }

  const payload = buildPayload(existing, opts);

  if (opts.dryRun) {
    console.log(''); // slop-ok
    logger.info(`Would apply to ${owner}/${repo}#${branch} (dry run — no changes written):`);
    logger.dim(
      `  → required status checks: [${payload.required_status_checks?.contexts.join(', ')}]`,
    );
    logger.dim(
      `  → required PR review approvals: ${payload.required_pull_request_reviews?.required_approving_review_count ?? 0}`,
    );
    console.log(''); // slop-ok
    logger.info(`Re-run with \`${dxkitCli('protect --apply')}\` to write these settings.`);
    return;
  }

  logger.info(
    `Applying protection: required checks = [${payload.required_status_checks?.contexts.join(', ')}]; ` +
      `reviews required = ${payload.required_pull_request_reviews?.required_approving_review_count ?? 0}.`,
  );

  try {
    ghApi(`repos/${owner}/${repo}/branches/${branch}/protection`, {
      cwd,
      method: 'PUT',
      inputJson: JSON.stringify(payload),
    });
  } catch (e) {
    if (e instanceof GhError) {
      process.exitCode = renderGhError(e, 'Apply protection');
      return;
    }
    throw e;
  }

  console.log(''); // slop-ok
  logger.success(`Branch protection applied to ${owner}/${repo}#${branch}.`);
  logger.dim(`  → Verify: https://github.com/${owner}/${repo}/settings/branches`);
  if (!payload.required_pull_request_reviews) {
    logger.dim(
      '  → Review-count policy NOT changed (pass --require-reviews=N to require reviews).',
    );
  }
}
