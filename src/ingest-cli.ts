/**
 * `vyuh-dxkit ingest` — bring an external SAST engine's findings into
 * dxkit's pipeline.
 *
 * Two sources today:
 *   --sarif <file>   parse a SARIF 2.1.0 file from ANY engine (CodeQL,
 *                    Snyk Code export, Semgrep Pro, Bearer, …)
 *   --from-snyk      read a project's Code findings from the Snyk REST
 *                    API (quota-free) using SNYK_TOKEN + org/project.
 *                    On plans without REST API access (Enterprise-only)
 *                    this auto-falls-back to `snyk code test`; pass
 *                    --snyk-cli to force that path and skip the REST try.
 *                    SNYK_* credentials are read from the environment and,
 *                    as a fallback, from a local `.env` (only SNYK_* keys;
 *                    --no-env-file opts out, --env-file <path> overrides).
 *
 * Either way the result is written to `.dxkit/external/<engine>.json`,
 * a committed snapshot every later scan reads — so the token is needed
 * only by whoever runs `ingest` (ideally one CI refresh job), not by
 * every developer.
 */
import * as fs from 'fs';
import { dxkitCli } from './self-invocation';
import * as logger from './logger';
import { parseSarif } from './ingest/sarif';
import { fetchSnykCodeFindings } from './ingest/snyk-api';
import { runSnykCodeTest } from './ingest/snyk-cli';
import { runCodeql, type CodeqlTarget } from './ingest/codeql';
import { readDeepSastConfig } from './ingest/config';
import { loadSnykEnv } from './ingest/env-file';
import { writeSnapshot } from './ingest/snapshot';
import { detectActiveLanguages } from './languages/index';
import type { SourceEngine, ExternalFinding } from './ingest/types';

export interface IngestOptions {
  sarif?: string;
  fromSnyk?: boolean;
  codeql?: boolean;
  /** Force the `snyk code test` CLI path, skipping the REST attempt. The
   *  REST API is an Enterprise-only entitlement; free/team plans must use
   *  the CLI (which costs one Snyk Code test from the quota). */
  snykCli?: boolean;
  /** Override engine label for `--sarif` (else inferred from the file). */
  engine?: string;
  /** Snyk identifiers (CLI flags override config / env). */
  org?: string;
  project?: string;
  generatedAt: string;
  commitSha?: string;
  /** Skip opt-in `.env` loading of `SNYK_*` credentials (`--no-env-file`). */
  noEnvFile?: boolean;
  /** Explicit `.env` path for `SNYK_*` credentials (`--env-file <path>`). */
  envFile?: string;
}

function isSourceEngine(s: string | undefined): s is SourceEngine {
  return s === 'snyk-code' || s === 'codeql' || s === 'semgrep-pro' || s === 'sarif';
}

export async function runIngest(cwd: string, opts: IngestOptions): Promise<void> {
  if (opts.fromSnyk) {
    await ingestFromSnyk(cwd, opts);
    return;
  }
  if (opts.codeql) {
    await ingestFromCodeql(cwd, opts);
    return;
  }
  if (opts.sarif) {
    ingestFromSarif(cwd, opts);
    return;
  }
  logger.warn('Nothing to ingest. Pass --sarif <file>, --from-snyk, or --codeql.');
  logger.dim('  Examples:');
  logger.dim('    vyuh-dxkit ingest --sarif results.sarif');
  logger.dim('    SNYK_TOKEN=… vyuh-dxkit ingest --from-snyk --org <id> --project <id>');
  logger.dim('    SNYK_TOKEN=… vyuh-dxkit ingest --from-snyk --snyk-cli  # free/team plans');
  logger.dim('    vyuh-dxkit ingest --from-snyk   # SNYK_* read from .env when present');
  logger.dim('    vyuh-dxkit ingest --codeql        # OSS / GitHub Advanced Security only');
  process.exitCode = 1;
}

async function ingestFromCodeql(cwd: string, opts: IngestOptions): Promise<void> {
  // CodeQL languages come from the active packs' recipe (Rule 6), so a
  // new pack auto-extends what gets scanned. JS+TS collapse to one
  // `javascript` DB.
  const targets: CodeqlTarget[] = [];
  const seen = new Set<string>();
  for (const pack of detectActiveLanguages(cwd)) {
    const lang = pack.deepSast?.codeqlLanguage;
    if (lang && !seen.has(lang)) {
      seen.add(lang);
      targets.push({ language: lang, querySuite: pack.deepSast?.codeqlQuerySuite });
    }
  }
  if (targets.length === 0) {
    logger.warn('No active language pack has a CodeQL extractor for this repo.');
    process.exitCode = 1;
    return;
  }
  logger.info(
    `Running CodeQL for: ${targets.map((t) => t.language).join(', ')} (this can take many minutes)…`,
  );
  let findings: ExternalFinding[];
  try {
    findings = await runCodeql({ cwd, targets, onLog: (m) => logger.dim(`  ${m}`) });
  } catch (err) {
    logger.warn(`CodeQL run failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  writeAndReport(cwd, 'codeql', findings, opts);
}

function ingestFromSarif(cwd: string, opts: IngestOptions): void {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.sarif as string, 'utf-8');
  } catch (err) {
    logger.warn(`Cannot read SARIF file ${opts.sarif}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const engineOverride = isSourceEngine(opts.engine) ? opts.engine : undefined;
  const findings = parseSarif(raw, engineOverride);
  // All findings from one SARIF share an engine; use the first (or the
  // override / generic `sarif`) as the snapshot's engine label.
  const engine: SourceEngine = engineOverride ?? findings[0]?.engine ?? 'sarif';
  writeAndReport(cwd, engine, findings, opts);
}

/** A REST failure that means "this plan can't read the API" — Enterprise-
 *  only entitlement. We fall back to the CLI (Snyk Code product) path. */
export function isNotEntitled(message: string): boolean {
  return /\b403\b/.test(message) || /not entitled/i.test(message) || /api access/i.test(message);
}

async function ingestFromSnyk(cwd: string, opts: IngestOptions): Promise<void> {
  // Opt-in: lift ONLY SNYK_* keys from a local `.env` into the
  // environment (real exported env / CI secret always wins). Disabled
  // by --no-env-file; path overridable by --env-file. CI has no .env →
  // no-op, so behavior there is unchanged.
  const envLoad = loadSnykEnv(cwd, { noEnvFile: opts.noEnvFile, envFile: opts.envFile });
  if (envLoad) {
    for (const w of envLoad.warnings) logger.warn(w);
    if (envLoad.loadedKeys.length > 0) {
      logger.dim(`  Loaded ${envLoad.loadedKeys.join(', ')} from ${envLoad.path}`);
    }
  }

  const token = process.env.SNYK_TOKEN;
  if (!token) {
    logger.warn('SNYK_TOKEN is not set.');
    logger.dim(
      '  dxkit reads SNYK_TOKEN from the environment. It also auto-loads SNYK_* keys ' +
        'from a local .env (only those keys, never the rest of the file).',
    );
    logger.dim(
      '  Export it (`export SNYK_TOKEN=…`), put it in .env, or add it as a CI secret, then retry. ' +
        'Use --no-env-file to skip .env, or --env-file <path> to point elsewhere.',
    );
    process.exitCode = 1;
    return;
  }
  // Org/project resolve flag → persisted config (`.vyuh-dxkit.json:
  // deepSast.snyk`) → environment, so a sourced shell or configured repo
  // can run `ingest --from-snyk` with no flags. SNYK_ORG_ID / SNYK_PROJECT_ID
  // also come from a local .env via loadSnykEnv above (SNYK_* keys only).
  const cfg = readDeepSastConfig(cwd);
  const orgId = opts.org ?? cfg.snyk?.orgId ?? process.env.SNYK_ORG_ID;
  const projectId = opts.project ?? cfg.snyk?.projectId ?? process.env.SNYK_PROJECT_ID;

  // Forced CLI path (free/team plans): skip the REST attempt entirely. The
  // CLI tests the local checkout, so it needs only the org (to scope the
  // entitlement), not a project id.
  if (opts.snykCli) {
    await ingestViaSnykCli(cwd, opts, orgId);
    return;
  }

  if (!orgId || !projectId) {
    logger.warn('Snyk org + project are required to read findings via the REST API.');
    logger.dim('  Pass --org <id> --project <id>, set them once in .vyuh-dxkit.json:');
    logger.dim('    { "deepSast": { "snyk": { "orgId": "…", "projectId": "…" } } }');
    logger.dim('  or export SNYK_ORG_ID / SNYK_PROJECT_ID in your environment.');
    logger.dim(
      '  Find them in the Snyk UI (Settings → Org ID; the project page URL → project ID).',
    );
    logger.dim('  On free/team plans (no REST API access) use --snyk-cli to run a Snyk Code test.');
    process.exitCode = 1;
    return;
  }
  logger.info('Reading Snyk Code findings via the REST API (no test quota consumed)…');
  let findings: ExternalFinding[];
  try {
    findings = await fetchSnykCodeFindings({
      token,
      orgId,
      projectId,
      apiBase: process.env.SNYK_API,
    });
  } catch (err) {
    const message = (err as Error).message;
    // REST API access is an Enterprise feature; on other plans the read
    // 403s. Fall back to `snyk code test` (Snyk Code product entitlement,
    // which free includes) so one command works on every plan.
    if (isNotEntitled(message)) {
      logger.warn('Snyk REST API access is not available on this plan (an Enterprise feature).');
      logger.dim('  Falling back to `snyk code test` (Snyk Code product, uses one test quota)…');
      await ingestViaSnykCli(cwd, opts, orgId);
      return;
    }
    logger.warn(`Snyk read failed: ${message}`);
    process.exitCode = 1;
    return;
  }
  writeAndReport(cwd, 'snyk-code', findings, opts);
}

/** Run `snyk code test` on the local checkout and snapshot the findings.
 *  Used both as the explicit `--snyk-cli` path and as the REST fallback. */
async function ingestViaSnykCli(
  cwd: string,
  opts: IngestOptions,
  orgId: string | undefined,
): Promise<void> {
  let findings: ExternalFinding[];
  try {
    findings = await runSnykCodeTest({ cwd, org: orgId, onLog: (m) => logger.dim(`  ${m}`) });
  } catch (err) {
    logger.warn(`Snyk Code test failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  writeAndReport(cwd, 'snyk-code', findings, opts);
}

function writeAndReport(
  cwd: string,
  engine: SourceEngine,
  findings: ExternalFinding[],
  opts: IngestOptions,
): void {
  const file = writeSnapshot(cwd, {
    schemaVersion: 1,
    engine,
    generatedAt: opts.generatedAt,
    ...(opts.commitSha ? { commitSha: opts.commitSha } : {}),
    findings,
  });
  const bySev = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  logger.success(`Ingested ${findings.length} ${engine} finding(s) → ${file}`);
  logger.dim(
    `  critical:${bySev.critical || 0} high:${bySev.high || 0} medium:${bySev.medium || 0} low:${bySev.low || 0}`,
  );
  logger.dim('  Commit .dxkit/external/ so every scan + CI run sees these without a token.');
  logger.dim(
    `  Next: \`${dxkitCli('vulnerabilities --graph-context')}\` to see them graph-linked.`,
  );
}
