/**
 * `vyuh-dxkit setup-prebuild` — configures GitHub Codespaces prebuilds
 * for the repo, so fresh Codespaces start from a prebuilt image
 * instead of re-running the full devcontainer build.
 *
 * Math: dxkit's polyglot devcontainer takes ~7 min cold-start (post per-
 * stack feature work in Sprint 1). Prebuilds drop this to ~30s by
 * maintaining the built image in GitHub's image cache. Storage cost
 * ~$3-5/month per region; for a 20-dev team averaging 5 fresh
 * Codespaces/week, the wall-clock savings dwarf the cost by 2-3 orders
 * of magnitude.
 *
 * Wraps `gh api -X POST repos/{owner}/{repo}/codespaces/prebuilds` with
 * a JSON payload defining branch + region + retention. Edge cases:
 *   - gh CLI missing → preflight fails
 *   - No .devcontainer/ → fail with "run init --with-devcontainer first"
 *   - Org Codespaces disabled → HTTP 403 / 422 with org-admin guidance
 *   - Existing prebuild config for the same branch → skip with notice
 *     (idempotency; avoids accidental clobber of customer-chosen regions)
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

export interface SetupPrebuildOpts {
  /** Branch to prebuild. Defaults to the repo's default branch. */
  branch?: string;
  /**
   * Region(s) to prebuild in. If undefined, GitHub picks a reasonable
   * default (typically the customer's nearest region based on their
   * Codespaces preferences). Comma-separated list when multiple.
   */
  regions?: string;
  /** Force re-create even if a prebuild config exists for the branch. */
  force?: boolean;
}

interface ExistingPrebuild {
  id: number;
  ref: string;
  region_count: number;
}

interface PrebuildListResponse {
  total_count: number;
  prebuilds_configurations: Array<{
    id: number;
    ref: string;
    region_count?: number;
  }>;
}

function checkDevcontainer(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, '.devcontainer', 'devcontainer.json'));
}

/**
 * List existing prebuild configurations for the repo. Returns an empty
 * array on 404 (Codespaces not enabled for the org) — caller decides
 * whether to surface that as an error or continue.
 */
function listExistingPrebuilds(cwd: string, owner: string, repo: string): ExistingPrebuild[] {
  const out = ghApi(`repos/${owner}/${repo}/codespaces/prebuilds`, {
    cwd,
    method: 'GET',
  }) as PrebuildListResponse | null;
  if (!out || !Array.isArray(out.prebuilds_configurations)) return [];
  return out.prebuilds_configurations.map((p) => ({
    id: p.id,
    ref: p.ref,
    region_count: p.region_count ?? 0,
  }));
}

export async function runSetupPrebuild(cwd: string, opts: SetupPrebuildOpts = {}): Promise<void> {
  logger.header('vyuh-dxkit setup-prebuild');

  if (!preflightGhCli('setup-prebuild')) {
    process.exitCode = 1;
    return;
  }

  // Devcontainer presence — prebuild without a devcontainer is useless
  // (nothing to prebuild). Surface the fix path explicitly.
  if (!checkDevcontainer(cwd)) {
    logger.fail(
      'No .devcontainer/devcontainer.json found. Prebuilds need a devcontainer to build.',
    );
    logger.dim(`  → Run \`${dxkitCli('init --with-devcontainer --yes')}\` first to scaffold one.`);
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

  // Idempotency: skip if a prebuild already exists for this branch
  // (unless --force). Avoids clobbering customer-chosen regions.
  logger.info(`Checking existing prebuilds for ${owner}/${repo}#${branch}...`);
  let existing;
  try {
    existing = listExistingPrebuilds(cwd, owner, repo);
  } catch (e) {
    if (e instanceof GhError) {
      // 404 here usually means org Codespaces disabled OR you don't
      // have access to the prebuilds API on this repo.
      if (e.httpStatus === 404) {
        logger.fail(
          'Codespaces prebuilds API returned 404 — either Codespaces is disabled for this org ' +
            "or the repo doesn't support prebuilds.",
        );
        logger.dim(
          '  → Ask your org admin to enable Codespaces, or configure manually in repo Settings → Codespaces.',
        );
        process.exitCode = 1;
        return;
      }
      process.exitCode = renderGhError(e, 'List existing prebuilds');
      return;
    }
    throw e;
  }

  const branchRef = `refs/heads/${branch}`;
  const existingForBranch = existing.find((p) => p.ref === branchRef || p.ref === branch);
  if (existingForBranch && !opts.force) {
    logger.warn(
      `Prebuild config already exists for ${branch} (id=${existingForBranch.id}, ` +
        `regions=${existingForBranch.region_count}). Skipping.`,
    );
    logger.dim('  → Pass --force to re-create, or edit in repo Settings → Codespaces.');
    return;
  }

  // Payload — region selection is the trickiest part because GitHub's
  // API expects region IDs rather than friendly names. When the
  // customer doesn't specify, omit the region field and let GitHub
  // pick a sensible default based on the org's Codespaces preferences.
  const payload: Record<string, unknown> = {
    ref: branchRef,
    repository_id: undefined,
  };
  if (opts.regions) {
    payload.regions = opts.regions.split(',').map((r) => r.trim());
  }
  // Retention is optional; let GitHub's default apply (typically keep
  // the latest prebuild + retire older ones automatically).

  logger.info(
    `Creating prebuild for ${branch}` + (opts.regions ? ` (regions: ${opts.regions})` : '') + '...',
  );

  try {
    ghApi(`repos/${owner}/${repo}/codespaces/prebuilds`, {
      cwd,
      method: 'POST',
      inputJson: JSON.stringify(payload),
    });
  } catch (e) {
    if (e instanceof GhError) {
      // 402 / 422 typically indicate org-billing limits or invalid
      // region IDs. Surface clearly.
      if (e.httpStatus === 402) {
        logger.fail('Codespaces billing limit reached for this org.');
        logger.dim('  → Check repo / org spending limits in GitHub Settings.');
        process.exitCode = 1;
        return;
      }
      process.exitCode = renderGhError(e, 'Create prebuild');
      return;
    }
    throw e;
  }

  console.log(''); // slop-ok
  logger.success(`Prebuild configured for ${owner}/${repo}#${branch}.`);
  logger.dim(
    '  → First prebuild takes ~25 min (one-time); subsequent fresh Codespaces start in ~30s.',
  );
  logger.dim(`  → Verify: https://github.com/${owner}/${repo}/settings/codespaces`);
}
