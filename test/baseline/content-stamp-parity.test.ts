/**
 * Content-stamp PARITY across producers (CLAUDE.md Rule 2.30).
 *
 * The invariant: every registered producer whose entries carry a LINE stamps
 * them with a `contentHash` when a commit is available. Path-identity kinds
 * (large-file, test-gap, stale-file, dep-vuln...) carry no line and no stamp.
 *
 * Why a parity test and not just the arch-check: the arch-check pins that the
 * hash is computed in ONE module; it cannot see a producer that simply never
 * calls it. That is exactly how the custom-check producer shipped unstamped
 * while the security producer stamped: nothing iterated the registry and
 * asked. This test does, on a real git repo, with every located producer fed
 * a finding, and it is injection-guarded (the checker must flag a synthetic
 * producer that emits a bare line-carrying entry) so a checker that stopped
 * looking would fail here rather than pass silently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  PRODUCERS,
  runProducers,
  type BaselineProducer,
  type ProducerContext,
} from '../../src/baseline/producers';
import type { RichBaselineEntry } from '../../src/baseline/types';
import type { SecurityAggregate } from '../../src/analyzers/security/aggregator';
import { producerFixtureContext } from './producer-fixture';

/**
 * Every entry the git-aware matcher can relocate by line: it carries a
 * `(file, line)` locator (or, for a clone pair, a start line on its canonical
 * side). These are the entries that MUST carry a content hash when a commit
 * is available. Returns the offenders; empty means parity holds.
 */
function unstampedLocatedEntries(entries: ReadonlyArray<RichBaselineEntry>): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];
  for (const e of entries) {
    const located =
      e.kind === 'duplication'
        ? e.startLineA > 0
        : 'line' in e && typeof e.line === 'number' && e.line > 0 && 'file' in e;
    if (!located) continue;
    const hash = 'contentHash' in e ? e.contentHash : undefined;
    if (hash === undefined) out.push(e);
  }
  return out;
}

const SOURCE =
  Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';

function locatedContext(dir: string, commitSha: string): ProducerContext {
  const base = producerFixtureContext();
  const aggregate: SecurityAggregate = {
    codeBySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
    depBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    secretsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableCodeBySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
    scoreableSecretsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableDepBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    findingsByCategory: {
      secret: [],
      code: [
        {
          severity: 'high',
          category: 'code',
          cwe: 'CWE-1',
          rule: 'rule-1',
          title: 'sample',
          file: 'src/a.ts',
          line: 10,
          tool: 'semgrep',
          fingerprint: '0000000000000001',
          canonicalRule: 'rule-1',
          producedBy: ['semgrep'],
        },
      ],
      config: [],
      dependency: [],
    },
    dependencyAdvisoryUniqueCount: 0,
    dependencyFindingsRawCount: 0,
    dedupCollisions: [],
    provenance: {
      secrets: { tool: null, ran: false },
      codePatterns: { tool: 'semgrep', ran: true },
      tlsBypass: { ran: false, patternCount: 0 },
      fileFindings: { ran: false },
      depVulns: { tool: null, available: true, unavailableReason: '' },
    },
  };
  return {
    ...base,
    cwd: dir,
    commitSha,
    analysisResult: {
      ...base.analysisResult,
      cwd: dir,
      commitSha,
      capabilities: {
        ...base.analysisResult.capabilities,
        securityAggregate: aggregate,
        duplication: {
          schemaVersion: 1,
          tool: 'jscpd',
          totalLines: 30,
          duplicatedLines: 6,
          percentage: 20,
          cloneCount: 1,
          topClones: [
            {
              lines: 3,
              tokens: 20,
              a: { file: 'src/a.ts', startLine: 5, endLine: 7 },
              b: { file: 'src/a.ts', startLine: 20, endLine: 22 },
            },
          ],
        },
      },
    },
    inlineAllowlistAnnotations: [
      { file: 'src/a.ts', line: 15, category: 'test-fixture', position: 'above' },
    ],
    customCheckFindings: [
      { check: 'lint:typescript', blocking: true, file: 'src/a.ts', line: 25, rule: 'no-x' },
      { check: 'check:seam', blocking: true, message: 'binary failure' },
    ],
  };
}

describe('content-stamp parity across the producer registry', () => {
  let dir: string;
  let sha: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-stamp-parity-'));
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), SOURCE);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: dir });
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('every line-carrying entry from every registered producer carries a contentHash', () => {
    const entries = runProducers(locatedContext(dir, sha), PRODUCERS);
    // Not vacuous: each located producer actually contributed a line-carrying
    // entry, so a producer that silently dropped its input would fail here.
    const locatedKinds = new Set(
      entries
        .filter((e) => unstampedLocatedEntries([e]).length === 0)
        .filter((e) => ('line' in e && typeof e.line === 'number') || e.kind === 'duplication')
        .map((e) => e.kind),
    );
    for (const kind of ['code', 'duplication', 'stale-allow', 'custom-check']) {
      expect(locatedKinds, `producer for ${kind} contributed a located entry`).toContain(kind);
    }
    expect(unstampedLocatedEntries(entries)).toEqual([]);
    // Path-identity kinds and binary findings stay bare: no line, no hash.
    const binary = entries.find((e) => e.kind === 'custom-check' && e.file === undefined);
    expect(binary && 'contentHash' in binary ? binary.contentHash : undefined).toBeUndefined();
  });

  it('with no commit the tree still stamps (an unborn HEAD is not a missing tree), and nothing throws', () => {
    const entries = runProducers(locatedContext(dir, ''), PRODUCERS);
    expect(entries.length).toBeGreaterThan(0);
    const located = entries.filter((e) => 'line' in e && typeof e.line === 'number' && e.line > 0);
    expect(located.length).toBeGreaterThan(0);
    for (const e of located) {
      expect('contentHash' in e ? e.contentHash : undefined).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('SYNTHETIC INJECTION: the checker flags a producer that emits a bare located entry', () => {
    const rogue: BaselineProducer = {
      name: 'synthetic-unstamped',
      contributes: ['code'],
      produce() {
        return [
          {
            id: 'synth0000feedbeef',
            kind: 'code',
            tool: 'semgrep',
            rule: 'rule-1',
            file: 'src/a.ts',
            line: 10,
          },
        ];
      },
      recallContexts() {
        return new Map([['code', { epoch: 1, inputs: {} }]]);
      },
    };
    const entries = runProducers(locatedContext(dir, sha), [rogue]);
    const offenders = unstampedLocatedEntries(entries);
    expect(offenders.map((e) => e.id)).toEqual(['synth0000feedbeef']);
  });
});
