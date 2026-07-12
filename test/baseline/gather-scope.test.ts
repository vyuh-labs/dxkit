import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scopeForPolicy,
  scopeSignature,
  isFullScope,
  isEmptyScope,
  FULL_SCOPE,
  type GatherScope,
} from '../../src/baseline/gather-scope';
import type { BrownfieldPolicy } from '../../src/baseline/policy';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import { resolveLoopPolicy } from '../../src/loop/policy';
import { gatherCurrentScan } from '../../src/baseline/create';

/**
 * The gather scope is the load-bearing safety boundary for opt 1: it decides
 * which analyzers a guardrail run skips. A bug here either gathers too much
 * (no speedup) or — the dangerous direction — skips an analyzer whose finding
 * the policy CAN block on, silently changing a verdict. These tests pin both
 * the pure derivation and the observable effect on a real gather.
 */

/** A `security-only`-shaped policy: empty generic block list, security
 *  block-rules only. Mirrors `src/baseline/presets.ts`'s preset. */
const SECURITY_ONLY: BrownfieldPolicy = {
  ...DEFAULT_BROWNFIELD_POLICY,
  block: [],
  blockRules: {
    newSecret: true,
    newCriticalSecurity: true,
    newHighSecurity: true,
    newCriticalDependencyVulnerability: true,
    newHighReachableDependencyVulnerability: true,
    newMaliciousDependency: true,
    newUntestedChangedSource: false,
    newSevereQualityIssueInChangedFiles: false,
  },
};

describe('scopeForPolicy', () => {
  it('security-only enables ONLY the analyzers feeding its blockable kinds', () => {
    const s = scopeForPolicy(SECURITY_ONLY);
    expect(s.secrets).toBe(true); // newSecret
    expect(s.codePatterns).toBe(true); // newCritical/HighSecurity
    expect(s.depVulns).toBe(true); // newCritical/HighReachableDependency
    // Everything a security-only posture can never block on is skipped.
    expect(s.structural).toBe(false);
    expect(s.duplication).toBe(false);
    expect(s.lint).toBe(false);
    expect(s.coverage).toBe(false);
    expect(s.licenses).toBe(false);
    expect(s.imports).toBe(false);
    expect(s.testFramework).toBe(false);
    expect(s.cloc).toBe(false);
    expect(s.testGaps).toBe(false);
    expect(s.hygiene).toBe(false);
    expect(isFullScope(s)).toBe(false);
    expect(isEmptyScope(s)).toBe(false);
  });

  it('a non-empty generic block list (full-debt) forces FULL_SCOPE', () => {
    // full-debt blocks any `added` finding regardless of kind, so nothing
    // is safe to skip.
    const fullDebt: BrownfieldPolicy = { ...SECURITY_ONLY, block: ['added'] };
    expect(scopeForPolicy(fullDebt)).toEqual(FULL_SCOPE);
    expect(isFullScope(scopeForPolicy(fullDebt))).toBe(true);
  });

  it('the shipped full-debt loop preset derives FULL_SCOPE end-to-end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-scope-fd-'));
    try {
      process.env.DXKIT_LOOP_PRESET = 'full-debt';
      const { policy } = resolveLoopPolicy(dir);
      expect(isFullScope(scopeForPolicy(policy))).toBe(true);
    } finally {
      delete process.env.DXKIT_LOOP_PRESET;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the shipped security-only loop preset derives the security subset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-scope-so-'));
    try {
      process.env.DXKIT_LOOP_PRESET = 'security-only';
      const { policy } = resolveLoopPolicy(dir);
      const s = scopeForPolicy(policy);
      expect(s.secrets && s.codePatterns && s.depVulns).toBe(true);
      expect(s.testGaps || s.duplication || s.lint || s.structural).toBe(false);
    } finally {
      delete process.env.DXKIT_LOOP_PRESET;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * SAFETY CONTRACT: every block rule that can fire MUST pull at least one
   * analyzer into scope. If a future rule is added to `evaluateBlockRules`
   * without a matching scope branch, a security-only-style posture would
   * silently skip the analyzer that feeds it — a missed-finding bug. This
   * asserts each rule, toggled alone, yields a non-empty scope.
   */
  it('every block rule individually yields a non-empty scope (no silent skips)', () => {
    const rules = [
      'newSecret',
      'newCriticalSecurity',
      'newHighSecurity',
      'newCriticalDependencyVulnerability',
      'newHighReachableDependencyVulnerability',
      'newMaliciousDependency',
      'newUntestedChangedSource',
      'newSevereQualityIssueInChangedFiles',
    ] as const;
    for (const rule of rules) {
      const policy: BrownfieldPolicy = {
        ...DEFAULT_BROWNFIELD_POLICY,
        block: [],
        blockRules: {
          newSecret: false,
          newCriticalSecurity: false,
          newHighSecurity: false,
          newCriticalDependencyVulnerability: false,
          newHighReachableDependencyVulnerability: false,
          newMaliciousDependency: false,
          newUntestedChangedSource: false,
          newSevereQualityIssueInChangedFiles: false,
          [rule]: true,
        },
      };
      expect(isEmptyScope(scopeForPolicy(policy)), `rule ${rule} must scope in an analyzer`).toBe(
        false,
      );
    }
  });
});

describe('scopeSignature', () => {
  it('is "full" for the full scope and stable + distinct otherwise', () => {
    expect(scopeSignature(FULL_SCOPE)).toBe('full');
    const a = scopeForPolicy(SECURITY_ONLY);
    expect(scopeSignature(a)).toBe(scopeSignature(a)); // deterministic
    expect(scopeSignature(a)).not.toBe('full');
    const justSecrets: GatherScope = { ...a, codePatterns: false, depVulns: false };
    expect(scopeSignature(justSecrets)).not.toBe(scopeSignature(a));
  });
});

describe('scoped gather drops non-security analyzers (observable effect)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-scoped-gather-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    // An untested source file → the test-gap analyzer (no external binary,
    // filename-match fallback) produces a `test-gap` finding under a full
    // gather. A security-only scope skips that analyzer entirely.
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      'export function handler(req: unknown) {\n  return req;\n}\n',
    );
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('full scope produces test-gap findings; security-only scope does not', async () => {
    const full = await gatherCurrentScan({ cwd: dir });
    const scoped = await gatherCurrentScan({ cwd: dir, scope: scopeForPolicy(SECURITY_ONLY) });

    const kindsOf = (s: { findings: ReadonlyArray<{ kind: string }> }) =>
      new Set(s.findings.map((f) => f.kind));

    // The non-security analyzer ran (or at least could) under full scope...
    expect(kindsOf(full).has('test-gap')).toBe(true);
    // ...and is genuinely skipped under the security-only scope.
    expect(kindsOf(scoped).has('test-gap')).toBe(false);
    expect(kindsOf(scoped).has('test-file-degradation')).toBe(false);

    // The security pipeline still ran under the scoped gather — the
    // aggregate is present, so a real secret / SAST finding would still be
    // caught. (Empty here because the fixture has none.)
    expect(scoped.aggregate).toBeDefined();
    expect(Array.isArray(scoped.aggregate.findingsByCategory.secret)).toBe(true);
  });
});
