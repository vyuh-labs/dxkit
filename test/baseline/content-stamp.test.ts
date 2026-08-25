/**
 * Content-hash stamping for custom-check findings: identity that survives a
 * whole-file reformat (design section E).
 *
 * The scenario that shipped: a repo with a grandfathered lint backlog reindents
 * one file from 4 spaces to 2. Every line moves past the 3-line identity
 * window AND every line is rewritten in the diff (so the git-aware line map has
 * no image for it). The only matcher pass that can pair the finding with its
 * moved self is the content-hash pass, which normalizes whitespace, and it
 * never fired for lint because the custom-check producer stamped no hash.
 *
 * This file pins:
 *   - the producer stamps a located custom-check entry through the shared
 *     `contentStamper` and leaves a binary one unstamped;
 *   - the matcher pairs the reindented finding via `content-hash` at
 *     confidence 0.80 with zero `added`;
 *   - a genuinely new finding on a new line is still `added` (the negative);
 *   - an unstamped (pre-scheme) baseline degrades to the old behavior instead
 *     of throwing (migration contract, no rescan);
 *   - the arch-check rule that keeps stamping to one module actually bites.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { customCheckFindingsToBaselineEntries } from '../../src/baseline/producers/custom-checks';
import { entriesToLocated } from '../../src/baseline/entry-to-located';
import { gitAwareMatch, CONFIDENCE_CONTENT_HASH } from '../../src/baseline/git-aware-match';
import { contentStamper, contentStampSource } from '../../src/baseline/content-stamp';
import { computeContentHash } from '../../src/baseline/content-hash';
import type { CustomCheckFinding } from '../../src/analyzers/custom-checks/types';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-content-stamp-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function commit(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

const FILE = 'src/handlers.ts';

/**
 * A 4-space-indented file whose lint finding (`console.log`) sits on line 46.
 * The first 40 lines carry five double-blank-line gaps that a formatter
 * collapses, so the reformatted file has the same finding on line 41: moved
 * by five lines (past the 3-line identity window) AND reindented (every line
 * rewritten in the diff). The 7-line window around the finding has no blank
 * lines, so its whitespace-normalized content is identical on both sides.
 */
function fourSpaceSource(): string {
  const out: string[] = [];
  // Lines 1-40: eight 5-line blocks, each followed by a double blank (which the
  // reformat collapses to a single blank). 8 blocks x 5 = 40 lines.
  for (let b = 0; b < 8; b++) {
    if (b < 5) {
      out.push(`export function helper${b}(x: number): number {`);
      out.push(`    return x + ${b};`);
      out.push(`}`);
      out.push(``);
      out.push(``);
    } else {
      out.push(`export function helper${b}(x: number): number {`);
      out.push(`    const y = x * ${b};`);
      out.push(`    return y;`);
      out.push(`}`);
      out.push(``);
    }
  }
  // Lines 41-50: the function that carries the finding on line 46.
  out.push(`export function handle(req: Request): Response {`); // 41
  out.push(`    const id = req.id;`); // 42
  out.push(`    if (!id) {`); // 43
  out.push(`        return notFound();`); // 44
  out.push(`    }`); // 45
  out.push(`    console.log(id);`); // 46: the finding // slop-ok
  out.push(`    return ok(id);`); // 47
  out.push(`}`); // 48
  out.push(``); // 49
  out.push(`export const VERSION = 1;`); // 50
  return out.join('\n') + '\n';
}

/** The formatter's output: 2-space indentation, double blanks collapsed. */
function reformat(src: string): string {
  return src
    .replace(/\n\n\n/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/^( {4})+/, (m) => ' '.repeat(m.length / 2)))
    .join('\n');
}

function lintFinding(line: number, over: Partial<CustomCheckFinding> = {}): CustomCheckFinding {
  return {
    check: 'lint:typescript',
    blocking: true,
    file: FILE,
    line,
    rule: 'no-console',
    message: 'Unexpected console statement',
    ...over,
  };
}

describe('custom-check content-hash stamping (reformat survival)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
    mkdirSync(join(dir, 'src'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the producer stamps a located entry through the shared stamper; a binary entry stays bare', () => {
    const src = fourSpaceSource();
    writeFileSync(join(dir, FILE), src);
    commit(dir, 'backlog');
    const [located, binary] = customCheckFindingsToBaselineEntries(
      [lintFinding(46), { check: 'check:seam', blocking: true, message: 'boom' }],
      { cwd: dir },
    );
    expect(located.kind === 'custom-check' && located.contentHash).toBe(
      computeContentHash(src, 46),
    );
    expect(binary.kind === 'custom-check' && binary.contentHash).toBeUndefined();
    // No source (a producer running without a repo path): the same producer
    // stamps nothing, no branch needed.
    const [bare] = customCheckFindingsToBaselineEntries([lintFinding(46)]);
    expect(bare.kind === 'custom-check' && bare.contentHash).toBeUndefined();
    expect(contentStampSource({ cwd: '' })).toBeUndefined();
    expect(contentStampSource({ cwd: dir })).toEqual({ cwd: dir });
  });

  it('a 4-space to 2-space reindent pairs the moved finding via content-hash at 0.80, zero added', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    // The baseline side stamps the tree it scanned (the 4-space one).
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)], { cwd: dir });
    const after = reformat(before);
    expect(after.split('\n')[40]).toBe('  console.log(id);'); // line 41 now // slop-ok
    writeFileSync(join(dir, FILE), after);
    const head = commit(dir, 'reformat to 2 spaces');
    const current = customCheckFindingsToBaselineEntries([lintFinding(41)], { cwd: dir });
    // The shift crossed the 3-line identity window: the fingerprints differ,
    // so only a locator-aware pass can pair them.
    expect(prior[0].id).not.toBe(current[0].id);

    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.pairs).toHaveLength(1);
    const [pair] = result.pairs;
    expect(pair.status).toBe('persisted');
    expect(pair.confidence).toBe(CONFIDENCE_CONTENT_HASH);
    expect(CONFIDENCE_CONTENT_HASH).toBe(0.8);
    expect(pair.reasons.map((r) => r.code)).toEqual(['content-hash']);
  });

  it('a genuinely new finding on a new line after the reformat is still added', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)], { cwd: dir });
    // Reformat AND introduce a second console.log at the top of `handle`.
    const after = reformat(before).replace(
      '  const id = req.id;\n',
      '  const id = req.id;\n  console.log("entered");\n', // slop-ok
    );
    writeFileSync(join(dir, FILE), after);
    const head = commit(dir, 'reformat + new finding');
    const newLine = after.split('\n').findIndex((l) => l.includes('"entered"')) + 1;
    const movedLine = after.split('\n').findIndex((l) => l === '  console.log(id);') + 1; // slop-ok
    expect(newLine).toBe(38);
    expect(movedLine).toBe(42);

    const current = customCheckFindingsToBaselineEntries(
      [lintFinding(newLine), lintFinding(movedLine)],
      { cwd: dir },
    );
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    const movedId = current.find((e) => e.kind === 'custom-check' && e.line === movedLine)!.id;
    const newId = current.find((e) => e.kind === 'custom-check' && e.line === newLine)!.id;
    const matched = result.pairs.filter((p) => p.priorId !== undefined);
    expect(matched.map((p) => p.currentId)).toEqual([movedId]);
    expect(matched[0].reasons.map((r) => r.code)).toEqual(['content-hash']);
    expect(result.added).toEqual([newId]);
    expect(result.removed).toEqual([]);
  });

  it('an UNCOMMITTED reformat (the Stop-gate / pre-push tree) still pairs: the stamp reads the tree the scan read', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)], { cwd: dir });
    // Reformat in place, no commit: the current scan sees line 41 in a dirty tree.
    writeFileSync(join(dir, FILE), reformat(before));
    const current = customCheckFindingsToBaselineEntries([lintFinding(41)], { cwd: dir });
    expect(current[0].kind === 'custom-check' && current[0].contentHash).toBe(
      prior[0].kind === 'custom-check' ? prior[0].contentHash : 'unstamped',
    );
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: base,
    });
    expect(result.added).toEqual([]);
    expect(result.pairs.map((p) => p.reasons.map((r) => r.code))).toEqual([['content-hash']]);
  });

  it('a same-rule finding newly introduced at the old line is NOT paired as persisted on a dirty tree', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    commit(dir, 'backlog at 4 spaces');
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)], { cwd: dir });
    // Delete the finding's line and put a DIFFERENT console statement at line 46,
    // uncommitted. Hashing the committed tree at line 46 would reproduce the prior
    // stamp and pair a net-new finding as persisted.
    const lines = before.split('\n');
    lines[45] = '    console.log("something else entirely", req, id, extra);'; // slop-ok
    lines.splice(30, 0, '    // a comment shifting the window content');
    writeFileSync(join(dir, FILE), lines.join('\n'));
    const current = customCheckFindingsToBaselineEntries([lintFinding(46)], { cwd: dir });
    expect(current[0].kind === 'custom-check' && current[0].contentHash).not.toBe(
      prior[0].kind === 'custom-check' ? prior[0].contentHash : 'unstamped',
    );
  });

  it('the content pass prefers a same-file candidate over an identical window in another file', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)], { cwd: dir });
    // A copy of the file appears under a new path, and the original is reformatted.
    const twin = 'src/legacy-copy.ts';
    writeFileSync(join(dir, twin), reformat(before));
    writeFileSync(join(dir, FILE), reformat(before));
    const head = commit(dir, 'reformat + copy');
    const current = customCheckFindingsToBaselineEntries(
      [{ ...lintFinding(41), file: twin }, lintFinding(41)],
      { cwd: dir },
    );
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    const paired = result.pairs.find((p) => p.priorId !== undefined)!;
    const sameFileId = current.find((e) => e.kind === 'custom-check' && e.file === FILE)!.id;
    expect(paired.currentId).toBe(sameFileId);
    expect(paired.status).toBe('persisted');
  });

  it('a pre-scheme baseline (no hash on the prior side) degrades to the old behavior, never throws', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    writeFileSync(join(dir, FILE), reformat(before));
    const head = commit(dir, 'reformat to 2 spaces');
    // An entry written before the stamp existed: same shape, no contentHash.
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)]);
    expect(prior[0].kind === 'custom-check' && prior[0].contentHash).toBeUndefined();
    const current = customCheckFindingsToBaselineEntries([lintFinding(41)], { cwd: dir });
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    // Whatever the git passes make of the rewritten line, no pair may claim
    // the content-hash reason: there was no hash to compare.
    for (const p of result.pairs) {
      expect(p.reasons.map((r) => r.code)).not.toContain('content-hash');
    }
    expect(result.pairs.length + result.added.length).toBe(1);
  });
});

describe('contentStamper (the one stamping policy)', () => {
  it('never stamps without a source, on a whole-file line 0, outside the tree, or on an unreadable file', () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
      expect(contentStamper(undefined)('a.txt', 2)).toBeUndefined();
      expect(contentStamper({ cwd: '' })('a.txt', 2)).toBeUndefined();
      // No commit is needed: the tree is the source (an unborn HEAD still stamps).
      const stamp = contentStamper({ cwd: dir });
      expect(stamp('a.txt', 0)).toBeUndefined();
      expect(stamp('missing.txt', 2)).toBeUndefined();
      expect(stamp('..' + '/outside.txt', 2)).toBeUndefined();
      expect(stamp(join(dir, 'a.txt'), 2)).toBeUndefined();
      expect(stamp('a.txt', 2)).toBe(computeContentHash('one\ntwo\nthree\n', 2));
      // Per-stamper file cache: a rewrite after the first read is not observed
      // (a producer stamps one scan of one tree; the next scan builds a new stamper).
      writeFileSync(join(dir, 'a.txt'), 'changed\ntwo\nthree\n');
      expect(stamp('a.txt', 2)).toBe(computeContentHash('one\ntwo\nthree\n', 2));
      expect(contentStamper({ cwd: dir })('a.txt', 2)).toBe(
        computeContentHash('changed\ntwo\nthree\n', 2),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arch-check: a second stamping call site is rejected', () => {
  it('scripts/check-architecture.sh flags computeContentHash() outside content-stamp.ts', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const rogueRoot = mkdtempSync(join(tmpdir(), 'dxkit-rogue-stamp-'));
    try {
      mkdirSync(join(rogueRoot, 'producers'), { recursive: true });
      writeFileSync(
        join(rogueRoot, 'producers', 'rogue.ts'),
        "import { computeContentHash } from '../content-hash';\n" +
          'export const h = computeContentHash(content, line);\n',
      );
      // The gate reads its scan root from the environment so the rule can be
      // proven to bite without planting a file inside src/.
      const run = spawnSync('bash', ['scripts/check-architecture.sh'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, CONTENT_STAMP_SCAN_ROOT: rogueRoot },
      });
      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain('Content-stamp violation');
      expect(run.stdout + run.stderr).toContain('producers/rogue.ts');
    } finally {
      rmSync(rogueRoot, { recursive: true, force: true });
    }
  });
});
