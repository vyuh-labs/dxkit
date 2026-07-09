import { describe, it, expect } from 'vitest';
import {
  parseHistory,
  serializeHistory,
  foldEntry,
  type ReportHistoryEntry,
} from '../../src/reports/history';

const scores = {
  overall: 70,
  security: 80,
  quality: 60,
  tests: 50,
  documentation: 40,
  maintainability: 65,
  developerExperience: 75,
};
function entry(sha: string, over = 70): ReportHistoryEntry {
  return {
    sha,
    date: '2026-07-09T00:00:00Z',
    dxkitVersion: '3.0.0',
    scores: { ...scores, overall: over },
  };
}

describe('report history codec', () => {
  it('round-trips entries through serialize → parse', () => {
    const entries = [entry('a', 60), entry('b', 70)];
    const parsed = parseHistory(serializeHistory(entries));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].sha).toBe('a');
    expect(parsed[1].scores.overall).toBe(70);
  });

  it('serializes empty as empty string', () => {
    expect(serializeHistory([])).toBe('');
    expect(parseHistory('')).toEqual([]);
    expect(parseHistory(null)).toEqual([]);
  });

  it('skips blank + malformed + incomplete lines without throwing', () => {
    const jsonl =
      serializeHistory([entry('a')]) +
      '\n' + // blank line
      'not json at all\n' +
      '{"sha":"x"}\n' + // missing date + scores → skipped
      '{"sha":"y","date":"d","scores":{"overall":"bad"}}\n' + // malformed score → skipped
      serializeHistory([entry('b')]);
    const parsed = parseHistory(jsonl);
    expect(parsed.map((e) => e.sha)).toEqual(['a', 'b']);
  });

  it('tolerates + preserves unknown/extra fields on a line', () => {
    const parsed = parseHistory(
      JSON.stringify({ ...entry('a'), futureField: { nested: 1 } }) + '\n',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sha).toBe('a');
  });

  it('foldEntry replaces a same-SHA entry (idempotent re-run of one merge)', () => {
    const existing = [entry('a', 60), entry('b', 70)];
    const folded = foldEntry(existing, entry('b', 99), 0);
    expect(folded).toHaveLength(2);
    expect(folded.find((e) => e.sha === 'b')!.scores.overall).toBe(99);
  });

  it('foldEntry appends a new SHA in order', () => {
    const folded = foldEntry([entry('a')], entry('c'), 0);
    expect(folded.map((e) => e.sha)).toEqual(['a', 'c']);
  });

  it('foldEntry retains only the most recent N', () => {
    let acc: ReportHistoryEntry[] = [];
    for (const sha of ['a', 'b', 'c', 'd', 'e']) acc = foldEntry(acc, entry(sha), 3);
    expect(acc.map((e) => e.sha)).toEqual(['c', 'd', 'e']);
  });

  it('retain <= 0 keeps everything', () => {
    let acc: ReportHistoryEntry[] = [];
    for (const sha of ['a', 'b', 'c', 'd']) acc = foldEntry(acc, entry(sha), 0);
    expect(acc).toHaveLength(4);
  });

  it('preserves a null (unmeasured) dimension score', () => {
    const e: ReportHistoryEntry = {
      sha: 'a',
      date: 'd',
      dxkitVersion: '3.0.0',
      scores: { ...scores, security: null },
    };
    const parsed = parseHistory(serializeHistory([e]));
    expect(parsed[0].scores.security).toBeNull();
  });
});
