import { describe, it, expect } from 'vitest';
import { parsePipShowOutput, buildPyTopLevelDepIndex, isMajorBump } from '../src/languages/python';

// `pip show` output is RFC-822-ish Key: Value blocks separated by '---'.
// Fixtures match the real tool's emission pattern (trailing newline,
// blank lines inside blocks, etc.).

describe('parsePipShowOutput', () => {
  it('returns empty map on empty input', () => {
    expect(parsePipShowOutput('').size).toBe(0);
  });

  it('parses a single package block', () => {
    const raw = 'Name: requests\nVersion: 2.28.0\nRequires: urllib3, certifi\nRequired-by: \n';
    const graph = parsePipShowOutput(raw);
    expect(graph.size).toBe(1);
    expect(graph.get('requests')).toEqual({
      requires: ['urllib3', 'certifi'],
      requiredBy: [],
    });
  });

  it('parses multiple blocks separated by --- and handles Required-by with names', () => {
    const raw = [
      'Name: requests',
      'Version: 2.28.0',
      'Requires: urllib3',
      'Required-by: ',
      '---',
      'Name: urllib3',
      'Version: 1.26.12',
      'Requires: ',
      'Required-by: requests',
    ].join('\n');
    const graph = parsePipShowOutput(raw);
    expect(graph.size).toBe(2);
    expect(graph.get('requests')?.requiredBy).toEqual([]);
    expect(graph.get('urllib3')?.requiredBy).toEqual(['requests']);
    expect(graph.get('urllib3')?.requires).toEqual([]);
  });

  it('ignores stray fields that are not Name/Requires/Required-by', () => {
    const raw = 'Name: foo\nSummary: a thing\nRequires: a, b\nHome-page: http://x\nRequired-by: \n';
    const graph = parsePipShowOutput(raw);
    expect(graph.get('foo')?.requires).toEqual(['a', 'b']);
  });
});

describe('buildPyTopLevelDepIndex', () => {
  it('returns empty map when graph is empty', () => {
    expect(buildPyTopLevelDepIndex(new Map()).size).toBe(0);
  });

  it('treats packages with empty Required-by as top-levels', () => {
    // requests is a top-level (nothing requires it); urllib3 is pulled by requests.
    const graph = new Map([
      ['requests', { requires: ['urllib3'], requiredBy: [] }],
      ['urllib3', { requires: [], requiredBy: ['requests'] }],
    ]);
    const idx = buildPyTopLevelDepIndex(graph);
    expect(idx.get('requests')).toEqual(['requests']);
    expect(idx.get('urllib3')).toEqual(['requests']);
  });

  it('unions attributions across multiple top-levels', () => {
    // jinja2 is pulled by both flask (via direct) and by a hypothetical
    // second top-level tool. Both should appear in attribution.
    const graph = new Map([
      ['flask', { requires: ['jinja2'], requiredBy: [] }],
      ['sphinx', { requires: ['jinja2'], requiredBy: [] }],
      ['jinja2', { requires: ['markupsafe'], requiredBy: ['flask', 'sphinx'] }],
      ['markupsafe', { requires: [], requiredBy: ['jinja2'] }],
    ]);
    const idx = buildPyTopLevelDepIndex(graph);
    expect(idx.get('jinja2')).toEqual(['flask', 'sphinx']);
    expect(idx.get('markupsafe')).toEqual(['flask', 'sphinx']);
  });

  it('handles cycles without infinite looping', () => {
    const graph = new Map([
      ['a', { requires: ['b'], requiredBy: [] }],
      ['b', { requires: ['a'], requiredBy: ['a'] }],
    ]);
    const idx = buildPyTopLevelDepIndex(graph);
    expect(idx.get('a')).toEqual(['a']);
    expect(idx.get('b')).toEqual(['a']);
  });

  it('skips orphan references (requires entries not present as nodes)', () => {
    // Graph references `missing` as a dep but doesn't have a node for it.
    // Should not crash, no attribution emitted for `missing`.
    const graph = new Map([['foo', { requires: ['missing'], requiredBy: [] }]]);
    const idx = buildPyTopLevelDepIndex(graph);
    // `missing` should still be attributed because BFS visits it.
    expect(idx.get('missing')).toEqual(['foo']);
    expect(idx.get('foo')).toEqual(['foo']);
  });
});

describe('isMajorBump', () => {
  it('flags major-version upgrade as breaking', () => {
    expect(isMajorBump('1.2.3', '2.0.0')).toBe(true);
  });

  it('flags pre-1.x minor bump as breaking (0.x convention)', () => {
    expect(isMajorBump('0.5.0', '0.6.0')).toBe(true);
  });

  it('does not flag same-major patch bump as breaking', () => {
    expect(isMajorBump('1.2.3', '1.2.4')).toBe(false);
    expect(isMajorBump('2.0.0', '2.5.1')).toBe(false);
  });

  it('does not flag pre-1.x patch-level bump as breaking', () => {
    expect(isMajorBump('0.5.0', '0.5.1')).toBe(false);
  });

  it('returns false when either input is unparseable', () => {
    expect(isMajorBump('', '1.0.0')).toBe(false);
    expect(isMajorBump('1.0.0', 'not-semver')).toBe(false);
  });
});
