/**
 * `vyuh-dxkit ingest` — bring an external SAST engine's findings into
 * dxkit's pipeline.
 *
 * Two sources today:
 *   --sarif <file>   parse a SARIF 2.1.0 file from ANY engine (CodeQL,
 *                    Snyk Code export, Semgrep Pro, Bearer, …)
 *   --from-snyk      read a project's Code findings from the Snyk REST
 *                    API (quota-free) using SNYK_TOKEN + org/project
 *
 * Either way the result is written to `.dxkit/external/<engine>.json`,
 * a committed snapshot every later scan reads — so the token is needed
 * only by whoever runs `ingest` (ideally one CI refresh job), not by
 * every developer.
 */
import * as fs from 'fs';
import * as logger from './logger';
import { parseSarif } from './ingest/sarif';
import { fetchSnykCodeFindings } from './ingest/snyk-api';
import { runCodeql, type CodeqlTarget } from './ingest/codeql';
import { writeSnapshot } from './ingest/snapshot';
import { detectActiveLanguages } from './languages/index';
import type { SourceEngine, ExternalFinding } from './ingest/types';

export interface IngestOptions {
  sarif?: string;
  fromSnyk?: boolean;
  codeql?: boolean;
  /** Override engine label for `--sarif` (else inferred from the file). */
  engine?: string;
  /** Snyk identifiers (CLI flags override config / env). */
  org?: string;
  project?: string;
  generatedAt: string;
  commitSha?: string;
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

async function ingestFromSnyk(cwd: string, opts: IngestOptions): Promise<void> {
  const token = process.env.SNYK_TOKEN;
  if (!token) {
    logger.warn('SNYK_TOKEN is not set. Export it (or add it as a CI secret) and retry.');
    process.exitCode = 1;
    return;
  }
  const orgId = opts.org;
  const projectId = opts.project;
  if (!orgId || !projectId) {
    logger.warn('--org <id> and --project <id> are required for --from-snyk.');
    logger.dim(
      '  Find them in the Snyk UI (Settings → Org ID; the project page URL → project ID).',
    );
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
    logger.warn(`Snyk read failed: ${(err as Error).message}`);
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
  logger.dim('  Next: `vyuh-dxkit vulnerabilities --graph-context` to see them graph-linked.');
}
