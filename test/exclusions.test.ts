import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadExclusions,
  isExcludedPath,
  clearExclusionsCache,
  getFindExcludeFlags,
  getGrepExcludeDirFlags,
} from '../src/analyzers/tools/exclusions';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-excl-'));
  clearExclusionsCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  clearExclusionsCache();
});

describe('loadExclusions', () => {
  it('loads bundled defaults even with no project files', () => {
    const excl = loadExclusions(tmp);
    expect(excl.dirs.length).toBeGreaterThan(0);
    expect(excl.dirs).toContain('node_modules');
    expect(excl.dirs).toContain('dist');
  });

  it('merges project .gitignore entries', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'custom-build/\n*.log\n');
    const excl = loadExclusions(tmp);
    expect(excl.dirs).toContain('custom-build');
    expect(excl.filePatterns).toContain('*.log');
  });

  it('merges .dxkit-ignore entries', () => {
    fs.writeFileSync(path.join(tmp, '.dxkit-ignore'), 'generated/\n*.gen.ts\n');
    const excl = loadExclusions(tmp);
    expect(excl.dirs).toContain('generated');
    expect(excl.filePatterns).toContain('*.gen.ts');
  });

  it('skips comment and negation lines', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '# comment\n!negation\nreal-dir/\n');
    const excl = loadExclusions(tmp);
    expect(excl.dirs).toContain('real-dir');
    expect(excl.dirs).not.toContain('comment');
    expect(excl.dirs).not.toContain('negation');
  });

  it('memoizes results per cwd', () => {
    const a = loadExclusions(tmp);
    const b = loadExclusions(tmp);
    expect(a).toBe(b);
  });
});

describe('isExcludedPath', () => {
  it('excludes paths in node_modules', () => {
    expect(isExcludedPath(tmp, 'node_modules/pkg/index.js')).toBe(true);
  });

  it('excludes paths in dist', () => {
    expect(isExcludedPath(tmp, 'dist/index.js')).toBe(true);
  });

  it('excludes .min.js files', () => {
    expect(isExcludedPath(tmp, 'vendor/jquery.min.js')).toBe(true);
  });

  it('does not exclude normal source files', () => {
    expect(isExcludedPath(tmp, 'src/app.ts')).toBe(false);
  });

  it('excludes custom .gitignore dirs', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'my-vendor/\n');
    clearExclusionsCache();
    expect(isExcludedPath(tmp, 'my-vendor/lib.js')).toBe(true);
  });
});

describe('getFindExcludeFlags', () => {
  it('returns non-empty exclude flags', () => {
    const flags = getFindExcludeFlags(tmp);
    expect(flags).toContain('-not');
    expect(flags).toContain('node_modules');
  });
});

describe('getGrepExcludeDirFlags', () => {
  it('returns non-empty grep exclude flags', () => {
    const flags = getGrepExcludeDirFlags(tmp);
    expect(flags).toContain('--exclude-dir');
    expect(flags).toContain('node_modules');
  });
});
