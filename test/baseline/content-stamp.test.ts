/**
 * Content-hash stamping (the reformat-survival layer) — unit level.
 *
 * What this file pins:
 *   1. the ONE stamping policy (`contentStamper`): working-tree read, split-
 *      lines cache, and every deliberate no-stamp case (no tree, line 0,
 *      escape, symlink, oversized, unreadable);
 *   2. the orchestrator-level `stampEntries`: located entries (as decided by
 *      `entryToLocated`, the projection the matcher pairs on) gain a hash,
 *      everything else passes through untouched;
 *   3. the producer's minimum-line rule: a bucket's stamped window does not
 *      depend on linter output order;
 *   4. the matcher's two-phase content pass: an uncommitted or committed
 *      reformat pairs PERSISTED at the same-file confidence tier, a genuinely
 *      new finding stays `added`, a same-file twin is never stolen cross-file
 *      regardless of prior order, and a git-detected rename outranks a
 *      same-old-path shim;
 *   5. `restampAtCommit`, the migrate lane's commit-anchored restamp for
 *      pre-scheme baselines;
 *   6. the arch-check gate on the hash primitive, proven to bite (including
 *      an aliased import), and proven not to fire on comments.
 *
 * The end-to-end guardrail run over a real backlog fixture lives in
 * `test/fixtures-analysis.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { customCheckFindingsToBaselineEntries } from '../../src/baseline/producers/custom-checks';
import { entriesToLocated } from '../../src/baseline/entry-to-located';
import {
  gitAwareMatch,
  CONFIDENCE_CONTENT_HASH,
  CONFIDENCE_CONTENT_HASH_SAME_FILE,
} from '../../src/baseline/git-aware-match';
import {
  contentStamper,
  restampAtCommit,
  stampEntries,
  CONTENT_STAMP_MAX_BYTES,
} from '../../src/baseline/content-stamp';
import { computeContentHash } from '../../src/baseline/content-hash';
import type { CustomCheckFinding } from '../../src/analyzers/custom-checks/types';
import type { RichBaselineEntry } from '../../src/baseline/types';

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

/** Producer output stamped the way the orchestrator stamps it. */
function stampedEntries(findings: CustomCheckFinding[], cwd: string): RichBaselineEntry[] {
  return stampEntries(customCheckFindingsToBaselineEntries(findings), cwd);
}

describe('contentStamper (the one stamping policy)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-stamper-'));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('never stamps without a tree, on line 0, outside the repo, or on an unreadable file', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    expect(contentStamper(undefined)('a.txt', 2)).toBeUndefined();
    expect(contentStamper('')('a.txt', 2)).toBeUndefined();
    const stamp = contentStamper(dir);
    expect(stamp('a.txt', 0)).toBeUndefined();
    expect(stamp('missing.txt', 2)).toBeUndefined();
    expect(stamp('../outside.txt', 2)).toBeUndefined();
    expect(stamp(resolve(dir, '..', 'outside.txt'), 2)).toBeUndefined();
    expect(stamp('a.txt', 2)).toBe(computeContentHash('one\ntwo\nthree\n', 2));
  });

  it('a file whose NAME begins with dots is inside the repo and stamps', () => {
    writeFileSync(join(dir, '..config.ts'), 'a\nb\nc\n');
    expect(contentStamper(dir)('..config.ts', 2)).toBe(computeContentHash('a\nb\nc\n', 2));
  });

  it('refuses symlinks: a committed link must not widen what dxkit reads', () => {
    writeFileSync(join(dir, 'real.txt'), 'secret\n');
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
    expect(contentStamper(dir)('link.txt', 1)).toBeUndefined();
    expect(contentStamper(dir)('real.txt', 1)).toBeDefined();
  });

  it('refuses a path whose PARENT is a symlink out of the repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dxkit-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside\n');
      symlinkSync(outside, join(dir, 'linkdir'));
      expect(contentStamper(dir)('linkdir/secret.txt', 1)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses files over the size cap', () => {
    writeFileSync(join(dir, 'big.txt'), Buffer.alloc(CONTENT_STAMP_MAX_BYTES + 1, 0x61));
    expect(contentStamper(dir)('big.txt', 1)).toBeUndefined();
  });

  it('caches per stamper: one scan reads one tree; the next scan builds a new stamper', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const stamp = contentStamper(dir);
    expect(stamp('a.txt', 2)).toBe(computeContentHash('one\ntwo\nthree\n', 2));
    writeFileSync(join(dir, 'a.txt'), 'changed\ntwo\nthree\n');
    expect(stamp('a.txt', 2)).toBe(computeContentHash('one\ntwo\nthree\n', 2));
    expect(contentStamper(dir)('a.txt', 2)).toBe(computeContentHash('changed\ntwo\nthree\n', 2));
  });
});

describe('stampEntries (orchestrator stamping via the located projection)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-stamp-entries-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, FILE), fourSpaceSource());
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('stamps every located entry, passes whole-file / binary / pre-stamped entries through', () => {
    const [located, binary] = customCheckFindingsToBaselineEntries([
      lintFinding(46),
      { check: 'check:seam', blocking: true, message: 'boom' },
    ]);
    const wholeFile: RichBaselineEntry = { id: 'f'.repeat(16), kind: 'large-file', file: FILE };
    const preStamped = {
      ...located,
      id: 'a'.repeat(16),
      contentHash: 'deadbeefdeadbeef',
    } as RichBaselineEntry;
    const out = stampEntries([located, binary, wholeFile, preStamped], dir);
    const hash = (e: RichBaselineEntry) => ('contentHash' in e ? e.contentHash : undefined);
    expect(hash(out[0])).toBe(computeContentHash(fourSpaceSource(), 46));
    expect(hash(out[1])).toBeUndefined();
    expect(hash(out[2])).toBeUndefined();
    expect(hash(out[3])).toBe('deadbeefdeadbeef');
    // No tree: everything passes through bare, no branch needed in callers.
    expect(stampEntries([located], undefined)[0]).toBe(located);
  });
});

describe('custom-check minimum-line rule (order-independent stamping window)', () => {
  it('two occurrences in one identity bucket record the minimum line in either order', () => {
    const a = customCheckFindingsToBaselineEntries([lintFinding(10), lintFinding(11)]);
    const b = customCheckFindingsToBaselineEntries([lintFinding(11), lintFinding(10)]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].kind === 'custom-check' && a[0].line).toBe(10);
    expect(b[0].kind === 'custom-check' && b[0].line).toBe(10);
    expect(a[0].id).toBe(b[0].id);
  });
});

describe('the content pass across a reformat', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
    mkdirSync(join(dir, 'src'), { recursive: true });
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('a committed reindent pairs PERSISTED at the same-file tier, zero added', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    const after = reformat(before);
    expect(after.split('\n')[40]).toBe('  console.log(id);'); // line 41 now // slop-ok
    writeFileSync(join(dir, FILE), after);
    const head = commit(dir, 'reformat to 2 spaces');
    const current = stampedEntries([lintFinding(41)], dir);
    // The shift crossed the 3-line identity window: fingerprints differ.
    expect(prior[0].id).not.toBe(current[0].id);

    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].status).toBe('persisted');
    expect(result.pairs[0].confidence).toBe(CONFIDENCE_CONTENT_HASH_SAME_FILE);
    expect(result.pairs[0].reasons.map((r) => r.code)).toEqual(['content-hash']);
  });

  it('an UNCOMMITTED reformat (Stop-gate / pre-push tree) still pairs: the stamp reads the scanned tree', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    writeFileSync(join(dir, FILE), reformat(before));
    const current = stampedEntries([lintFinding(41)], dir);
    const hash = (e: RichBaselineEntry) => ('contentHash' in e ? e.contentHash : undefined);
    expect(hash(current[0])).toBe(hash(prior[0]));
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: base,
    });
    expect(result.added).toEqual([]);
    expect(result.pairs.map((p) => p.reasons.map((r) => r.code))).toEqual([['content-hash']]);
  });

  it('a same-rule finding newly introduced at the old line hashes its OWN window, not the commit', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    // Uncommitted: delete the finding's line, put a DIFFERENT console statement
    // at line 46, and shift the window content. Hashing the committed tree at
    // line 46 would reproduce the prior stamp and pair a net-new finding.
    const lines = fourSpaceSource().split('\n');
    lines[45] = '    console.log("something else entirely", req, id, extra);'; // slop-ok
    lines.splice(30, 0, '    // a comment shifting the window content');
    writeFileSync(join(dir, FILE), lines.join('\n'));
    const current = stampedEntries([lintFinding(46)], dir);
    const hash = (e: RichBaselineEntry) => ('contentHash' in e ? e.contentHash : undefined);
    expect(hash(current[0])).not.toBe(hash(prior[0]));
  });

  it('a genuinely new finding after the reformat is still added', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    const after = reformat(before).replace(
      '  const id = req.id;\n',
      '  const id = req.id;\n  console.log("entered");\n', // slop-ok
    );
    writeFileSync(join(dir, FILE), after);
    const head = commit(dir, 'reformat + new finding');
    const newLine = after.split('\n').findIndex((l) => l.includes('"entered"')) + 1;
    const movedLine = after.split('\n').findIndex((l) => l === '  console.log(id);') + 1; // slop-ok
    const current = stampedEntries([lintFinding(newLine), lintFinding(movedLine)], dir);
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    const movedId = current.find((e) => e.kind === 'custom-check' && e.line === movedLine)!.id;
    const newId = current.find((e) => e.kind === 'custom-check' && e.line === newLine)!.id;
    const matched = result.pairs.filter((p) => p.priorId !== undefined);
    expect(matched.map((p) => p.currentId)).toEqual([movedId]);
    expect(result.added).toEqual([newId]);
  });

  it('phase 1 reserves same-file pairs: a deleted twin cannot steal one, in any prior order', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    writeFileSync(join(dir, 'src/gone.ts'), before);
    const base = commit(dir, 'backlog in two files');
    const prior = stampedEntries([lintFinding(46), lintFinding(46, { file: 'src/gone.ts' })], dir);
    // gone.ts is deleted; handlers.ts is reformatted. The only candidate is
    // handlers.ts's moved finding: it must pair with the handlers.ts prior
    // (same file), never with the gone.ts prior (cross-file), regardless of
    // which prior the matcher iterates first.
    rmSync(join(dir, 'src/gone.ts'));
    writeFileSync(join(dir, FILE), reformat(before));
    const head = commit(dir, 'reformat + delete twin');
    const current = stampedEntries([lintFinding(41)], dir);
    for (const priorOrder of [prior, [...prior].reverse()]) {
      const result = gitAwareMatch(entriesToLocated(priorOrder), entriesToLocated(current), {
        cwd: dir,
        baseSha: base,
        headSha: head,
      });
      const paired = result.pairs.filter(
        (p) => p.priorId !== undefined && p.currentId !== undefined,
      );
      expect(paired).toHaveLength(1);
      const samePrior = priorOrder.find((e) => e.kind === 'custom-check' && e.file === FILE)!;
      expect(paired[0].priorId).toBe(samePrior.id);
      expect(paired[0].status).toBe('persisted');
      expect(paired[0].confidence).toBe(CONFIDENCE_CONTENT_HASH_SAME_FILE);
    }
  });

  it('a git-detected rename outranks a cross-file window twin', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    // A real rename (old path deleted) plus a reformat. A NEW file shares only
    // the finding's 7-line window (the rest is unrelated), so git's rename
    // detection maps the old path to the REFORMATTED file, and the content
    // pass must follow that evidence rather than the window twin.
    execFileSync('git', ['mv', FILE, 'src/handlers-v2.ts'], { cwd: dir });
    writeFileSync(join(dir, 'src/handlers-v2.ts'), reformat(before));
    const windowOnly = [
      ...Array.from({ length: 40 }, (_, i) => `const unrelated${i} = ${i};`),
      ...reformat(before).split('\n').slice(37, 45),
    ].join('\n');
    writeFileSync(join(dir, 'src/twin.ts'), windowOnly + '\n');
    const head = commit(dir, 'rename + reformat + window twin');
    // git maps the rename to the reformatted file, not the twin.
    const status = execFileSync('git', ['diff', '--name-status', '--find-renames', base, head], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(status).toMatch(/R\d+\tsrc\/handlers\.ts\tsrc\/handlers-v2\.ts/);
    const twinLine = windowOnly.split('\n').findIndex((l) => l.includes('console.log(id)')) + 1; // slop-ok
    const current = stampedEntries(
      [
        lintFinding(41, { file: 'src/handlers-v2.ts' }),
        lintFinding(twinLine, { file: 'src/twin.ts' }),
      ],
      dir,
    );
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    const renamedId = current.find(
      (e) => e.kind === 'custom-check' && e.file === 'src/handlers-v2.ts',
    )!.id;
    const twinId = current.find((e) => e.kind === 'custom-check' && e.file === 'src/twin.ts')!.id;
    const paired = result.pairs.find((p) => p.priorId === prior[0].id);
    expect(paired?.currentId).toBe(renamedId);
    expect(result.added).toEqual([twinId]);
  });

  it('after a detected rename, a twin at the OLD path never gets the same-file tier', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    // Rename away (old path deleted in git terms is implied by mv), reformat
    // the renamed file, and put a NEW file with the identical window at the
    // OLD path. The renamed file's finding is fixed (absent), so the only
    // candidate is the old-path twin: it must NOT pair at the same-file tier.
    execFileSync('git', ['mv', FILE, 'src/handlers-v2.ts'], { cwd: dir });
    const fixed = reformat(before).replace('  console.log(id);\n', ''); // slop-ok
    writeFileSync(join(dir, 'src/handlers-v2.ts'), fixed);
    writeFileSync(join(dir, FILE), before);
    const head = commit(dir, 'rename + fix + twin at old path');
    const status = execFileSync('git', ['diff', '--name-status', '--find-renames', base, head], {
      cwd: dir,
      encoding: 'utf8',
    });
    // Only exercise the invariant when git actually saw the rename.
    if (/R\d+\tsrc\/handlers\.ts\tsrc\/handlers-v2\.ts/.test(status)) {
      const current = stampedEntries([lintFinding(46)], dir);
      const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
        cwd: dir,
        baseSha: base,
        headSha: head,
      });
      const contentPair = result.pairs.find(
        (p) => p.priorId === prior[0].id && p.reasons.some((r) => r.code === 'content-hash'),
      );
      if (contentPair) {
        expect(contentPair.confidence).toBe(CONFIDENCE_CONTENT_HASH);
        expect(contentPair.status).toBe('relocated');
      }
    }
  });

  it('a cross-file pair (no same-file candidate anywhere) keeps the lower confidence tier', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = stampedEntries([lintFinding(46)], dir);
    // The file's content moves wholesale to a new path git does NOT pair as a
    // rename (the old path gains unrelated content), so only the content pass
    // can follow it, cross-file.
    writeFileSync(join(dir, 'src/relocated.ts'), before);
    writeFileSync(join(dir, FILE), 'export const nothingHere = true;\n');
    const head = commit(dir, 'move content to a new path');
    const current = stampedEntries([lintFinding(46, { file: 'src/relocated.ts' })], dir);
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    const paired = result.pairs.find((p) => p.priorId === prior[0].id);
    expect(paired).toBeDefined();
    if (paired?.reasons.some((r) => r.code === 'content-hash')) {
      expect(paired.status).toBe('relocated');
      expect(paired.confidence).toBe(CONFIDENCE_CONTENT_HASH);
    }
  });

  it('a pre-scheme baseline (no hash on the prior side) degrades to the old behavior, never throws', () => {
    const before = fourSpaceSource();
    writeFileSync(join(dir, FILE), before);
    const base = commit(dir, 'backlog at 4 spaces');
    const prior = customCheckFindingsToBaselineEntries([lintFinding(46)]);
    expect(prior[0].kind === 'custom-check' && prior[0].contentHash).toBeUndefined();
    writeFileSync(join(dir, FILE), reformat(before));
    const head = commit(dir, 'reformat to 2 spaces');
    const current = stampedEntries([lintFinding(41)], dir);
    const result = gitAwareMatch(entriesToLocated(prior), entriesToLocated(current), {
      cwd: dir,
      baseSha: base,
      headSha: head,
    });
    for (const p of result.pairs) {
      expect(p.reasons.map((r) => r.code)).not.toContain('content-hash');
    }
    expect(result.pairs.length + result.added.length).toBe(1);
  });
});

describe('restampAtCommit (the migrate lane, pre-scheme baselines)', () => {
  it('stamps bare located entries at the anchor commit; unreadable files are counted, not thrown', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      const src = fourSpaceSource();
      writeFileSync(join(dir, FILE), src);
      const sha = commit(dir, 'anchor');
      // The tree moves on (reformat), but the baseline's lines describe the anchor.
      writeFileSync(join(dir, FILE), reformat(src));
      const bare = customCheckFindingsToBaselineEntries([
        lintFinding(46),
        lintFinding(3, { file: 'src/never-committed.ts' }),
      ]);
      const result = restampAtCommit(bare, dir, sha);
      expect(result.restamped).toBe(1);
      expect(result.unreadable).toBe(1);
      const [stamped, still] = result.entries;
      expect('contentHash' in stamped ? stamped.contentHash : undefined).toBe(
        computeContentHash(src, 46),
      );
      expect('contentHash' in still ? still.contentHash : undefined).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restampContentHashes (the update-lane wrapper)', () => {
  it('an unreachable anchor returns the disclosure summary and writes nothing', async () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, FILE), fourSpaceSource());
      commit(dir, 'anchor');
      const { restampContentHashes } = await import('../../src/baseline/migrate');
      const { BASELINE_SCHEMA_VERSION, pathForBaseline, writeBaselineFile, readBaselineFile } =
        await import('../../src/baseline/baseline-file');
      const blPath = pathForBaseline(dir, 'main');
      mkdirSync(join(dir, '.dxkit', 'baselines'), { recursive: true });
      const bare = customCheckFindingsToBaselineEntries([lintFinding(46)]);
      const base = {
        schemaVersion: BASELINE_SCHEMA_VERSION,
        name: 'main',
        createdAt: new Date().toISOString(),
        repo: { commitSha: '0'.repeat(40) },
        findings: bare,
      } as unknown as import('../../src/baseline/baseline-file').BaselineFile;
      writeBaselineFile(blPath, base);
      const summary = restampContentHashes(dir);
      expect(summary).toEqual({ restamped: 0, unreadable: 1 });
      const after = readBaselineFile(blPath);
      expect(
        'contentHash' in after.findings[0] ? after.findings[0].contentHash : undefined,
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arch-check: a second stamping call site is rejected', () => {
  it.each([
    [
      'direct call',
      "import { computeContentHash } from '../content-hash';\n" +
        'export const h = computeContentHash(content, line);\n',
    ],
    [
      'aliased import',
      "import { computeContentHash as windowHash } from '../content-hash';\n" +
        'export const h = windowHash(content, line);\n',
    ],
    [
      'FromLines variant',
      "import { computeContentHashFromLines } from '../content-hash';\n" +
        'export const h = computeContentHashFromLines(lines, line);\n',
    ],
  ])('flags computeContentHash outside content-stamp.ts (%s)', (_name, rogueSource) => {
    const repoRoot = resolve(__dirname, '..', '..');
    const rogueRoot = mkdtempSync(join(tmpdir(), 'dxkit-rogue-stamp-'));
    try {
      mkdirSync(join(rogueRoot, 'producers'), { recursive: true });
      writeFileSync(join(rogueRoot, 'producers', 'rogue.ts'), rogueSource);
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

  it('does not flag a mention in a comment, even one carrying a URL', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const cleanRoot = mkdtempSync(join(tmpdir(), 'dxkit-clean-stamp-'));
    try {
      writeFileSync(
        join(cleanRoot, 'notes.ts'),
        '// computeContentHash(content, line) is the primitive; see https://example.com/why\n' +
          'export const ok = 1;\n',
      );
      const run = spawnSync('bash', ['scripts/check-architecture.sh'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, CONTENT_STAMP_SCAN_ROOT: cleanRoot },
      });
      expect(run.stdout + run.stderr).not.toContain('Content-stamp violation');
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });
});
