/**
 * Tests for the context-hook pure helpers — `extractPattern` (parsing
 * the Claude Code PreToolUse payload) and `formatHookContext` (the
 * compact additionalContext body). The fail-open stdin/exit behavior
 * of runContextHook is exercised via the CLI smoke path; here we lock
 * the parsing + formatting that decide what (if anything) gets injected.
 */

import { describe, expect, it } from 'vitest';
import { extractPattern, formatHookContext } from '../../src/explore/context-hook';
import type { ContextResult } from '../../src/explore/queries';
import type { Graph, GraphJson } from '../../src/explore/types';

describe('extractPattern', () => {
  it('reads tool_input.pattern from a Grep payload', () => {
    const raw = JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'authMiddleware' } });
    expect(extractPattern(raw)).toBe('authMiddleware');
  });

  it('reads tool_input.pattern from a Glob payload', () => {
    const raw = JSON.stringify({ tool_name: 'Glob', tool_input: { pattern: '**/auth*.ts' } });
    expect(extractPattern(raw)).toBe('**/auth*.ts');
  });

  it('trims surrounding whitespace', () => {
    const raw = JSON.stringify({ tool_input: { pattern: '  spaced  ' } });
    expect(extractPattern(raw)).toBe('spaced');
  });

  it('returns undefined for malformed JSON (fail-open)', () => {
    expect(extractPattern('not json at all')).toBeUndefined();
  });

  it('returns undefined when tool_input is absent', () => {
    expect(extractPattern(JSON.stringify({ tool_name: 'Grep' }))).toBeUndefined();
  });

  it('returns undefined when pattern is missing or empty', () => {
    expect(extractPattern(JSON.stringify({ tool_input: {} }))).toBeUndefined();
    expect(extractPattern(JSON.stringify({ tool_input: { pattern: '   ' } }))).toBeUndefined();
  });

  it('returns undefined when pattern is a non-string', () => {
    expect(extractPattern(JSON.stringify({ tool_input: { pattern: 42 } }))).toBeUndefined();
  });
});

describe('formatHookContext', () => {
  const graph = {
    meta: { generatedAt: '2026-05-28T10:00:00Z' } as GraphJson['meta'],
  } as Graph;

  const result: ContextResult = {
    query: 'resolveMode',
    matched: true,
    anchor: { sourceFile: 'src/modes.ts', line: 42, symbol: 'resolveMode', calledFrom: 9 },
    selection: [
      {
        id: 'n1',
        symbol: 'resolveMode',
        sourceFile: 'src/modes.ts',
        line: 42,
        kind: 'function',
        hop: 0,
        callsIn: 9,
        callsOut: 3,
      },
      {
        id: 'n2',
        symbol: 'pickDefault',
        sourceFile: 'src/modes.ts',
        line: 80,
        kind: 'function',
        hop: 1,
        callsIn: 2,
        callsOut: 0,
      },
    ],
    byCommunity: [],
    blastRadius: { callers: 9, callerFiles: 4 },
    truncated: true,
    omittedCount: 17,
    estimatedTokens: 30,
    budget: 1500,
    suggestions: [],
  };

  it('leads with provenance + a best-effort caveat (trust calibration)', () => {
    const out = formatHookContext(result, graph);
    expect(out).toContain('.dxkit/reports/graph.json');
    expect(out).toContain('2026-05-28');
    expect(out).toContain('grep results remain authoritative');
  });

  it('includes the anchor "start here" line', () => {
    const out = formatHookContext(result, graph);
    expect(out).toContain('Start here: `resolveMode` (src/modes.ts:42), called from 9 place(s).');
  });

  it('includes the blast-radius line', () => {
    const out = formatHookContext(result, graph);
    expect(out).toContain('Blast radius: 9 caller(s) across 4 file(s).');
  });

  it('lists relevant symbols seeds-first', () => {
    const out = formatHookContext(result, graph);
    expect(out).toContain('resolveMode (src/modes.ts:42)');
    expect(out).toContain('pickDefault (src/modes.ts:80)');
  });

  it('notes the omitted neighborhood when truncated', () => {
    const out = formatHookContext(result, graph);
    expect(out).toContain('+17 more symbols');
  });
});
