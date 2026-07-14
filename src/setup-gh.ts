/**
 * Shared helpers for the `setup-branch-protection` and `setup-prebuild`
 * CLI subcommands. Both wrap GitHub API calls behind `gh api` for the
 * common path, with consistent detection / error messaging / repo
 * resolution. Co-locating the shared surface keeps the two subcommand
 * modules focused on payload construction.
 */

import { execSync } from 'child_process';
import * as logger from './logger';

export interface OwnerRepo {
  owner: string;
  repo: string;
}

export class GhError extends Error {
  public readonly httpStatus?: number;
  public readonly suggestion?: string;

  constructor(message: string, opts?: { httpStatus?: number; suggestion?: string }) {
    super(message);
    this.name = 'GhError';
    this.httpStatus = opts?.httpStatus;
    this.suggestion = opts?.suggestion;
  }
}

/**
 * Returns true if `gh` is on PATH and authenticated.
 *
 * Both setup-branch-protection and setup-prebuild require the gh CLI
 * (we don't ship an octokit-based fallback in 2.5.2 — keeps the
 * dependency surface narrow). Future octokit fallback would slot in
 * here without changing callers.
 */
export function ghCliAvailable(): boolean {
  try {
    execSync('gh --version', { stdio: 'pipe' });
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the owner+repo of the current git working tree using
 * `gh repo view --json owner,name`. Requires gh to be authenticated
 * AND the repo to have a github.com remote configured (gh respects
 * the same git-remote conventions).
 *
 * Throws GhError with actionable suggestion on every failure path so
 * the callers can render a clean error to the customer.
 */
export function resolveOwnerRepo(cwd: string): OwnerRepo {
  try {
    const out = execSync('gh repo view --json owner,name', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out) as { owner?: { login?: string }; name?: string };
    if (!parsed.owner?.login || !parsed.name) {
      throw new GhError('gh repo view returned an unexpected payload — re-run `gh auth login`.');
    }
    return { owner: parsed.owner.login, repo: parsed.name };
  } catch (e) {
    if (e instanceof GhError) throw e;
    const msg = (e as { stderr?: Buffer }).stderr?.toString() ?? (e as Error).message;
    if (msg.includes('not a git repository') || msg.includes('no remote')) {
      throw new GhError(
        'Repo has no github.com remote configured. Add the remote and push first.',
        {
          suggestion:
            'git remote add origin git@github.com:OWNER/REPO.git && git push -u origin main',
        },
      );
    }
    throw new GhError(`Could not resolve repo via gh: ${msg.trim().split('\n')[0]}`, {
      suggestion: 'Run `gh auth login` and confirm `gh repo view` works.',
    });
  }
}

/**
 * Resolve the repo's default branch via `gh repo view --json
 * defaultBranchRef`. Used as the default `--branch` when the customer
 * doesn't pass one explicitly — most repos use `main` but legacy
 * repos may still default to `master` etc.
 */
export function resolveDefaultBranch(cwd: string): string {
  return defaultBranchViaGh(cwd) ?? 'main';
}

/**
 * The repo's TRUE default branch per GitHub (`gh repo view --json
 * defaultBranchRef`), or `null` when gh is unavailable / not authenticated /
 * the repo isn't on GitHub. The ONE gh default-branch probe (Rule 2) — the
 * authoritative source, above any local git heuristic: a clone's
 * `origin/HEAD` can point at a feature branch (seen on a real onboarding), so
 * a workflow inited there would otherwise record the wrong default.
 */
export function defaultBranchViaGh(cwd: string): string | null {
  try {
    const out = execSync('gh repo view --json defaultBranchRef', {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out) as { defaultBranchRef?: { name?: string } };
    if (parsed.defaultBranchRef?.name) return parsed.defaultBranchRef.name;
  } catch {
    /* gh absent / unauthenticated / not a GitHub repo */
  }
  return null;
}

/**
 * Call `gh api` with the given args and return the parsed JSON body.
 * Throws GhError with the parsed HTTP status when the call fails so
 * callers can branch on 403 / 404 / 422 specifically.
 *
 * `args` should NOT include the `-X METHOD` flag — pass it via
 * `opts.method`. The endpoint is added at the end.
 */
export function ghApi(
  endpoint: string,
  opts: {
    cwd: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    inputJson?: string;
    extraArgs?: string[];
  },
): unknown {
  const args: string[] = ['api'];
  if (opts.method && opts.method !== 'GET') args.push('-X', opts.method);
  if (opts.inputJson) args.push('--input', '-');
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(endpoint);

  try {
    const out = execSync(`gh ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
      cwd: opts.cwd,
      stdio: opts.inputJson ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      input: opts.inputJson,
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr?.toString() ?? '').trim();
    const statusMatch = stderr.match(/HTTP (\d+):/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
    if (httpStatus === 403) {
      throw new GhError('Permission denied — you need admin rights on the repo.', {
        httpStatus,
        suggestion: 'Ask a repo admin to run this command, or configure manually in repo Settings.',
      });
    }
    if (httpStatus === 404) {
      throw new GhError('Endpoint not found — repo may not exist or you may lack access.', {
        httpStatus,
        suggestion: 'Verify the repo via `gh repo view`.',
      });
    }
    throw new GhError(`gh api failed (HTTP ${httpStatus ?? '?'}): ${stderr.split('\n')[0]}`, {
      httpStatus,
    });
  }
}

/**
 * Render a GhError to the customer. Returns the exit code the CLI
 * should use (always 1 for now, but kept as a separate return for
 * future "warn but don't fail" cases).
 */
export function renderGhError(err: GhError, context: string): number {
  logger.fail(`${context}: ${err.message}`);
  if (err.suggestion) logger.dim(`  → ${err.suggestion}`);
  return 1;
}

/**
 * Pre-flight check shared by both setup commands. Verifies gh CLI is
 * available + authenticated. Renders the manual-fallback instructions
 * if gh is missing rather than throwing — keeps the customer's
 * troubleshooting path consistent.
 *
 * Returns true if pre-flight passes; false (with rendered error) if not.
 */
export function preflightGhCli(commandName: string): boolean {
  if (ghCliAvailable()) return true;
  logger.fail(`${commandName}: gh CLI not available or not authenticated.`);
  logger.dim('  → Install gh: https://cli.github.com');
  logger.dim('  → Authenticate: `gh auth login`');
  return false;
}
