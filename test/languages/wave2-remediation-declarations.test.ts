/**
 * The wave-2 declaration shapes (4.4.7 V3): the JVM packs share ONE
 * dependency-exemption set (Rule 2, jvm-remediation.ts), kotlin's lintFix
 * rides the ktlint fixCommand while java's dormant gate stays exempt, and
 * csharp + swift carry reasoned exemptions for all four capabilities.
 * Every exemption is a full sentence naming why (the declared-exemption
 * discipline: a reason, never silence).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fixture repo whose .dxkit/tools.json points findTool at a bin dir of
 *  fake executables, so fixCommand SHAPES are testable on any host. */
function repoWithFakeTools(binaries: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-wave2-decl-'));
  cleanups.push(dir);
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of binaries) {
    fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  fs.mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dxkit', 'tools.json'), JSON.stringify({ probePaths: [bin] }));
  return dir;
}

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
    // The SHAPE assertions run unconditionally: the fixture plants a fake
    // ktlint binary on a user-configured probe path (.dxkit/tools.json),
    // so no host toolchain is needed.
    const cwd = repoWithFakeTools(['ktlint']);
    const fix = kotlin.lintGate?.fixCommand?.({ cwd, files: ['src/A.kt'] });
    expect(fix).toBeDefined();
    expect(fix!.bin).toContain('ktlint');
    expect(fix!.args).toEqual(['-F', '--reporter=json', 'src/A.kt']);
    expect(fix!.parse.kind).toBe('structured');
    // An empty file scope never spawns a fixer.
    expect(kotlin.lintGate?.fixCommand?.({ cwd, files: [] })).toBeNull();

    expect(java.remediation.lintFix.kind).toBe('exemption');
    if (java.remediation.lintFix.kind === 'exemption') {
      expect(java.remediation.lintFix.reason).toContain('dormant');
    }
  });
});

describe('go lintFix rides golangci-lint --fix (the rider over the gate)', () => {
  it('the fix command scopes to the files PACKAGE DIRECTORIES and reuses the gate parser', () => {
    const cwd = repoWithFakeTools(['golangci-lint']);
    const fix = go.lintGate?.fixCommand?.({ cwd, files: ['pkg/a.go', 'pkg/b.go', 'main.go'] });
    expect(fix).toBeDefined();
    // Directory scoping, never bare files: a single named file loads as
    // the whole package and sibling identifiers read as typecheck
    // leftovers, discarding real fixes on any multi-file package.
    expect(fix!.args).toEqual(['run', '--fix', '--out-format', 'json', './pkg', '.']);
    expect(fix!.parse.kind).toBe('structured');
    expect(go.lintGate?.fixCommand?.({ cwd, files: [] })).toBeNull();
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
