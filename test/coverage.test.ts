import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCoverage } from '../src/analyzers/tools/coverage';
import { parseIstanbulSummary, parseIstanbulFinal } from '../src/languages/typescript';
import { parseCoveragePy } from '../src/languages/python';
import { parseGoCoverProfile } from '../src/languages/go';

describe('parseIstanbulSummary', () => {
  it('reads per-file line coverage from a summary JSON', () => {
    const cwd = '/repo';
    const raw = JSON.stringify({
      total: { lines: { total: 100, covered: 85, skipped: 0, pct: 85 } },
      '/repo/src/a.ts': { lines: { total: 20, covered: 18, skipped: 0, pct: 90 } },
      '/repo/src/b.ts': { lines: { total: 10, covered: 0, skipped: 0, pct: 0 } },
    });
    const c = parseIstanbulSummary(raw, 'coverage/coverage-summary.json', cwd);
    expect(c.source).toBe('istanbul-summary');
    expect(c.linePercent).toBe(85);
    expect(c.files.size).toBe(2);
    const a = c.files.get('src/a.ts');
    expect(a).toBeDefined();
    expect(a!.covered).toBe(18);
    expect(a!.total).toBe(20);
    expect(a!.pct).toBe(90);
    expect(c.files.get('src/b.ts')!.covered).toBe(0);
  });

  it('computes linePercent from per-file totals when "total" block is absent', () => {
    const raw = JSON.stringify({
      '/r/a.ts': { lines: { total: 10, covered: 5, skipped: 0, pct: 50 } },
      '/r/b.ts': { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } },
    });
    const c = parseIstanbulSummary(raw, 'f', '/r');
    expect(c.linePercent).toBe(75);
  });
});

describe('parseIstanbulFinal', () => {
  it('counts hit statements per file', () => {
    const cwd = '/repo';
    const raw = JSON.stringify({
      '/repo/src/a.ts': {
        path: '/repo/src/a.ts',
        s: { '0': 1, '1': 1, '2': 0, '3': 1 }, // 3 of 4 covered
      },
      '/repo/src/b.ts': {
        path: '/repo/src/b.ts',
        s: { '0': 0, '1': 0 }, // 0 of 2 covered
      },
    });
    const c = parseIstanbulFinal(raw, 'coverage/coverage-final.json', cwd);
    expect(c.source).toBe('istanbul-final');
    const a = c.files.get('src/a.ts')!;
    expect(a.covered).toBe(3);
    expect(a.total).toBe(4);
    expect(a.pct).toBe(75);
    // overall: 3/(4+2) = 50%
    expect(c.linePercent).toBe(50);
  });
});

describe('parseCoveragePy', () => {
  it('reads files + totals from coverage.py JSON', () => {
    const raw = JSON.stringify({
      totals: { percent_covered: 72.3 },
      files: {
        'src/foo.py': {
          summary: {
            num_statements: 20,
            missing_lines: 2,
            covered_lines: 18,
            percent_covered: 90,
          },
        },
        'src/bar.py': {
          summary: {
            num_statements: 10,
            missing_lines: 10,
            percent_covered: 0,
          },
        },
      },
    });
    const c = parseCoveragePy(raw, 'coverage.json', '/repo');
    expect(c.source).toBe('coverage-py');
    expect(c.linePercent).toBe(72.3);
    expect(c.files.get('src/foo.py')!.pct).toBe(90);
    expect(c.files.get('src/bar.py')!.covered).toBe(0);
  });

  it('falls back to covered = total - missing when covered_lines is absent', () => {
    const raw = JSON.stringify({
      totals: { percent_covered: 50 },
      files: {
        'a.py': { summary: { num_statements: 8, missing_lines: 4 } },
      },
    });
    const c = parseCoveragePy(raw, 'f', '/r');
    expect(c.files.get('a.py')!.covered).toBe(4);
  });
});

describe('parseGoCoverProfile', () => {
  it('sums statements per file and marks hit blocks as covered', () => {
    const raw = [
      'mode: set',
      'github.com/x/repo/foo.go:1.1,5.2 3 1',
      'github.com/x/repo/foo.go:6.1,9.1 2 0',
      'github.com/x/repo/bar.go:1.1,4.1 4 1',
    ].join('\n');
    const c = parseGoCoverProfile(raw, 'coverage.out', '/repo');
    expect(c.source).toBe('go');
    // foo: 3 of 5 covered; bar: 4 of 4 covered → overall 7/9
    expect(c.linePercent).toBe(77.8);
    // Go paths get resolved; on this mocked repo the files don't exist so
    // the parser falls back to the original prefix. Assert on any entry.
    expect(c.files.size).toBe(2);
  });

  it('ignores blank lines and the mode header', () => {
    const raw = 'mode: atomic\n\nfoo.go:1.1,2.1 1 1\n';
    const c = parseGoCoverProfile(raw, 'f', '/r');
    expect(c.files.size).toBe(1);
    expect(c.linePercent).toBe(100);
  });
});

describe('loadCoverage (filesystem)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-cov-'));
    // Phase 10e.B.3.6: loadCoverage dispatches through language packs, so
    // test fixtures need pack-detection triggers. Every test here gets
    // package.json (→ typescript), pyproject.toml (→ python), go.mod (→
    // go) so whichever artifact we write finds its owning pack active.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"t"}');
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '');
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module t\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when no artifact exists', async () => {
    expect(await loadCoverage(tmp)).toBeNull();
  });

  it('prefers istanbul summary over other artifacts', async () => {
    fs.mkdirSync(path.join(tmp, 'coverage'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'coverage/coverage-summary.json'),
      JSON.stringify({
        total: { lines: { total: 10, covered: 7, skipped: 0, pct: 70 } },
      }),
    );
    fs.writeFileSync(path.join(tmp, 'coverage.json'), '{"totals":{"percent_covered":50}}');
    const c = await loadCoverage(tmp);
    expect(c).not.toBeNull();
    expect(c!.source).toBe('istanbul-summary');
    expect(c!.linePercent).toBe(70);
  });

  it('falls through to coverage-py when istanbul files are absent', async () => {
    fs.writeFileSync(
      path.join(tmp, 'coverage.json'),
      JSON.stringify({ totals: { percent_covered: 44.4 }, files: {} }),
    );
    const c = await loadCoverage(tmp);
    expect(c).not.toBeNull();
    expect(c!.source).toBe('coverage-py');
    expect(c!.linePercent).toBe(44.4);
  });

  it('falls through to go coverprofile as last resort', async () => {
    fs.writeFileSync(path.join(tmp, 'coverage.out'), 'mode: set\npkg/foo.go:1.1,2.1 1 1\n');
    const c = await loadCoverage(tmp);
    expect(c).not.toBeNull();
    expect(c!.source).toBe('go');
  });

  it('returns null on malformed JSON', async () => {
    fs.mkdirSync(path.join(tmp, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'coverage/coverage-summary.json'), '{ not json');
    // With only the malformed summary, no other artifacts → null.
    expect(await loadCoverage(tmp)).toBeNull();
  });
});
