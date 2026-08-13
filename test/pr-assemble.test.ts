import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { assembleLanePrBody, buildLaneNarrative } from '../src/pr/assemble';

/**
 * #288 — the ONE lane PR-body assembler. The contract under test: the
 * ledger section is BYTE-IDENTICAL to the input (contractual, never
 * paraphrased), the narrative is labeled as generated, and every failure
 * of the narrative path yields the ledger alone — additive, never a gate.
 */

const LEDGER = '## dxkit remediation ledger\n\n- floor: passed\n- guardrail: PASSED\n';

let repo: string;
let baseSha: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-assemble-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@e.c']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  baseSha = git(['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'src.js'), 'fixed\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fix(build): declare the missing dependency']);
  writeFileSync(join(repo, 'dead.js'), '');
  git(['add', '.']);
  git(['commit', '-qm', 'chore: remove the dead consumer']);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('assembleLanePrBody', () => {
  it('composes: labeled generated narrative on top, the ledger VERBATIM below', () => {
    const body = assembleLanePrBody({ cwd: repo, ledger: LEDGER, base: baseSha });
    expect(body).toContain('## What changed (generated)');
    expect(body).toContain('declare the missing dependency');
    expect(body).toContain('remove the dead consumer');
    // The contractual section: byte-identical, at the end.
    expect(body.endsWith(LEDGER)).toBe(true);
  });

  it('an empty commit range yields the ledger alone, byte-identical', () => {
    const head = git(['rev-parse', 'HEAD']);
    expect(assembleLanePrBody({ cwd: repo, ledger: LEDGER, base: head })).toBe(LEDGER);
  });

  it('a throwing narrative yields the ledger alone (additive, never a gate)', () => {
    const body = assembleLanePrBody({
      cwd: repo,
      ledger: LEDGER,
      base: baseSha,
      narrative: () => {
        throw new Error('describe unavailable');
      },
    });
    expect(body).toBe(LEDGER);
  });

  it('outside a git repo the body is the ledger alone', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dxkit-assemble-nogit-'));
    try {
      expect(assembleLanePrBody({ cwd: plain, ledger: LEDGER, base: 'main' })).toBe(LEDGER);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('buildLaneNarrative — composed from the pr pipeline pieces', () => {
  it('buckets the range commits through the ONE conventional-commit parser', () => {
    const narrative = buildLaneNarrative(repo, baseSha)!;
    // bucketCommits ordering: fixes and chores land under their buckets.
    expect(narrative).toContain('declare the missing dependency');
    expect(narrative).toContain('remove the dead consumer');
    expect(narrative).toMatch(/files? touched across/);
  });
});
