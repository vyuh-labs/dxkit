/**
 * The tier-2 repo tool registry contract (issue #254):
 *   - read-only, never throws: garbage args and absent artifacts come back
 *     as explanatory pointer text, never an exception;
 *   - absent graph → the exact enable command (the doctor-recommend
 *     pattern), never an error;
 *   - contributor names are DETAIL-TIER: history/ownership answer counts
 *     and dates with the toggle off;
 *   - path arguments are guarded (traversal, absolute, leading dash).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { agentTools, type GitRunner } from '../../src/learn/agent-tools';
import { writeBaselineFile, pathForBaseline } from '../../src/baseline/baseline-file';
import { BASELINE_SCHEMA_VERSION } from '../../src/baseline/baseline-file';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-agent-tools-'));
}

/** Minimal valid graph.json: main() -> helper() -> logger(). */
function writeGraph(cwd: string): void {
  const dir = path.join(cwd, '.dxkit', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const nodes = [
    { id: 'n1', kind: 'function', label: 'main()', sourceFile: 'src/a.ts', line: 5 },
    { id: 'n3', kind: 'function', label: 'helper()', sourceFile: 'src/b.ts', line: 3 },
    { id: 'n5', kind: 'function', label: 'logger()', sourceFile: 'src/c.ts', line: 1 },
    { id: 't1', kind: 'function', label: 'test_main()', sourceFile: 'test/a.test.ts', line: 2 },
  ];
  const edges = [
    { from: 'n1', to: 'n3', relation: 'calls' },
    { from: 'n3', to: 'n5', relation: 'calls' },
    { from: 't1', to: 'n1', relation: 'calls' },
  ];
  fs.writeFileSync(
    path.join(dir, 'graph.json'),
    JSON.stringify({
      schemaVersion: 1,
      meta: {
        tool: 'graphify',
        graphifyVersion: '',
        dxkitVersion: '4.3.6',
        generatedAt: '2026-08-03T00:00:00Z',
        sourceFilesInGraph: 4,
        excludedFileCount: 0,
        packs: ['typescript'],
        truncated: false,
        truncatedReason: '',
      },
      nodes,
      edges,
      communities: [],
      symbolIndex: { main: ['n1'], helper: ['n3'], logger: ['n5'], test_main: ['t1'] },
      endpoints: [],
    }),
  );
}

function writeBaseline(cwd: string): void {
  writeBaselineFile(pathForBaseline(cwd, 'main'), {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: 'main',
    createdAt: '2026-08-01T00:00:00.000Z',
    repo: { commitSha: 'a'.repeat(40), branch: 'main', root: cwd },
    analysis: {
      dxkitVersion: '4.3.6',
      policyHash: 'p'.repeat(16),
      ignoreHash: 'i'.repeat(16),
      toolchainHash: 't'.repeat(16),
      configHash: 'c'.repeat(16),
    },
    tools: { gitleaks: 'unknown' },
    saltMode: 'deterministic',
    findings: [
      {
        id: 'abc123def4567890',
        kind: 'secret',
        tool: 'gitleaks',
        rule: 'generic-api-key',
        file: 'src/config.ts',
        line: 42,
        severity: 'high',
      },
      {
        id: 'def123def4567890',
        kind: 'code',
        tool: 'semgrep',
        rule: 'x',
        file: 'src/other.ts',
        line: 7,
      },
    ],
  });
}

const noGit: GitRunner = () => '';

describe('agent tool registry — contract', () => {
  it('exposes the six read-only tools with well-formed schemas and unique names', () => {
    const tools = agentTools({ cwd: tmpRepo(), detail: false }, noGit);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'function_callers',
      'function_callees',
      'file_blast_radius',
      'file_history',
      'file_owners',
      'debt_findings',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('never throws: garbage args on every tool return pointer text', () => {
    const tools = agentTools({ cwd: tmpRepo(), detail: false }, noGit);
    for (const t of tools) {
      expect(typeof t.run({})).toBe('string');
      expect(typeof t.run({ symbol: 42 as unknown as string, file: null })).toBe('string');
    }
  });

  it('absent graph → the exact enable command, never an error', () => {
    const tools = agentTools({ cwd: tmpRepo(), detail: false }, noGit);
    const out = tools.find((t) => t.name === 'function_callers')!.run({ symbol: 'main' });
    expect(out).toContain('vyuh-dxkit describe');
    expect(out).toContain('not set up');
  });
});

describe('agent tools — graph point queries', () => {
  it('resolves callers/callees by symbol name and suggests on a miss', () => {
    const cwd = tmpRepo();
    writeGraph(cwd);
    const tools = agentTools({ cwd, detail: false }, noGit);
    const callers = tools.find((t) => t.name === 'function_callers')!;
    expect(callers.run({ symbol: 'logger' })).toContain('helper()');
    expect(callers.run({ symbol: 'logger()' })).toContain('helper()');
    const callees = tools.find((t) => t.name === 'function_callees')!;
    expect(callees.run({ symbol: 'main' })).toContain('helper()');
    // Miss → did-you-mean, not an error.
    expect(callers.run({ symbol: 'logr' })).toContain('logger');
  });

  it('file_blast_radius reports symbols + reaching tests, and guards paths', () => {
    const cwd = tmpRepo();
    writeGraph(cwd);
    const blast = agentTools({ cwd, detail: false }, noGit).find(
      (t) => t.name === 'file_blast_radius',
    )!;
    const out = blast.run({ file: 'src/c.ts' });
    expect(out).toContain('logger()');
    expect(out).toContain('test/a.test.ts');
    for (const bad of ['../etc/passwd', '/etc/passwd', '-rf', 'a\0b']) {
      expect(blast.run({ file: bad })).toContain('Invalid file path');
    }
  });
});

describe('agent tools — history/ownership privacy tiers', () => {
  const gitLog: GitRunner = (args) =>
    args[0] === 'log'
      ? 'Ada Contributor\x1f2026-08-01T00:00:00Z\x1ffix parser\nBo Author\x1f2026-07-01T00:00:00Z\x1fadd parser'
      : '';

  it('file_history: counts and dates with detail off; names only with detail on', () => {
    const cwd = tmpRepo();
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x');
    const off = agentTools({ cwd, detail: false }, gitLog).find((t) => t.name === 'file_history')!;
    const outOff = off.run({ file: 'src/a.ts' });
    expect(outOff).toContain('2 recent commit(s) by 2 author(s)');
    expect(outOff).not.toContain('Ada Contributor');
    expect(outOff).toContain('detail toggle');
    const on = agentTools({ cwd, detail: true }, gitLog).find((t) => t.name === 'file_history')!;
    expect(on.run({ file: 'src/a.ts' })).toContain('Ada Contributor');
  });

  it('file_owners: no git signal reads as such (and never throws)', () => {
    const cwd = tmpRepo();
    const owners = agentTools({ cwd, detail: false }, noGit).find((t) => t.name === 'file_owners')!;
    expect(owners.run({ file: 'src/a.ts' })).toContain('No git ownership signal');
  });
});

describe('agent tools — debt findings', () => {
  it('lists baseline findings with kind/file filters; absent baseline points at the remedy', () => {
    const cwd = tmpRepo();
    const before = agentTools({ cwd, detail: false }, noGit).find(
      (t) => t.name === 'debt_findings',
    )!;
    expect(before.run({})).toContain('No committed baseline');
    writeBaseline(cwd);
    const tool = agentTools({ cwd, detail: false }, noGit).find((t) => t.name === 'debt_findings')!;
    const all = tool.run({});
    expect(all).toContain('2 grandfathered finding(s)');
    expect(all).toContain('src/config.ts:42');
    expect(all).toContain('[high]');
    const secrets = tool.run({ kind: 'secret' });
    expect(secrets).toContain('1 grandfathered finding(s)');
    expect(secrets).not.toContain('src/other.ts');
    expect(tool.run({ kind: 'dep-vuln' })).toContain('No grandfathered findings match');
  });
});
