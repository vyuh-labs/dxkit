/**
 * Integration tests for src/baseline/dup-gate-check.ts — the additive,
 * fail-open structural-duplicate (seam) gate over a real ref-based comparison.
 *
 * The duplicate-findings provider is INJECTED (the real one reads the whole
 * source tree via tree-sitter), so these tests pin the two-ref gate LOGIC
 * deterministically: opt-in gating, trigger-skip, net-new grandfathering against
 * the base ref, directional `changed` marking, allowlist suppression, and
 * fail-open — over a genuine `git` worktree. The detector + extractor are pinned
 * separately in test/analyzers/duplication/.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateDupGateForGuardrail } from '../../src/baseline/dup-gate-check';
import type { DuplicateFinding } from '../../src/analyzers/duplication/findings';
import { computeCodeReimplementationFingerprint } from '../../src/analyzers/tools/fingerprint';
import type { AllowlistFile } from '../../src/allowlist/file';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** The copy-paste finding the gate would mint for the two divisions handlers —
 *  identity is the canonical fingerprint over the sorted anchor pair. */
function dupFinding(): DuplicateFinding {
  const a = { file: 'src/api/divisions.ts', symbol: 'GET', line: 10 };
  const b = { file: 'src/api/cli/divisions.ts', symbol: 'GET', line: 12 };
  return { id: computeCodeReimplementationFingerprint(a, b), anchors: [a, b], score: 1 };
}

type Provider = (
  dir: string,
  opts: { minScore: number; focusFiles?: ReadonlySet<string> },
) => Promise<DuplicateFinding[]>;

/** A provider returning `head` findings for the working tree (cwd) and `base`
 *  findings for anything else (the ref worktree). */
function provider(head: DuplicateFinding[], base: DuplicateFinding[], cwd: string): Provider {
  return async (dir) => (dir === cwd ? head : base);
}

/** A repo with the seam gate enabled, a source file touched by the HEAD change,
 *  committed on `main` as the base. */
function makeRepo(mode: 'warn' | 'block' | 'off' = 'warn'): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-dupgate-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify({ duplication: { mode } }));
  mkdirSync(join(dir, 'src', 'api', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'src', 'api', 'divisions.ts'), 'export const GET = () => {};\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  // The PR change: add a new source file (a CLI variant), so the diff touches source.
  writeFileSync(join(dir, 'src', 'api', 'cli', 'divisions.ts'), 'export const GET = () => {};\n');
  return { dir, baseSha };
}

describe('evaluateDupGateForGuardrail — two-ref seam gate', () => {
  it('skips at zero cost when policy mode is off (no scan)', async () => {
    const { dir, baseSha } = makeRepo('off');
    let called = false;
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherDuplicates: async () => {
        called = true;
        return [];
      },
    });
    expect(out.skipped).toBe('off');
    expect(called).toBe(false);
  });

  it('flags a NET-NEW duplicate the diff introduced (absent at base)', async () => {
    const { dir, baseSha } = makeRepo('warn');
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      // HEAD has the duplicate; base had only the original handler, none.
      gatherDuplicates: provider([dupFinding()], [], dir),
    });
    expect(out.ran).toBe(true);
    expect(out.warns).toBe(true);
    expect(out.blocks).toBe(false); // a lone duplicate never blocks
    expect(out.findings).toHaveLength(1);
    expect(out.mode).toBe('warn');
    // The gate marks WHICH anchor the change introduced (the added CLI variant),
    // so remediation is directional. The base file is not in the changed set.
    const f = out.findings[0];
    expect(f.changed).toBeDefined();
    const changedAnchor = f.anchors.find((_, i) => f.changed![i]);
    const unchangedAnchor = f.anchors.find((_, i) => !f.changed![i]);
    expect(changedAnchor?.file).toBe('src/api/cli/divisions.ts');
    expect(unchangedAnchor?.file).toBe('src/api/divisions.ts');
  });

  it('GRANDFATHERS a duplicate present at BOTH refs (never blocks pre-existing debt)', async () => {
    const { dir, baseSha } = makeRepo('warn');
    // The SAME duplicate exists at head AND base → not net-new.
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherDuplicates: provider([dupFinding()], [dupFinding()], dir),
    });
    expect(out.warns).toBe(false);
    expect(out.findings).toHaveLength(0);
    // It RAN the base comparison and grandfathered the pre-existing pair —
    // not a skip, just zero net-new.
    expect(out.ran).toBe(true);
    expect(out.skipped).toBeUndefined();
  });

  it('never scans the base ref when HEAD has no candidate (the cost guard)', async () => {
    const { dir, baseSha } = makeRepo('warn');
    let baseScanned = false;
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherDuplicates: async (d: string) => {
        if (d !== dir) baseScanned = true;
        return []; // HEAD has no duplicate
      },
    });
    expect(out.skipped).toBe('no-candidates');
    expect(baseScanned).toBe(false);
  });

  it('fail-opens (skips, never throws) when the scan throws', async () => {
    const { dir, baseSha } = makeRepo('warn');
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      gatherDuplicates: async () => {
        throw new Error('unparseable tree');
      },
    });
    expect(out.skipped).toBe('error');
    expect(out.blocks).toBe(false);
  });

  it('an active code-reimplementation allowlist entry waives the finding', async () => {
    const { dir, baseSha } = makeRepo('warn');
    const id = dupFinding().id;
    const allowlist: AllowlistFile = {
      version: 1,
      entries: [
        {
          fingerprint: id,
          kind: 'code-reimplementation',
          category: 'false-positive',
          reason: 'sanctioned parallel',
          addedAt: '2026-01-01T00:00:00Z',
        },
      ],
    } as unknown as AllowlistFile;
    const out = await evaluateDupGateForGuardrail({
      cwd: dir,
      baseRef: baseSha,
      allowlist,
      gatherDuplicates: provider([dupFinding()], [], dir),
    });
    expect(out.warns).toBe(false);
    expect(out.findings).toHaveLength(0);
    expect(out.suppressed).toHaveLength(1);
    expect(out.suppressed[0].fingerprint).toBe(id);
  });
});
