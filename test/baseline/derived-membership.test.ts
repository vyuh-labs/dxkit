/**
 * The #25 class — derived-membership attribution (4.3.7).
 *
 * The live incident: a remediation agent's lint sweep removed unused
 * relative imports across 321 files; six files — two never touched by the
 * diff, the rest edited trivially — fell out of the test files' 3-hop
 * import-graph reachable set and were BLOCKED as net-new test gaps.
 * Reproduced 6/6 on the customer tree: on the base tree all six were
 * credited "tested" solely by reachability over DEAD (unused) import edges;
 * removing the dead imports contracted the reachable set. The files were
 * untested all along — only dxkit's visibility changed (Rule 19 causes
 * #3/#6, never cause #1 "the developer introduced it").
 *
 * The law this pins: for a kind whose per-file membership is DERIVED from
 * repo-global signals (`DERIVED_MEMBERSHIP_KINDS`), an `added` finding
 * keeps developer attribution only when its FILE was added by the diff. An
 * edit cannot introduce a test gap. Alongside it, two structural repairs:
 * `newUntestedChangedSource` gets a predicate that can actually fire (the
 * overlapsChangedLines form was structurally dead — test-gap findings carry
 * no line), and the v3 identity scheme stops hashing the threshold-derived
 * risk tier (Rule 9: a reformat across the 500-line boundary minted a fresh
 * fingerprint).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { classify } from '../../src/baseline/classify';
import type { ClassifyContext } from '../../src/baseline/classify';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import type { BrownfieldPolicy } from '../../src/baseline/policy';
import type { MatchPair } from '../../src/baseline/types';
import { DERIVED_MEMBERSHIP_KINDS } from '../../src/baseline/gather-scope';
import { computeAddedFiles } from '../../src/baseline/changed-files';
import { identityFor } from '../../src/baseline/finding-identity';
import { CURRENT_IDENTITY_SCHEME } from '../../src/baseline/types';

const addedPair: MatchPair = {
  currentId: 'gap0000000000000a',
  status: 'added',
  confidence: 1,
  reasons: [{ code: 'no-prior-match', detail: 'not in baseline' }],
};

function ctx(extra: Partial<ClassifyContext>): ClassifyContext {
  return { kind: 'test-gap', severity: 'medium', ...extra };
}

/** The incident posture: everything `added` blocks (the customer policy). */
const BLOCK_ALL: BrownfieldPolicy = { ...DEFAULT_BROWNFIELD_POLICY, block: ['added'] };

describe('classify — derived-membership attribution (the #25 class)', () => {
  it('declares test-gap as a derived-membership kind', () => {
    expect(DERIVED_MEMBERSHIP_KINDS.has('test-gap')).toBe(true);
  });

  it('a net-new test-gap on a file the diff did NOT add demotes to uncertain (warn, never block) — even under block-everything', () => {
    const out = classify(
      addedPair,
      BLOCK_ALL,
      ctx({ derivedMembership: true, fileAddedInDiff: false }),
    );
    expect(out.status).toBe('uncertain');
    expect(out.blocks).toBe(false);
    expect(out.warns).toBe(true);
    const reason = out.reasons.find((r) => r.code === 'derived-membership-shift');
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain('an edit cannot introduce');
  });

  it('a test-gap on a file the diff ADDED keeps developer attribution and blocks', () => {
    const out = classify(
      addedPair,
      BLOCK_ALL,
      ctx({ derivedMembership: true, fileAddedInDiff: true }),
    );
    expect(out.status).toBe('added');
    expect(out.blocks).toBe(true);
  });

  it('UNKNOWN added-set (attribution unavailable) never demotes — conservative added', () => {
    const out = classify(addedPair, BLOCK_ALL, ctx({ derivedMembership: true }));
    expect(out.status).toBe('added');
  });

  it('a non-derived kind is untouched by the flags', () => {
    const out = classify(
      addedPair,
      BLOCK_ALL,
      { kind: 'secret', fileAddedInDiff: false }, // no derivedMembership
    );
    expect(out.status).toBe('added');
    expect(out.blocks).toBe(true);
  });

  it('recall drift still outranks derived-membership (the more specific Rule 19 signal)', () => {
    const out = classify(
      addedPair,
      DEFAULT_BROWNFIELD_POLICY,
      ctx({ recallDrifted: true, derivedMembership: true, fileAddedInDiff: false }),
    );
    expect(out.status).toBe('tooling_drift');
  });
});

describe('newUntestedChangedSource — resurrected on the added-file predicate', () => {
  const armed: BrownfieldPolicy = {
    ...DEFAULT_BROWNFIELD_POLICY,
    block: [],
    blockRules: { ...DEFAULT_BROWNFIELD_POLICY.blockRules, newUntestedChangedSource: true },
  };

  it('fires on a test-gap whose file the diff added', () => {
    const out = classify(addedPair, armed, ctx({ derivedMembership: true, fileAddedInDiff: true }));
    expect(out.blocks).toBe(true);
    expect(out.reasons.some((r) => r.detail.includes('newUntestedChangedSource'))).toBe(true);
  });

  it('never fires on an edited or untouched file (the old predicate was structurally dead)', () => {
    const edited = classify(
      addedPair,
      armed,
      ctx({ derivedMembership: true, fileAddedInDiff: false }),
    );
    expect(edited.blocks).toBe(false);
    // The old overlapsChangedLines predicate must not resurrect: a test-gap
    // finding has no line, so overlap can never be computed for it.
    const overlap = classify(addedPair, armed, ctx({ overlapsChangedLines: true }));
    expect(overlap.blocks).toBe(false);
  });
});

describe('identity v3 — risk is no longer hashed for test-gap (Rule 9)', () => {
  it('current scheme is v3 and ignores the risk tier', () => {
    expect(CURRENT_IDENTITY_SCHEME).toBe('v3');
    const medium = identityFor({ kind: 'test-gap', file: 'src/a.ts', risk: 'medium' });
    const high = identityFor({ kind: 'test-gap', file: 'src/a.ts', risk: 'high' });
    expect(medium).toBe(high);
    expect(identityFor({ kind: 'test-gap', file: 'src/b.ts', risk: 'medium' })).not.toBe(medium);
  });

  it('the v2 formula is preserved byte-for-byte for migration (risk-discriminated)', () => {
    const v2medium = identityFor({ kind: 'test-gap', file: 'src/a.ts', risk: 'medium' }, 'v2');
    const v2high = identityFor({ kind: 'test-gap', file: 'src/a.ts', risk: 'high' }, 'v2');
    expect(v2medium).not.toBe(v2high);
    expect(v2medium).not.toBe(identityFor({ kind: 'test-gap', file: 'src/a.ts', risk: 'medium' }));
    // v1 and v2 share the test-gap formula (the kind only changed in v3).
    expect(identityFor({ kind: 'test-gap', file: 'src/a.ts', risk: 'medium' }, 'v1')).toBe(
      v2medium,
    );
  });

  it('v2 code identity behavior is unchanged in v3 (content anchor still consumed)', () => {
    const input = {
      kind: 'code' as const,
      tool: 'semgrep',
      rule: 'r',
      file: 'src/a.ts',
      line: 10,
      contentAnchor: 'const x = 1;',
    };
    expect(identityFor(input, 'v3')).toBe(identityFor(input, 'v2'));
    expect(identityFor(input, 'v1')).not.toBe(identityFor(input, 'v3'));
  });
});

describe('computeAddedFiles — the added-file projection', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-added-files-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'existing.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const baseSha = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  it('reports committed additions and untracked files; edits are NOT additions', () => {
    const base = baseSha();
    writeFileSync(join(repo, 'existing.js'), 'module.exports = 2;\n'); // edit
    writeFileSync(join(repo, 'committed-new.js'), 'x\n');
    execFileSync('git', ['add', 'committed-new.js'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: repo });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'untracked-new.js'), 'y\n');

    const added = computeAddedFiles(repo, base)!;
    expect(added.has('committed-new.js')).toBe(true);
    expect(added.has('src/untracked-new.js')).toBe(true);
    expect(added.has('existing.js')).toBe(false);
  });

  it('a rename is not an addition (rename-aware diff)', () => {
    const base = baseSha();
    execFileSync('git', ['mv', 'existing.js', 'renamed.js'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'rename'], { cwd: repo });
    const added = computeAddedFiles(repo, base)!;
    expect(added.has('renamed.js')).toBe(false);
  });

  it('fails to null on an unreachable base (UNKNOWN, never "nothing added")', () => {
    expect(computeAddedFiles(repo, 'deadbeef'.repeat(5))).toBeNull();
    expect(computeAddedFiles(repo, '')).toBeNull();
  });
});
