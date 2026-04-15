import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applySuppressions,
  clearSuppressionsCache,
  globToRegex,
  loadSuppressions,
  SuppressionRule,
} from '../src/analyzers/tools/suppressions';

describe('globToRegex', () => {
  const match = (glob: string, p: string) => globToRegex(glob).test(p);

  it('matches literal paths', () => {
    expect(match('foo/bar.ts', 'foo/bar.ts')).toBe(true);
    expect(match('foo/bar.ts', 'foo/baz.ts')).toBe(false);
  });

  it('* does not cross /', () => {
    expect(match('src/*.ts', 'src/a.ts')).toBe(true);
    expect(match('src/*.ts', 'src/nested/a.ts')).toBe(false);
  });

  it('**/ prefix matches any depth', () => {
    expect(match('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(match('**/*.test.ts', 'src/a.test.ts')).toBe(true);
    expect(match('**/*.test.ts', 'src/nested/a.test.ts')).toBe(true);
    expect(match('**/*.test.ts', 'src/a.ts')).toBe(false);
  });

  it('/** suffix matches any descendant (and the dir itself)', () => {
    expect(match('test/fixtures/**', 'test/fixtures')).toBe(true);
    expect(match('test/fixtures/**', 'test/fixtures/a.json')).toBe(true);
    expect(match('test/fixtures/**', 'test/fixtures/deep/a.json')).toBe(true);
    expect(match('test/fixtures/**', 'test/other.json')).toBe(false);
  });

  it('mid-path ** matches zero or more segments', () => {
    expect(match('src/**/foo.ts', 'src/foo.ts')).toBe(true);
    expect(match('src/**/foo.ts', 'src/a/foo.ts')).toBe(true);
    expect(match('src/**/foo.ts', 'src/a/b/foo.ts')).toBe(true);
    expect(match('src/**/foo.ts', 'other/foo.ts')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(match('a.b+c', 'a.b+c')).toBe(true);
    expect(match('a.b+c', 'axbyc')).toBe(false);
  });

  it('? matches one non-slash char', () => {
    expect(match('file?.ts', 'fileA.ts')).toBe(true);
    expect(match('file?.ts', 'fileAB.ts')).toBe(false);
    expect(match('file?.ts', 'file/.ts')).toBe(false);
  });
});

describe('applySuppressions', () => {
  interface F {
    rule: string;
    file: string;
  }
  const get = (f: F) => f.rule;
  const getP = (f: F) => f.file;

  it('returns everything kept when rules is empty', () => {
    const findings: F[] = [{ rule: 'x', file: 'a.ts' }];
    const r = applySuppressions(findings, [], get, getP);
    expect(r.kept).toHaveLength(1);
    expect(r.suppressed).toHaveLength(0);
  });

  it('suppresses by exact rule + matching path', () => {
    const findings: F[] = [
      { rule: 'generic-api-key', file: 'test/fixtures/keys.json' },
      { rule: 'generic-api-key', file: 'src/real.ts' },
    ];
    const rules: SuppressionRule[] = [
      { rule: 'generic-api-key', paths: ['test/fixtures/**'], reason: 'fixtures' },
    ];
    const r = applySuppressions(findings, rules, get, getP);
    expect(r.kept).toEqual([{ rule: 'generic-api-key', file: 'src/real.ts' }]);
    expect(r.suppressed).toHaveLength(1);
    expect(r.suppressed[0].reason).toBe('fixtures');
  });

  it('wildcard rule ("*") suppresses any rule on matching path', () => {
    const findings: F[] = [
      { rule: 'a', file: 'gen/x.ts' },
      { rule: 'b', file: 'gen/y.ts' },
      { rule: 'c', file: 'src/z.ts' },
    ];
    const rules: SuppressionRule[] = [{ rule: '*', paths: ['gen/**'] }];
    const r = applySuppressions(findings, rules, get, getP);
    expect(r.kept).toEqual([{ rule: 'c', file: 'src/z.ts' }]);
    expect(r.suppressed).toHaveLength(2);
  });

  it('does not suppress when rule matches but path does not', () => {
    const findings: F[] = [{ rule: 'r1', file: 'src/a.ts' }];
    const rules: SuppressionRule[] = [{ rule: 'r1', paths: ['other/**'] }];
    const r = applySuppressions(findings, rules, get, getP);
    expect(r.kept).toHaveLength(1);
    expect(r.suppressed).toHaveLength(0);
  });
});

describe('loadSuppressions', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-sup-'));
    clearSuppressionsCache();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearSuppressionsCache();
  });

  it('returns empty buckets when file is missing', () => {
    const r = loadSuppressions(tmp);
    expect(r).toEqual({ gitleaks: [], semgrep: [], slop: [] });
  });

  it('parses gitleaks/semgrep/slop buckets', () => {
    fs.writeFileSync(
      path.join(tmp, '.dxkit-suppressions.json'),
      JSON.stringify({
        gitleaks: [{ rule: 'api-key', paths: ['test/**'], reason: 'fixtures' }],
        semgrep: [{ rule: '*', paths: ['scripts/**'] }],
        slop: [],
      }),
    );
    const r = loadSuppressions(tmp);
    expect(r.gitleaks).toHaveLength(1);
    expect(r.gitleaks[0].rule).toBe('api-key');
    expect(r.gitleaks[0].reason).toBe('fixtures');
    expect(r.semgrep).toHaveLength(1);
    expect(r.semgrep[0].rule).toBe('*');
    expect(r.slop).toHaveLength(0);
  });

  it('returns empty on malformed JSON', () => {
    fs.writeFileSync(path.join(tmp, '.dxkit-suppressions.json'), '{ broken json');
    const r = loadSuppressions(tmp);
    expect(r).toEqual({ gitleaks: [], semgrep: [], slop: [] });
  });

  it('drops entries without a rule or without paths', () => {
    fs.writeFileSync(
      path.join(tmp, '.dxkit-suppressions.json'),
      JSON.stringify({
        gitleaks: [
          { rule: '', paths: ['x/**'] },
          { rule: 'r1', paths: [] },
          { rule: 'r2', paths: ['ok/**'] },
        ],
      }),
    );
    const r = loadSuppressions(tmp);
    expect(r.gitleaks).toHaveLength(1);
    expect(r.gitleaks[0].rule).toBe('r2');
  });
});
