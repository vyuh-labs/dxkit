import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gatherGenericMetrics, LARGE_FILE_THRESHOLD_LINES } from '../src/analyzers/tools/generic';

/**
 * The large-file threshold has ONE application point — `gatherGenericMetrics`
 * derives BOTH `filesOver500Lines` and `largestFiles` against it, and records
 * the resolved value on `HealthMetrics.largeFileThreshold`. Every downstream
 * consumer (the baseline `large-file` producer, the Quality/Maintainability
 * scores, the report prose) reads those fields, so proving the threshold here
 * proves it end-to-end. A real on-disk fixture, because the gather reads files.
 */
describe('gatherGenericMetrics — large-file threshold', () => {
  let dir: string;
  function writeSrc(rel: string, lines: number): void {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    // `lines` newlines → `lines` counted lines (lineCount semantics).
    writeFileSync(abs, Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join('\n'));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-largefile-'));
    // A git repo so the source walker resolves the toplevel + tracks files.
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeSrc('src/huge.ts', 900);
    writeSrc('src/big.ts', 600);
    writeSrc('src/mid.ts', 300);
    writeSrc('src/small.ts', 100);
    execFileSync('git', ['add', '.'], { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to 500: flags the 900 + 600 line files, records the default', () => {
    const m = gatherGenericMetrics(dir, undefined);
    expect(m.largeFileThreshold).toBe(LARGE_FILE_THRESHOLD_LINES);
    expect(m.filesOver500Lines).toBe(2);
    const flagged = (m.largestFiles ?? []).map((f) => f.path.split('/').pop()).sort();
    expect(flagged).toEqual(['big.ts', 'huge.ts']);
  });

  it('raised to 800: only the 900-line file is over the bar', () => {
    const m = gatherGenericMetrics(dir, undefined, 800);
    expect(m.largeFileThreshold).toBe(800);
    expect(m.filesOver500Lines).toBe(1);
    expect((m.largestFiles ?? []).map((f) => f.path.split('/').pop())).toEqual(['huge.ts']);
  });

  it('lowered to 200: flags every file over 200 lines (huge/big/mid)', () => {
    const m = gatherGenericMetrics(dir, undefined, 200);
    expect(m.largeFileThreshold).toBe(200);
    expect(m.filesOver500Lines).toBe(3);
    expect((m.largestFiles ?? []).map((f) => f.path.split('/').pop()).sort()).toEqual([
      'big.ts',
      'huge.ts',
      'mid.ts',
    ]);
  });

  it('the count and the largestFiles list always agree (one application point)', () => {
    for (const threshold of [100, 250, 500, 700, 1000]) {
      const m = gatherGenericMetrics(dir, undefined, threshold);
      expect(m.filesOver500Lines).toBe((m.largestFiles ?? []).length);
    }
  });
});
