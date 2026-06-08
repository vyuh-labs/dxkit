/**
 * Snyk Code (SAST) via the Snyk CLI — the free-tier path.
 *
 * Reading findings over the Snyk REST API needs Snyk's API-access
 * entitlement, which is an Enterprise-tier feature. On Free/Team plans
 * that read returns `403 … not entitled for api access`. But running a
 * Snyk Code TEST via the CLI uses the Snyk Code *product* entitlement
 * (which Free includes, with a per-period test quota), and writes the
 * full results to a local SARIF file — which we then ingest through the
 * same `parseSarif` path as every other engine.
 *
 * So this is the path most customers actually use. It costs one Snyk
 * Code test per run (vs the quota-free API read on Enterprise).
 *
 * Detection + install go through the canonical registry (Rule 1): the
 * runner opts into the guarded `snyk` entry, and installs it on demand
 * (it's a small npm package) if missing. The CLI emits a non-fatal
 * platform-reporting error on plans without API access, but still writes
 * the SARIF — so we read the file regardless of exit code.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTool, getInstallCommand, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { runDetached } from '../analyzers/tools/runner';
import { parseSarif } from './sarif';
import type { ExternalFinding } from './types';

/** Env flag that opts the guarded `snyk` registry entry in. */
export const SNYK_OPTIN_ENV = 'DXKIT_SNYK_CLI';

/** `snyk code test` argv (no shell). Org scopes the entitlement; omit
 *  to use the token's default org. */
export function snykCodeTestArgs(org: string | undefined, sarifPath: string): string[] {
  const args = ['code', 'test', `--sarif-file-output=${sarifPath}`];
  if (org) args.push(`--org=${org}`);
  return args;
}

export interface RunSnykCodeOptions {
  cwd: string;
  /** Snyk org id — scopes which org's Code entitlement/quota is used. */
  org?: string;
  /** Snyk Code tests can take a few minutes; default 10 min. */
  timeoutMs?: number;
  onLog?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run `snyk code test` and return normalized findings. Installs the
 * Snyk CLI on demand if missing. Throws when no SARIF is produced (a
 * real failure); a non-zero exit with a written SARIF (findings present,
 * or the cosmetic platform-report 403) is treated as success.
 */
export async function runSnykCodeTest(opts: RunSnykCodeOptions): Promise<ExternalFinding[]> {
  process.env[SNYK_OPTIN_ENV] = '1';
  const log = opts.onLog ?? (() => {});

  let status = findTool(TOOL_DEFS.snyk, opts.cwd);
  if (!status.available || !status.path) {
    log('Snyk CLI not found — installing it on demand…');
    try {
      execSync(getInstallCommand(TOOL_DEFS.snyk), { stdio: 'ignore' });
    } catch {
      /* fall through to the availability check below */
    }
    status = findTool(TOOL_DEFS.snyk, opts.cwd);
  }
  if (!status.available || !status.path) {
    throw new Error('Snyk CLI is not available. Install it with `vyuh-dxkit tools install snyk`.');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-snyk-'));
  const sarifPath = path.join(workDir, 'snyk-code.sarif');
  try {
    log('Running `snyk code test` (uses one Snyk Code test from your quota)…');
    const outcome = await runDetached(status.path, snykCodeTestArgs(opts.org, sarifPath), {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    let raw = '';
    try {
      raw = fs.readFileSync(sarifPath, 'utf-8');
    } catch {
      raw = '';
    }
    if (!raw) {
      // No SARIF means the test genuinely failed (auth, network, no Code
      // entitlement) — surface the CLI's first stderr line.
      const firstErr = outcome.stderr
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      throw new Error(
        `Snyk CLI produced no SARIF (exit ${outcome.code})${firstErr ? `: ${firstErr}` : ''}`,
      );
    }
    return parseSarif(raw, 'snyk-code');
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
