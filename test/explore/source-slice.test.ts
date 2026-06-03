/**
 * Tests for extractWindow — the pure source-slicing primitive behind
 * `vyuh-dxkit context <file:line>`. No fs: the function takes file text
 * + a span and returns the budget-bounded, line-centered chunk.
 */

import { describe, expect, it } from 'vitest';
import { extractWindow } from '../../src/explore/source-slice';

// 10 lines, each "lineNN" (6 chars + newline ≈ 7 chars/line).
const TEXT = Array.from({ length: 10 }, (_, i) => `line${String(i + 1).padStart(2, '0')}`).join(
  '\n',
);

describe('extractWindow', () => {
  it('returns the whole span when it fits the budget', () => {
    const chunk = extractWindow(TEXT, 5, { budgetTokens: 1000, spanStart: 3, spanEndExclusive: 8 });
    expect(chunk.startLine).toBe(3);
    expect(chunk.endLine).toBe(7);
    expect(chunk.lines).toEqual(['line03', 'line04', 'line05', 'line06', 'line07']);
    expect(chunk.spanLines).toBe(5);
    expect(chunk.truncated).toBe(false);
  });

  it('centers a too-small budget on the target line and reports truncation', () => {
    // ~7 chars/line; budget 5 tokens × 4 chars = 20 chars ≈ 2-3 lines.
    const chunk = extractWindow(TEXT, 6, { budgetTokens: 5, spanStart: 1, spanEndExclusive: 11 });
    expect(chunk.truncated).toBe(true);
    // The target line is always included.
    expect(chunk.startLine).toBeLessThanOrEqual(6);
    expect(chunk.endLine).toBeGreaterThanOrEqual(6);
    expect(chunk.lines).toContain('line06');
    // And the window is a strict subset of the span.
    expect(chunk.endLine - chunk.startLine + 1).toBeLessThan(10);
  });

  it('always returns at least the target line even when it alone exceeds budget', () => {
    const chunk = extractWindow(TEXT, 4, { budgetTokens: 1, spanStart: 1, spanEndExclusive: 11 });
    expect(chunk.lines).toEqual(['line04']);
    expect(chunk.startLine).toBe(4);
    expect(chunk.endLine).toBe(4);
    expect(chunk.truncated).toBe(true);
  });

  it('defaults the span to the whole file when no span is given', () => {
    const chunk = extractWindow(TEXT, 1, { budgetTokens: 1000 });
    expect(chunk.startLine).toBe(1);
    expect(chunk.endLine).toBe(10);
    expect(chunk.spanLines).toBe(10);
    expect(chunk.truncated).toBe(false);
  });

  it('clamps a target above the span end into the span', () => {
    const chunk = extractWindow(TEXT, 99, {
      budgetTokens: 1000,
      spanStart: 2,
      spanEndExclusive: 5,
    });
    expect(chunk.startLine).toBe(2);
    expect(chunk.endLine).toBe(4);
    expect(chunk.lines).toEqual(['line02', 'line03', 'line04']);
  });

  it('clamps a span end past EOF to the last line', () => {
    const chunk = extractWindow(TEXT, 9, {
      budgetTokens: 1000,
      spanStart: 8,
      spanEndExclusive: 999,
    });
    expect(chunk.endLine).toBe(10);
    expect(chunk.lines).toEqual(['line08', 'line09', 'line10']);
  });

  it('handles a single-line file without going empty', () => {
    const chunk = extractWindow('only one line', 1, { budgetTokens: 1000 });
    expect(chunk.lines).toEqual(['only one line']);
    expect(chunk.startLine).toBe(1);
    expect(chunk.endLine).toBe(1);
    expect(chunk.truncated).toBe(false);
  });
});
