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
 * Today's producer coverage:
 *   - secret / code / config / dep-vuln (security aggregator)
 *
 * Remaining kinds (duplication, coverage-gap, test-gap, hygiene,
 * license, test-file-degradation, god-file, stale-file, large-file,
 * secret-hmac) land alongside their analyzer wiring in a follow-up
 * commit; the orchestrator's shape stays the same.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gatherAnalysisResultBody } from '../analyzers/health';
import { readOrBuildAnalysisResult } from '../analyzers/cache';
import { VERSION as DXKIT_VERSION } from '../constants';
import {
  BASELINE_SCHEMA_VERSION,
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineAnalysisMeta, BaselineFile, BaselineRepoState } from './baseline-file';
import { DEFAULT_BROWNFIELD_POLICY } from './policy';
import { securityAggregateToBaselineEntries } from './producers/security';
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

  const findings: BaselineEntry[] = securityAggregateToBaselineEntries(aggregate);

  const repoState: BaselineRepoState = {
    ...readRepoState(cwd),
    root: cwd,
  };

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

  const { mode: saltMode } = resolveSalt(cwd);

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
