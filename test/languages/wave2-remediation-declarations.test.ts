/**
 * The wave-2 declaration shapes (4.4.7 V3): the JVM packs share ONE
 * dependency-exemption set (Rule 2, jvm-remediation.ts), kotlin's lintFix
 * rides the ktlint fixCommand while java's dormant gate stays exempt, and
 * csharp + swift carry reasoned exemptions for all four capabilities.
 * Every exemption is a full sentence naming why (the declared-exemption
 * discipline: a reason, never silence).
 */
import { describe, it, expect } from 'vitest';
import { getLanguage } from '../../src/languages';
import {
  REMEDIATION_CAPABILITY_IDS,
  type RemediationSupport,
} from '../../src/languages/capabilities/remediation';

const java = getLanguage('java')!;
const kotlin = getLanguage('kotlin')!;
const csharp = getLanguage('csharp')!;
const swift = getLanguage('swift')!;
const go = getLanguage('go')!;

describe('the shared JVM remediation exemptions (Rule 2 parity)', () => {
  it('java and kotlin state ONE reason per dependency capability', () => {
    for (const capability of ['resyncLockfile', 'pinTransitive', 'declareDependency'] as const) {
      const j = java.remediation[capability];
      const k = kotlin.remediation[capability];
      expect(j.kind).toBe('exemption');
      expect(k.kind).toBe('exemption');
      if (j.kind === 'exemption' && k.kind === 'exemption') {
        expect(j.reason).toBe(k.reason);
      }
    }
  });

  it('kotlin lintFix is a capability riding a real ktlint fixCommand; java stays exempt (dormant gate)', () => {
    expect(kotlin.remediation.lintFix.kind).toBe('capability');
    const fix = kotlin.lintGate?.fixCommand?.({ cwd: process.cwd(), files: ['src/A.kt'] });
    // Resolvable only where ktlint is installed; the SHAPE is what the
    // rider contract pins, so assert it when the tool resolves.
    if (fix) {
      expect(fix.bin).toContain('ktlint');
      expect(fix.args).toContain('-F');
      expect(fix.args).toContain('src/A.kt');
      expect(fix.parse.kind).toBe('structured');
    }
    // An empty file scope never spawns a fixer.
    expect(kotlin.lintGate?.fixCommand?.({ cwd: process.cwd(), files: [] })).toBeNull();

    expect(java.remediation.lintFix.kind).toBe('exemption');
    if (java.remediation.lintFix.kind === 'exemption') {
      expect(java.remediation.lintFix.reason).toContain('dormant');
    }
  });
});

describe('go lintFix rides golangci-lint --fix (the rider over the gate)', () => {
  it('the fix command scopes to the order files and reuses the gate parser', () => {
    const fix = go.lintGate?.fixCommand?.({ cwd: process.cwd(), files: ['pkg/a.go'] });
    if (fix) {
      expect(fix.args).toContain('--fix');
      expect(fix.args).toContain('pkg/a.go');
      expect(fix.parse.kind).toBe('structured');
    }
    expect(go.lintGate?.fixCommand?.({ cwd: process.cwd(), files: [] })).toBeNull();
  });
});

describe('csharp and swift: reasoned exemptions across the board', () => {
  it.each([
    ['csharp', csharp.remediation],
    ['swift', swift.remediation],
  ] as Array<[string, RemediationSupport]>)('%s states a full reason per capability', (id, r) => {
    for (const capability of REMEDIATION_CAPABILITY_IDS) {
      const declaration = r[capability];
      expect(declaration.kind, `${id}.${String(capability)}`).toBe('exemption');
      if (declaration.kind === 'exemption') {
        expect(declaration.reason.length, `${id}.${String(capability)} reason`).toBeGreaterThan(40);
        expect(declaration.reason).toContain('agent tier');
      }
    }
  });

  it('the reasons name the mechanism gap, not a placeholder', () => {
    const cs = csharp.remediation;
    if (cs.pinTransitive.kind === 'exemption') {
      expect(cs.pinTransitive.reason).toContain('XML');
    }
    const sw = swift.remediation;
    if (sw.pinTransitive.kind === 'exemption') {
      expect(sw.pinTransitive.reason).toContain('override mechanism');
    }
    if (sw.resyncLockfile.kind === 'exemption') {
      expect(sw.resyncLockfile.reason).toContain('Package.resolved');
    }
  });
});
