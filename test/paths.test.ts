import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { toProjectRelative } from '../src/analyzers/tools/paths';

describe('toProjectRelative', () => {
  const abs = path.resolve('/tmp/fake-project');

  it('normalizes an absolute file path against absolute cwd', () => {
    expect(toProjectRelative(abs, path.join(abs, 'src', 'cli.ts'))).toBe('src/cli.ts');
  });

  it('normalizes an already-relative file path against absolute cwd', () => {
    expect(toProjectRelative(abs, 'src/cli.ts')).toBe('src/cli.ts');
  });

  it('preserves leading dots in dotfiles when cwd is absolute', () => {
    expect(toProjectRelative(abs, '.env')).toBe('.env');
    expect(toProjectRelative(abs, '.dxkit-suppressions.json')).toBe('.dxkit-suppressions.json');
  });

  it('preserves leading dots in dotfiles when cwd is `.` (regression for 10e.B.6.5)', () => {
    // This is the exact shape that caused .env → env under the old
    // `file.replace(cwd + '/', '').replace(cwd, '')` pattern on the
    // integration branch before v1.6.1's CLI path fix flowed in.
    expect(toProjectRelative('.', '.env')).toBe('.env');
    expect(toProjectRelative('.', '.env.local')).toBe('.env.local');
  });

  it('preserves leading dots in dotfiles when cwd has trailing slash', () => {
    expect(toProjectRelative(abs + '/', '.env')).toBe('.env');
  });

  it('handles absolute file path when cwd is `.`', () => {
    const here = process.cwd();
    const target = path.join(here, 'src', 'cli.ts');
    expect(toProjectRelative('.', target)).toBe('src/cli.ts');
  });

  it('returns POSIX separators on all platforms', () => {
    // Windows-style input would have backslashes in path.relative output;
    // toProjectRelative normalizes them. Approximate by constructing a
    // nested path and asserting the joiner is `/`.
    const nested = path.join(abs, 'a', 'b', 'c.ts');
    expect(toProjectRelative(abs, nested)).toBe('a/b/c.ts');
  });

  it('works with tmpdir (real filesystem)', () => {
    const tmp = os.tmpdir();
    expect(toProjectRelative(tmp, path.join(tmp, 'x.txt'))).toBe('x.txt');
  });
});
