/**
 * Shared fixtures for the `baseline refresh` lane tests (moved verbatim out of
 * `refresh-decision.test.ts` at the file-size bar): a repo with a real bare
 * origin, the prior/fresh baseline writers, the injected capture seam and the
 * observation records the degraded-capture refusal (#388) reads.
 */
import { afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ADVISORY_DECISION_BRANCH, type CaptureObservation } from '../../src/baseline/refresh';
import { BASELINE_SCHEMA_VERSION, type BaselineFile } from '../../src/baseline/baseline-file';
import type { AllowlistFile } from '../../src/allowlist/file';

/** A capture that observed every kind (the healthy-scanner record). */
export const observedAll: CaptureObservation = { notObservedReason: () => undefined };

/** A capture whose dependency source could not run: the #388 shape. The
 *  reason text is the gate's own (`kindNotObservedReason`), so the refusal
 *  reads the same provenance sentence the guardrail would. */
export const DEP_SOURCE_UNAVAILABLE =
  'not observed this run (the dependency scanner could not run)';
export const depVulnsUnavailable: CaptureObservation = {
  notObservedReason: (kind) => (kind === 'dep-vuln' ? DEP_SOURCE_UNAVAILABLE : undefined),
};

const tmps: string[] = [];
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function makeRepoWithOrigin(): { repo: string; bare: string } {
  const bare = mk('dxkit-refresh-bare-');
  const repo = mk('dxkit-refresh-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@e.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx', version: '1' }));
  fs.writeFileSync(path.join(repo, 'src.js'), 'const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, bare };
}

function mk(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

/** Register the per-test temp-dir cleanup in the calling test file. */
export function registerRefreshTmpCleanup(): void {
  afterEach(() => {
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
}

export function depVuln(id: string, pkg: string, advisoryId: string) {
  return { id, kind: 'dep-vuln' as const, package: pkg, installedVersion: '1.0.0', advisoryId };
}

export function baselineFile(cwd: string, commitSha: string, findings: unknown[]): BaselineFile {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: 'main',
    createdAt: '2026-07-20T00:00:00.000Z',
    repo: { commitSha, branch: 'main', root: cwd },
    analysis: {
      dxkitVersion: 'test',
      policyHash: '0'.repeat(16),
      ignoreHash: '0'.repeat(16),
      toolchainHash: '0'.repeat(16),
      configHash: '0'.repeat(16),
    },
    tools: {},
    saltMode: 'deterministic',
    findings: findings as BaselineFile['findings'],
  } as BaselineFile;
}

export function writeTreeBaseline(repo: string, file: BaselineFile): string {
  const p = path.join(repo, '.dxkit', 'baselines', 'main.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file));
  return p;
}

/** A capture seam that writes `findings` as the fresh baseline and reports
 *  `observation` as what the capture could see (every kind, by default). */
export function captureWriting(repo: string, findings: unknown[], observation = observedAll) {
  return async () => {
    writeTreeBaseline(repo, baselineFile(repo, git(repo, 'rev-parse', 'HEAD').trim(), findings));
    return observation;
  };
}

/** N distinct dep-vuln entries (the prior's recorded debt). */
export function manyDepVulns(n: number, tag: string) {
  return Array.from({ length: n }, (_, i) =>
    depVuln(`${tag}${i}`.padEnd(16, '0').slice(0, 16), `pkg-${i}`, `GHSA-${tag}-${i}`),
  );
}

export function readTreeBaseline(repo: string): BaselineFile {
  return JSON.parse(
    fs.readFileSync(path.join(repo, '.dxkit', 'baselines', 'main.json'), 'utf8'),
  ) as BaselineFile;
}

/** Commit a change so HEAD moves past the prior anchor. */
export function commitChange(repo: string, rel: string, content: string): void {
  fs.writeFileSync(path.join(repo, rel), content);
  git(repo, 'add', rel);
  git(repo, 'commit', '-q', '-m', `change ${rel}`);
}

export function decisionAllowlist(bare: string): AllowlistFile {
  const raw = execFileSync('git', ['show', `${ADVISORY_DECISION_BRANCH}:.dxkit/allowlist.json`], {
    cwd: bare,
    encoding: 'utf8',
  });
  return JSON.parse(raw) as AllowlistFile;
}
