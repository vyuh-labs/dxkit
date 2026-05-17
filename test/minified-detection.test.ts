import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isLikelyMinified } from '../src/analyzers/tools/minified-detection';

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minified-test-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('isLikelyMinified', () => {
  it('returns false for normal hand-written JavaScript', () => {
    const lines = [
      "import { useState } from 'react';",
      '',
      'export function Counter() {',
      '  const [count, setCount] = useState(0);',
      '  return <button onClick={() => setCount(count + 1)}>{count}</button>;',
      '}',
    ];
    // Repeat to make sure we sample plenty of newlines.
    const content = Array(40).fill(lines.join('\n')).join('\n\n');
    expect(isLikelyMinified(write('Counter.js', content))).toBe(false);
  });

  it('returns true for single-line minified JavaScript', () => {
    // A typical minified bundle has the whole IIFE on one line.
    const content = '!function(){' + 'var a=1;a++;'.repeat(500) + '}();';
    expect(isLikelyMinified(write('bundle.min.js', content))).toBe(true);
  });

  it('returns true for webpack-style hash-suffixed bundle chunks', () => {
    // Webpack/vite often split bundles across newlines but each
    // "line" is a 500-2000 byte chunk of minified code.
    const chunks = Array(20)
      .fill(0)
      .map(() => 'a'.repeat(800));
    expect(isLikelyMinified(write('index-aBcD1234.js', chunks.join('\n')))).toBe(true);
  });

  it('returns true for minified CSS', () => {
    const content = '.a{color:red}.b{color:blue}'.repeat(200);
    expect(isLikelyMinified(write('styles.min.css', content))).toBe(true);
  });

  it('returns false for non-minifiable extensions (typescript, python)', () => {
    // Even if the content looks dense, we don't waste I/O on .ts /
    // .py — those rarely get minified in-place.
    const dense = 'x'.repeat(10000);
    expect(isLikelyMinified(write('huge.ts', dense))).toBe(false);
    expect(isLikelyMinified(write('huge.py', dense))).toBe(false);
  });

  it('returns false on missing files', () => {
    expect(isLikelyMinified(path.join(tmp, 'nope.js'))).toBe(false);
  });

  it('returns false on empty files', () => {
    expect(isLikelyMinified(write('empty.js', ''))).toBe(false);
  });
});
