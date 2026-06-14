import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { securityAggregateToBaselineEntries } from '../../../src/baseline/producers/security';
import type { CodeFinding, SecurityAggregate } from '../../../src/analyzers/security/aggregator';
import type { DepVulnFinding } from '../../../src/languages/capabilities/types';
import { identityFor } from '../../../src/baseline/finding-identity';
import { computeContentHash } from '../../../src/baseline/content-hash';

function codeFinding(over: Partial<CodeFinding> = {}): CodeFinding {
  return {
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
    ...over,
  };
}

function depFinding(over: Partial<DepVulnFinding> = {}): DepVulnFinding {
  return {
    id: 'GHSA-aaaa-bbbb-cccc',
    package: 'lodash',
    installedVersion: '4.17.20',
    tool: 'osv-scanner',
    severity: 'medium',
    ...over,
  };
}

function emptyAggregate(over: Partial<SecurityAggregate> = {}): SecurityAggregate {
  return {
    codeBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    depBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    secretsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableCodeBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableSecretsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    findingsByCategory: { secret: [], code: [], config: [], dependency: [] },
    dependencyAdvisoryUniqueCount: 0,
    dependencyFindingsRawCount: 0,
    dedupCollisions: [],
    provenance: {
      secrets: { tool: null, ran: false },
      codePatterns: { tool: null, ran: false },
      tlsBypass: { ran: false, patternCount: 0 },
      fileFindings: { ran: false },
      depVulns: { tool: null, available: true, unavailableReason: '' },
    },
    ...over,
  };
}

describe('securityAggregateToBaselineEntries', () => {
  it('emits no entries for an empty aggregate', () => {
    expect(securityAggregateToBaselineEntries(emptyAggregate())).toEqual([]);
  });

  it('maps each category to the matching BaselineEntry kind', () => {
    const aggregate = emptyAggregate({
      findingsByCategory: {
        secret: [codeFinding({ category: 'secret', tool: 'gitleaks', rule: 'generic-api-key' })],
        code: [codeFinding({ category: 'code', tool: 'semgrep', rule: 'sql-injection' })],
        config: [
          codeFinding({
            category: 'config',
            tool: 'env-files',
            rule: 'env-in-git',
            file: '.env',
            line: 0,
          }),
        ],
        dependency: [depFinding()],
      },
    });
    const entries = securityAggregateToBaselineEntries(aggregate);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(['secret', 'code', 'config', 'dep-vuln']);
  });

  it('stamps the matching `identityFor` value on each entry', () => {
    const code = codeFinding({
      category: 'code',
      tool: 'semgrep',
      rule: 'r1',
      file: 'x.ts',
      line: 5,
    });
    const dep = depFinding();
    const aggregate = emptyAggregate({
      findingsByCategory: {
        secret: [],
        code: [code],
        config: [],
        dependency: [dep],
      },
    });
    const entries = securityAggregateToBaselineEntries(aggregate);
    expect(entries[0].id).toBe(
      identityFor({
        kind: 'code',
        tool: code.tool,
        rule: code.rule,
        file: code.file,
        line: code.line,
      }),
    );
    expect(entries[1].id).toBe(
      identityFor({
        kind: 'dep-vuln',
        package: dep.package,
        installedVersion: dep.installedVersion,
        id: dep.id,
      }),
    );
  });

  it('omits installedVersion on dep-vuln entries when the source lacks it', () => {
    const aggregate = emptyAggregate({
      findingsByCategory: {
        secret: [],
        code: [],
        config: [],
        dependency: [depFinding({ installedVersion: undefined })],
      },
    });
    const entries = securityAggregateToBaselineEntries(aggregate);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.kind).toBe('dep-vuln');
    if (e.kind === 'dep-vuln') {
      expect(e.installedVersion).toBeUndefined();
    }
  });

  it('preserves multiset duplicates (same fingerprint, two entries)', () => {
    const f = codeFinding({ category: 'code', tool: 'semgrep', rule: 'r', file: 'x.ts', line: 1 });
    const aggregate = emptyAggregate({
      findingsByCategory: { secret: [], code: [f, f], config: [], dependency: [] },
    });
    const entries = securityAggregateToBaselineEntries(aggregate);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(entries[1].id);
  });

  it('omits contentHash when cwd or commitSha is missing', () => {
    const f = codeFinding({ file: 'x.ts', line: 5 });
    const aggregate = emptyAggregate({
      findingsByCategory: { secret: [], code: [f], config: [], dependency: [] },
    });
    const entries = securityAggregateToBaselineEntries(aggregate);
    const e = entries[0];
    if (e.kind !== 'code') throw new Error('shape');
    expect(e.contentHash).toBeUndefined();
  });

  describe('content-hash stamping (with git fixture)', () => {
    let dir: string;
    let sha: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dxkit-prod-sec-'));
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
      writeFileSync(
        join(dir, 'config.ts'),
        ['// line 1', 'const a = 1;', 'const b = 2;', 'const c = 3;', '// line 5'].join('\n') +
          '\n',
      );
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('stamps a content-hash matching computeContentHash on the file', () => {
      const f = codeFinding({ file: 'config.ts', line: 3 });
      const aggregate = emptyAggregate({
        findingsByCategory: { secret: [], code: [f], config: [], dependency: [] },
      });
      const entries = securityAggregateToBaselineEntries(aggregate, { cwd: dir, commitSha: sha });
      const e = entries[0];
      if (e.kind !== 'code') throw new Error('shape');
      expect(e.contentHash).toMatch(/^[0-9a-f]{16}$/);

      const fileContent =
        ['// line 1', 'const a = 1;', 'const b = 2;', 'const c = 3;', '// line 5'].join('\n') +
        '\n';
      expect(e.contentHash).toBe(computeContentHash(fileContent, 3));
    });

    it('omits contentHash for line 0 (whole-file findings)', () => {
      const f = codeFinding({ category: 'config', file: 'config.ts', line: 0 });
      const aggregate = emptyAggregate({
        findingsByCategory: { secret: [], code: [], config: [f], dependency: [] },
      });
      const entries = securityAggregateToBaselineEntries(aggregate, { cwd: dir, commitSha: sha });
      const e = entries[0];
      if (e.kind !== 'config') throw new Error('shape');
      expect(e.contentHash).toBeUndefined();
    });

    it('omits contentHash when the file is missing at the commit', () => {
      const f = codeFinding({ file: 'missing.ts', line: 1 });
      const aggregate = emptyAggregate({
        findingsByCategory: { secret: [], code: [f], config: [], dependency: [] },
      });
      const entries = securityAggregateToBaselineEntries(aggregate, { cwd: dir, commitSha: sha });
      const e = entries[0];
      if (e.kind !== 'code') throw new Error('shape');
      expect(e.contentHash).toBeUndefined();
    });
  });
});
