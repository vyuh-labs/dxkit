/**
 * Content-stamp PARITY across producers (CLAUDE.md Rule 2.30).
 *
 * The invariant: the ORCHESTRATOR stamps every located entry (locatedness
 * decided by `entryToLocated`, the projection the matcher pairs on), so no
 * producer can ship unstamped — the 4.4.4 class where the custom-check
 * producer stamped nothing while the security producer stamped through a
 * local closure. Path-identity kinds (large-file, test-gap, dep-vuln...)
 * carry no line and no stamp.
 *
 * Injection-guarded in the NEW direction: a synthetic producer that emits a
 * bare located entry must come out of `runProducers` STAMPED (the registry
 * is covered structurally), and `captureFragment`'s output is pinned too
 * (the one entry-minting path outside the registry).
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
import { entryToLocated } from '../../src/baseline/entry-to-located';

/**
 * Every entry the git-aware matcher can relocate by line: it carries a
 * `(file, line)` locator (or, for a clone pair, a start line on its canonical
 * side). These are the entries that MUST carry a content hash when a commit
 * is available. Returns the offenders; empty means parity holds.
 */
function isLocated(e: RichBaselineEntry): boolean {
  const loc = entryToLocated(e);
  return loc.file !== undefined && typeof loc.line === 'number' && loc.line > 0;
}

function unstampedLocatedEntries(entries: ReadonlyArray<RichBaselineEntry>): RichBaselineEntry[] {
  return entries.filter(
    (e) => isLocated(e) && ('contentHash' in e ? e.contentHash : undefined) === undefined,
  );
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
    const locatedKinds = new Set(entries.filter(isLocated).map((e) => e.kind));
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

  it('SYNTHETIC INJECTION: a producer that emits a bare located entry comes out STAMPED', () => {
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
    // The orchestrator stamps registry output structurally: a new producer
    // needs no wiring, so the injected bare entry gains a hash.
    const entries = runProducers(locatedContext(dir, sha), [rogue]);
    expect(unstampedLocatedEntries(entries)).toEqual([]);
    const synth = entries.find((e) => e.id === 'synth0000feedbeef');
    expect(synth && 'contentHash' in synth ? synth.contentHash : undefined).toMatch(
      /^[0-9a-f]{16}$/,
    );
    // The negative control still exists: an entry whose file is OUTSIDE the
    // repo stays bare (the stamper's containment policy, not a stamping gap).
    const escapee = runProducers(locatedContext(dir, sha), [
      {
        ...rogue,
        produce() {
          return [
            {
              id: 'synth0000feedbee0',
              kind: 'code',
              tool: 'semgrep',
              rule: 'rule-1',
              file: '../outside.ts',
              line: 10,
            },
          ];
        },
      },
    ]);
    expect(unstampedLocatedEntries(escapee).map((e) => e.id)).toEqual(['synth0000feedbee0']);
  });

  it('every entry variant with a line locator declares contentHash (the stampOne cast invariant)', () => {
    // Compile-time sweep: constructing each line-locator variant with a
    // contentHash must typecheck. A new located kind without the field breaks
    // this block before the cast in stampOne can write an undeclared field.
    const anchors: [
      { file: string; line: number; symbol: string },
      { file: string; line: number; symbol: string },
    ] = [
      { file: 'a.ts', line: 1, symbol: 'x' },
      { file: 'b.ts', line: 2, symbol: 'y' },
    ];
    const variants: RichBaselineEntry[] = [
      {
        id: 'a'.repeat(16),
        kind: 'code',
        tool: 't',
        rule: 'r',
        file: 'a.ts',
        line: 1,
        contentHash: 'f'.repeat(16),
      },
      {
        id: 'b'.repeat(16),
        kind: 'hygiene',
        file: 'a.ts',
        line: 1,
        marker: 'todo',
        contentHash: 'f'.repeat(16),
      },
      {
        id: 'c'.repeat(16),
        kind: 'stale-allow',
        file: 'a.ts',
        line: 1,
        category: 'deferred',
        contentHash: 'f'.repeat(16),
      },
      {
        id: 'd'.repeat(16),
        kind: 'custom-check',
        check: 'lint:x',
        blocking: true,
        file: 'a.ts',
        line: 1,
        contentHash: 'f'.repeat(16),
      },
      {
        id: 'e'.repeat(16),
        kind: 'duplication',
        fileA: 'a.ts',
        fileB: 'b.ts',
        lines: 3,
        startLineA: 1,
        startLineB: 2,
        contentHash: 'f'.repeat(16),
      },
      {
        id: 'f'.repeat(16),
        kind: 'coverage-gap',
        file: 'a.ts',
        lineRange: [1, 3],
        contentHash: 'f'.repeat(16),
      },
      {
        id: 'a1'.repeat(8),
        kind: 'code-reimplementation',
        anchors,
        score: 0.9,
        contentHash: 'f'.repeat(16),
      },
    ];
    for (const v of variants) {
      const loc = entryToLocated(v);
      expect(loc.file, `${v.kind} keeps a file locator`).toBeDefined();
      expect(loc.line, `${v.kind} keeps a line locator`).toBeGreaterThan(0);
      expect(loc.contentHash, `${v.kind} forwards contentHash to the matcher`).toBe('f'.repeat(16));
    }
  });

  it('captureFragment output is stamped through the same entry point', async () => {
    const { captureFragment } = await import('../../src/baseline/fragment');
    const { trustedLocalContext } = await import('../../src/analysis-trust');
    const { loadPolicyFromCwd } = await import('../../src/baseline/policy');
    const policyDir = join(dir, '.dxkit');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'policy.json'),
      JSON.stringify({
        checks: [
          {
            name: 'seed-lint',
            command: `node -e "console.log('src/a.ts:12: no-x seeded')"`, // slop-ok
            parse: { regex: '^(?<file>[^:]+):(?<line>\\d+): (?<rule>\\S+)' },
          },
        ],
      }),
    );
    const fragment = await captureFragment({
      cwd: dir,
      trust: trustedLocalContext(),
      policy: loadPolicyFromCwd(dir),
      checks: ['seed-lint'],
    });
    const findings = fragment.findings as RichBaselineEntry[];
    expect(findings.length).toBeGreaterThan(0);
    expect(unstampedLocatedEntries(findings)).toEqual([]);
  });
});
