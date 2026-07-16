/**
 * `vyuh-dxkit ingest` — bring an external SAST engine's findings into
 * dxkit's pipeline.
 *
 * Sources today:
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
 *   --from-sonar     read a project's open BUG + VULNERABILITY issues
 *                    from the SonarQube / SonarCloud Web API (quota-free;
 *                    Sonar is not SARIF-native, so this IS the Sonar
 *                    path) using SONAR_TOKEN + host/project key. SONAR_*
 *                    credentials load from the environment / `.env` the
 *                    same way SNYK_* do.
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
import { resolveEngineFailure, failureMessage } from './ingest/engine-failure';
import { loadSnykEnv, loadSonarEnv } from './ingest/env-file';
import { fetchSonarFindings } from './ingest/sonar-api';
import { writeSnapshot } from './ingest/snapshot';
import { detectActiveLanguages } from './languages/index';
import type { SourceEngine, ExternalFinding } from './ingest/types';

export interface IngestOptions {
  sarif?: string;
  fromSnyk?: boolean;
  fromSonar?: boolean;
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
  /** Sonar identifiers (CLI flags override config / env). */
  sonarHost?: string;
  sonarProject?: string;
  sonarOrg?: string;
  sonarBranch?: string;
  sonarPr?: string;
  generatedAt: string;
  commitSha?: string;
  /** Skip opt-in `.env` loading of `SNYK_*` credentials (`--no-env-file`). */
  noEnvFile?: boolean;
  /** Explicit `.env` path for `SNYK_*` credentials (`--env-file <path>`). */
  envFile?: string;
}

function isSourceEngine(s: string | undefined): s is SourceEngine {
  return (
    s === 'snyk-code' || s === 'codeql' || s === 'semgrep-pro' || s === 'sonarqube' || s === 'sarif'
  );
}

export async function runIngest(cwd: string, opts: IngestOptions): Promise<void> {
  if (opts.fromSnyk) {
    await ingestFromSnyk(cwd, opts);
    return;
  }
  if (opts.fromSonar) {
    await ingestFromSonar(cwd, opts);
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
  logger.warn('Nothing to ingest. Pass --sarif <file>, --from-snyk, --from-sonar, or --codeql.');
  logger.dim('  Examples:');
  logger.dim('    vyuh-dxkit ingest --sarif results.sarif');
  logger.dim('    SNYK_TOKEN=… vyuh-dxkit ingest --from-snyk --org <id> --project <id>');
  logger.dim('    SNYK_TOKEN=… vyuh-dxkit ingest --from-snyk --snyk-cli  # free/team plans');
  logger.dim('    vyuh-dxkit ingest --from-snyk   # SNYK_* read from .env when present');
  logger.dim(
    '    SONAR_TOKEN=… vyuh-dxkit ingest --from-sonar --sonar-host <url> --sonar-project <key>',
  );
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
    reportEngineFailure(cwd, 'codeql', err, 'CodeQL run failed');
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

/**
 * The ONE engine-failure exit policy (every engine catch routes here).
 * Infrastructure failure (quota / rate limit / auth / network) with a
 * prior committed snapshot → keep the snapshot, disclose the skip,
 * exit 0: the gate reads the committed snapshot, never a live engine,
 * so a red refresh the team learns to ignore is strictly worse than a
 * stale-but-present snapshot. Anything else stays exit 1.
 */
function reportEngineFailure(cwd: string, engine: string, err: unknown, what: string): void {
  const disposition = resolveEngineFailure(cwd, engine, failureMessage(err));
  if (disposition.action === 'degrade') {
    logger.warn(`refresh skipped: ${engine} — ${disposition.reason}`);
    logger.dim(
      '  This is an infrastructure failure (quota / rate limit / auth / network), not a code problem.',
    );
    logger.dim(
      `  The gate continues on the committed snapshot from ${disposition.snapshotGeneratedAt}. ` +
        'Fix the engine access and re-run ingest to refresh it.',
    );
    return;
  }
  logger.warn(`${what}: ${disposition.reason}`);
  if (disposition.infra) {
    logger.dim(
      // Display string naming the path for the user, not snapshot access.
      `  This looks like an infrastructure failure, but no prior .dxkit/external/${engine}.json ` + // ingest-snapshot-ok
        'snapshot exists to fall back to — fix the engine access (token / quota / network) and retry.',
    );
  }
  process.exitCode = 1;
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
    reportEngineFailure(cwd, 'snyk-code', err, 'Snyk read failed');
    return;
  }
  writeAndReport(cwd, 'snyk-code', findings, opts);
}

/**
 * Read a project's open BUG + VULNERABILITY issues from the SonarQube /
 * SonarCloud Web API and snapshot them. Reading issues does not re-run
 * analysis (quota-free); Sonar is not SARIF-native, so this API read IS
 * the first-class path (Rule 13).
 *
 * FRESHNESS: the snapshot is what Sonar last ANALYZED. To gate an issue
 * a PR introduces, point the fetch at that PR's analysis
 * (`--sonar-pr <id>`) from the CI job that already runs Sonar there —
 * a post-merge-only Sonar setup gives a lagging record, not a live gate.
 */
async function ingestFromSonar(cwd: string, opts: IngestOptions): Promise<void> {
  // Opt-in: lift ONLY SONAR_* keys from a local `.env` (same loader +
  // precedence as the Snyk path — real env / CI secret always wins).
  const envLoad = loadSonarEnv(cwd, { noEnvFile: opts.noEnvFile, envFile: opts.envFile });
  if (envLoad) {
    for (const w of envLoad.warnings) logger.warn(w);
    if (envLoad.loadedKeys.length > 0) {
      logger.dim(`  Loaded ${envLoad.loadedKeys.join(', ')} from ${envLoad.path}`);
    }
  }

  const token = process.env.SONAR_TOKEN;
  if (!token) {
    logger.warn('SONAR_TOKEN is not set.');
    logger.dim(
      '  dxkit reads SONAR_TOKEN from the environment (a Sonar user token: ' +
        'My Account → Security → Generate Token). It also auto-loads SONAR_* keys from a ' +
        'local .env (only those keys, never the rest of the file).',
    );
    logger.dim(
      '  Export it (`export SONAR_TOKEN=…`), put it in .env, or add it as a CI secret, then retry.',
    );
    process.exitCode = 1;
    return;
  }

  // host/project resolve flag → persisted config (`.vyuh-dxkit.json:
  // deepSast.sonar`) → environment (the SONAR_HOST_URL / SONAR_PROJECT_KEY
  // names sonar-scanner itself uses, so a repo with Sonar CI already has them).
  const cfg = readDeepSastConfig(cwd);
  const hostUrl = opts.sonarHost ?? cfg.sonar?.hostUrl ?? process.env.SONAR_HOST_URL;
  const projectKey = opts.sonarProject ?? cfg.sonar?.projectKey ?? process.env.SONAR_PROJECT_KEY;
  const organization = opts.sonarOrg ?? cfg.sonar?.organization ?? process.env.SONAR_ORGANIZATION;
  if (!hostUrl || !projectKey) {
    logger.warn('Sonar host + project key are required to read issues from the Web API.');
    logger.dim(
      '  Pass --sonar-host <url> --sonar-project <key>, set them once in .vyuh-dxkit.json:',
    );
    logger.dim('    { "deepSast": { "sonar": { "hostUrl": "…", "projectKey": "…" } } }');
    logger.dim('  or export SONAR_HOST_URL / SONAR_PROJECT_KEY in your environment.');
    logger.dim('  SonarCloud host is https://sonarcloud.io (add --sonar-org <org> for your org).');
    process.exitCode = 1;
    return;
  }

  logger.info('Reading Sonar issues via the Web API (no analysis re-run; BUG + VULNERABILITY)…');
  let findings: ExternalFinding[];
  try {
    findings = await fetchSonarFindings({
      token,
      hostUrl,
      projectKey,
      organization,
      branch: opts.sonarBranch,
      pullRequest: opts.sonarPr,
      onLog: (m) => logger.warn(m),
    });
  } catch (err) {
    reportEngineFailure(cwd, 'sonarqube', err, 'Sonar read failed');
    return;
  }
  writeAndReport(cwd, 'sonarqube', findings, opts);
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
    reportEngineFailure(cwd, 'snyk-code', err, 'Snyk Code test failed');
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
