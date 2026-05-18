/**
 * `dxkit baseline create` orchestrator.
 *
 * Runs the canonical security analyzer, hands its aggregate through
 * per-kind producers to derive `BaselineEntry` identities, captures
 * repo + analysis-environment metadata, and writes the result to
 * `.dxkit/baselines/<name>.json`. The on-disk file is the durable
 * record subsequent `guardrail check` runs diff against.
 *
 * This module is the producer side; the matcher + classifier on the
 * consumer side already exist in `git-aware-match.ts` and
 * `policy.ts`. The two are connected by the file format defined in
 * `baseline-file.ts`.
 *
 * Today's producer coverage (11 of 14 identity kinds):
 *   - secret / code / config / dep-vuln (security aggregator)
 *   - secret-hmac (gitleaks raw-secret pass)
 *   - duplication (jscpd topClones)
 *   - stale-file (hygiene gather)
 *   - large-file (canonical large-file threshold)
 *   - license (licenses capability envelope)
 *   - test-gap / test-file-degradation (analyzeTestGaps report)
 *
 * Three kinds without producers yet:
 *   - god-file — `QualityMetrics.topGodFiles` is forward-declared
 *     but no analyzer populates it today; will light up when
 *     graphify surfaces per-file complexity offenders.
 *   - hygiene — per-occurrence positions need a gather extension
 *     (`gatherHygieneMarkers` returns counts, not positions);
 *     pending in a follow-up.
 *   - coverage-gap — needs symbol-aware or line-range coverage
 *     output from the coverage tool; pending.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gatherAnalysisResultBody } from '../analyzers/health';
import { readOrBuildAnalysisResult } from '../analyzers/cache';
import { gatherHygieneMarkers } from '../analyzers/quality/gather';
import { analyzeTestGaps } from '../analyzers/tests';
import { gatherGitleaksResult } from '../analyzers/tools/gitleaks';
import type { GitleaksRawSecret } from '../analyzers/tools/gitleaks';
import { VERSION as DXKIT_VERSION } from '../constants';
import {
  BASELINE_SCHEMA_VERSION,
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineAnalysisMeta, BaselineFile, BaselineRepoState } from './baseline-file';
import { DEFAULT_BROWNFIELD_POLICY } from './policy';
import { largeFilesToBaselineEntries } from './producers/health';
import { licensesToBaselineEntries } from './producers/licenses';
import { duplicationToBaselineEntries, staleFilesToBaselineEntries } from './producers/quality';
import { rawSecretsToBaselineEntries } from './producers/secret-hmac';
import { securityAggregateToBaselineEntries } from './producers/security';
import { testGapsToBaselineEntries } from './producers/tests';
import { resolveSalt } from './salt';
import type { BaselineEntry } from './types';

export interface CreateBaselineOptions {
  /** Repo root to baseline. Caller should pass an absolute path. */
  readonly cwd: string;
  /** Baseline name (becomes the filename stem under `.dxkit/baselines/`).
   *  Defaults to `'main'`. Different names allow per-branch / per-
   *  environment baselines to coexist on disk. */
  readonly name?: string;
  /** When true, overwrite an existing baseline file at the same path.
   *  When false (default), an existing file makes `createBaseline`
   *  throw — guards against accidentally clobbering a committed
   *  baseline with a fresh capture. */
  readonly force?: boolean;
  /** Forwarded to the underlying analyzer for per-tool timing logs. */
  readonly verbose?: boolean;
}

export interface CreateBaselineResult {
  readonly path: string;
  readonly file: BaselineFile;
}

/** Hash used for baseline-envelope metadata fields (policy, ignore,
 *  toolchain, config). Distinct concern from finding-identity
 *  fingerprints — these never enter the matcher's identity space. */
function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16); // fingerprint-helper-ok: envelope-metadata hash, not finding identity
}

/**
 * Read a small file's text content with the canonical "absent → ''"
 * convention. Treating absent files as the empty string keeps the
 * downstream metadata hash stable across runs where the file is
 * still missing.
 */
function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Resolve the absolute commit SHA + branch name of the working tree.
 *  Empty strings when the directory isn't a git repo — the rest of
 *  the orchestrator works fine, only the git-aware matcher loses its
 *  diff anchor on a future check. */
function readRepoState(cwd: string): { commitSha: string; branch: string } {
  const run = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
  return {
    commitSha: run('rev-parse', 'HEAD'),
    branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
  };
}

/** Build the analysis-environment hash bundle from the live repo. */
function buildAnalysisMeta(cwd: string): BaselineAnalysisMeta {
  const policyHash = hashContent(JSON.stringify(DEFAULT_BROWNFIELD_POLICY));
  const ignoreHash = hashContent(readOptionalFile(path.join(cwd, '.dxkit-ignore')));
  const configHash = hashContent(
    readOptionalFile(path.join(cwd, '.vyuh-dxkit.json')) +
      '\n' +
      readOptionalFile(path.join(cwd, '.project.yaml')),
  );
  // toolchainHash is filled in by `createBaseline` once the
  // per-tool version map has been resolved (depends on the gather).
  return { dxkitVersion: DXKIT_VERSION, policyHash, ignoreHash, toolchainHash: '', configHash };
}

/** Build the per-tool name → version map from the security
 *  aggregate's provenance. Sparse; only the tools that actually
 *  ran appear. Versions are placeholder strings until per-tool
 *  version capture lands; the names are enough for the
 *  `tooling_drift` reclassification to fire on "tool went from
 *  present to absent." */
function buildToolsMap(toolNames: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of toolNames) {
    if (name) out[name] = 'unknown';
  }
  return out;
}

/**
 * Run the baseline-create pipeline. Pure-orchestrator: each step has
 * a single responsibility (analyze → produce entries → resolve
 * envelope metadata → write file).
 */
export async function createBaseline(
  options: CreateBaselineOptions,
): Promise<CreateBaselineResult> {
  const cwd = path.resolve(options.cwd);
  const name = options.name ?? DEFAULT_BASELINE_NAME;
  const filePath = pathForBaseline(cwd, name);
  if (!options.force && fs.existsSync(filePath)) {
    throw new Error(
      `baseline already exists at ${filePath}. Pass force: true to overwrite, ` +
        `or use a different --name to keep both.`,
    );
  }

  const analysisResult = await readOrBuildAnalysisResult({
    cwd,
    build: (innerCwd) => gatherAnalysisResultBody(innerCwd, { verbose: !!options.verbose }),
  });
  const aggregate = analysisResult.capabilities.securityAggregate;
  if (!aggregate) {
    throw new Error(
      'baseline create: cached AnalysisResult missing securityAggregate ' +
        '(expected to be populated by gatherAnalysisResultBody).',
    );
  }

  const repoState: BaselineRepoState = {
    ...readRepoState(cwd),
    root: cwd,
  };

  // Salt resolves once; threaded into every producer that needs to
  // compute HMACs. The mode lands on the baseline file so the
  // matcher can re-derive the same salt at check time (or warn when
  // it can't).
  const { mode: saltMode, salt } = resolveSalt(cwd);

  // Producers. Today's set covers security (secret/code/config/
  // dep-vuln), secret-HMAC, duplication, stale-file, large-file,
  // license, test-gap, and test-file-degradation. Three identity
  // kinds (god-file, hygiene per-occurrence, coverage-gap) are
  // declared in the union but have no analyzer source yet and will
  // light up alongside the upstream gathers. Once the producer
  // registry exists (CLAUDE.md Rule 10), every producer dispatches
  // through it instead of being named here.
  const testGapsReport = await analyzeTestGaps(cwd, { verbose: !!options.verbose });
  const hygiene = gatherHygieneMarkers(cwd);
  const gitleaksOutcome = gatherGitleaksResult(cwd);
  const rawSecrets: ReadonlyArray<GitleaksRawSecret> =
    gitleaksOutcome.kind === 'success' ? gitleaksOutcome.rawSecrets : [];

  const findings: BaselineEntry[] = [];
  findings.push(
    ...securityAggregateToBaselineEntries(aggregate, {
      cwd,
      commitSha: repoState.commitSha || undefined,
    }),
  );
  findings.push(...rawSecretsToBaselineEntries({ rawSecrets, salt }));
  findings.push(...duplicationToBaselineEntries(analysisResult.capabilities.duplication));
  findings.push(...staleFilesToBaselineEntries(hygiene.staleFiles));
  findings.push(...largeFilesToBaselineEntries(analysisResult.metrics));
  findings.push(...licensesToBaselineEntries(analysisResult.capabilities.licenses));
  findings.push(...testGapsToBaselineEntries(testGapsReport));

  const toolNames = new Set<string>();
  if (aggregate.provenance.secrets.tool) toolNames.add(aggregate.provenance.secrets.tool);
  if (aggregate.provenance.codePatterns.tool) toolNames.add(aggregate.provenance.codePatterns.tool);
  if (aggregate.provenance.depVulns.tool) toolNames.add(aggregate.provenance.depVulns.tool);
  if (aggregate.provenance.tlsBypass.ran) toolNames.add('tls-bypass-registry');
  const tools = buildToolsMap([...toolNames].sort());

  const analysis: BaselineAnalysisMeta = {
    ...buildAnalysisMeta(cwd),
    toolchainHash: hashContent(JSON.stringify(tools)),
  };

  const file: BaselineFile = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name,
    createdAt: new Date().toISOString(),
    repo: repoState,
    analysis,
    tools,
    saltMode,
    findings,
  };

  writeBaselineFile(filePath, file);
  return { path: filePath, file };
}
