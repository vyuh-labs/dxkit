import { describe, it, expect } from 'vitest';
import { parseJsonStream } from '../src/analyzers/tools/runner';

describe('parseJsonStream', () => {
  it('parses concatenated single-line objects', () => {
    const out = parseJsonStream('{"a":1}\n{"b":2}\n');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses pretty-printed multi-line objects (govulncheck shape)', () => {
    const raw = `{
  "config": {
    "version": "v1.0.0"
  }
}
{
  "finding": {
    "osv": "GO-2025-1"
  }
}`;
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ config: { version: 'v1.0.0' } }, { finding: { osv: 'GO-2025-1' } }]);
  });

  it('handles strings containing braces without breaking the parser', () => {
    const raw = '{"x": "hello } world", "y": 1}\n{"z": "{nested}"}';
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ x: 'hello } world', y: 1 }, { z: '{nested}' }]);
  });

  it('handles escaped quotes in strings', () => {
    const raw = String.raw`{"q": "she said \"hi\""}`;
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ q: 'she said "hi"' }]);
  });

  it('handles deeply nested objects', () => {
    const raw = '{"a":{"b":{"c":{"d":1}}}}';
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ a: { b: { c: { d: 1 } } } }]);
  });

  it('skips malformed segments and continues parsing', () => {
    const raw = '{"ok":1}\n{not-json}\n{"ok":2}';
    const out = parseJsonStream(raw);
    // The malformed segment '{not-json}' fails JSON.parse and is dropped;
    // the parser continues with the next balanced block.
    expect(out).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('returns empty array on empty input', () => {
    expect(parseJsonStream('')).toEqual([]);
    expect(parseJsonStream('   \n\n  ')).toEqual([]);
  });

  it('ignores leading/trailing non-JSON text', () => {
    const raw = 'preamble noise\n{"a":1}\ntrailing junk';
    expect(parseJsonStream(raw)).toEqual([{ a: 1 }]);
  });
});
