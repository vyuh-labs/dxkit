/**
 * Tests for the context-hook pure helpers — `extractPattern` (parsing
 * the Claude Code PreToolUse payload) and `formatHookContext` (the
 * compact additionalContext body). The fail-open stdin/exit behavior
 * of runContextHook is exercised via the CLI smoke path; here we lock
 * the parsing + formatting that decide what (if anything) gets injected.
 */

import { describe, expect, it } from 'vitest';
import {
  extractPattern,
  formatFileContext,
  formatFileLineContext,
  formatHookContext,
  parseBashForTarget,
  resolveHookTarget,
} from '../../src/explore/context-hook';
import type { ContextResult, FileLineContext, FileSummary } from '../../src/explore/queries';
import type { Graph, GraphJson } from '../../src/explore/types';

/**
 * A minimal graph stub exposing only `nodesByFile` (the membership set
 * the hook router consults) and `meta`. The router never traverses
 * edges, so this is sufficient for resolve/parse coverage.
 */
function graphWithFiles(...files: string[]): Graph {
  return {
    meta: { generatedAt: '2026-06-12T10:00:00Z' } as GraphJson['meta'],
    nodesByFile: new Map(files.map((f) => [f, [{ id: f }]])),
  } as unknown as Graph;
}

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

describe('resolveHookTarget (2.10 routing)', () => {
  const cwd = '/repo';
  const graph = graphWithFiles('src/server.ts');

  it('routes a Read on a graph file to a file target', () => {
    const t = resolveHookTarget(
      { toolName: 'Read', toolInput: { file_path: '/repo/src/server.ts' } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'file', file: 'src/server.ts' });
  });

  it('accepts a repo-relative Read path too', () => {
    const t = resolveHookTarget(
      { toolName: 'Edit', toolInput: { file_path: 'src/server.ts' } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'file', file: 'src/server.ts' });
  });

  it('no-ops a Read on a file the graph does not know', () => {
    const t = resolveHookTarget(
      { toolName: 'Read', toolInput: { file_path: '/repo/README.md' } },
      graph,
      cwd,
    );
    expect(t).toBeUndefined();
  });

  it('routes Grep to a pattern target', () => {
    const t = resolveHookTarget(
      { toolName: 'Grep', toolInput: { pattern: 'configureApp' } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'pattern', pattern: 'configureApp' });
  });

  it("carries Read's offset as the line, so the hook can localize context", () => {
    const t = resolveHookTarget(
      { toolName: 'Read', toolInput: { file_path: 'src/server.ts', offset: 78 } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'file', file: 'src/server.ts', line: 78 });
  });

  it('omits the line for a whole-file Read (no offset) → file-level map', () => {
    const t = resolveHookTarget(
      { toolName: 'Read', toolInput: { file_path: 'src/server.ts' } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'file', file: 'src/server.ts' });
  });

  it('ignores offset on Edit (only Read paginates by line)', () => {
    const t = resolveHookTarget(
      { toolName: 'Edit', toolInput: { file_path: 'src/server.ts', offset: 50 } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'file', file: 'src/server.ts' });
  });

  it('routes a Bash grep on a graph file to that file', () => {
    const t = resolveHookTarget(
      { toolName: 'Bash', toolInput: { command: 'grep -n "sendFile" src/server.ts' } },
      graph,
      cwd,
    );
    expect(t).toEqual({ kind: 'file', file: 'src/server.ts' });
  });
});

describe('parseBashForTarget', () => {
  const cwd = '/repo';
  const graph = graphWithFiles('src/server.ts');

  it('prefers a concrete file argument over the pattern', () => {
    expect(parseBashForTarget('grep -rn "app.use" src/server.ts', graph, cwd)).toEqual({
      kind: 'file',
      file: 'src/server.ts',
    });
  });

  it('falls back to the search pattern when only a directory is given', () => {
    expect(parseBashForTarget('grep -rn "sendFile" src/', graph, cwd)).toEqual({
      kind: 'pattern',
      pattern: 'sendFile',
    });
  });

  it('handles ripgrep', () => {
    expect(parseBashForTarget('rg authMiddleware', graph, cwd)).toEqual({
      kind: 'pattern',
      pattern: 'authMiddleware',
    });
  });

  it('ignores everything past a pipe', () => {
    // `wc` args after the pipe must not be mistaken for search paths.
    expect(parseBashForTarget('grep -c foo src/ | wc -l', graph, cwd)).toEqual({
      kind: 'pattern',
      pattern: 'foo',
    });
  });

  it('no-ops on a non-search Bash command', () => {
    expect(parseBashForTarget('npm run build', graph, cwd)).toBeUndefined();
    expect(parseBashForTarget('ls -la src/', graph, cwd)).toBeUndefined();
  });
});

describe('formatFileContext', () => {
  const graph = {
    meta: { generatedAt: '2026-06-12T10:00:00Z' } as GraphJson['meta'],
  } as Graph;

  const summary: FileSummary = {
    sourceFile: 'src/server.ts',
    found: true,
    symbols: [
      {
        id: 'n1',
        kind: 'function',
        label: 'configureApp',
        line: 12,
        exported: true,
        callsIn: 3,
        callsOut: 5,
      },
      { id: 'n2', kind: 'function', label: 'startServer', line: 40, callsIn: 1, callsOut: 2 },
    ],
    callerFiles: [{ sourceFile: 'src/index.ts', count: 5 }],
    calleeFiles: [{ sourceFile: 'src/db.ts', count: 2 }],
    importsIn: [],
    importsOut: [],
    communityLabel: 'http-layer',
  };

  it('leads with provenance + an authoritative-contents caveat', () => {
    const out = formatFileContext(summary, graph);
    expect(out).toContain('.dxkit/reports/graph.json');
    expect(out).toContain('2026-06-12');
    expect(out).toContain('actual contents remain authoritative');
  });

  it('lists the file symbols with caller counts', () => {
    const out = formatFileContext(summary, graph);
    expect(out).toContain('configureApp (function:12) — exported, 3 caller(s)');
    expect(out).toContain('startServer (function:40) — 1 caller(s)');
  });

  it('shows who depends on the file and what it calls into', () => {
    const out = formatFileContext(summary, graph);
    expect(out).toContain('Depended on by 1 file(s):');
    expect(out).toContain('src/index.ts (5 call(s))');
    expect(out).toContain('Calls into 1 file(s):');
    expect(out).toContain('src/db.ts (2 call(s))');
  });

  it('includes the module group when present', () => {
    expect(formatFileContext(summary, graph)).toContain('Module group: http-layer');
  });
});

describe('formatFileContext — fire gate', () => {
  const graph = { meta: { generatedAt: '2026-06-12T10:00:00Z' } as GraphJson['meta'] } as Graph;

  it("returns '' (silent no-op) when a file has no symbols and no cross-file edges", () => {
    // A symbol-less, unconnected file (e.g. top-level config) has nothing
    // structural worth the token cost — the hook must stay silent.
    const empty: FileSummary = {
      found: true,
      sourceFile: 'server.js',
      symbols: [],
      callerFiles: [],
      calleeFiles: [],
    } as unknown as FileSummary;
    expect(formatFileContext(empty, graph)).toBe('');
  });

  it('fires for a symbol-less file that is still connected (imported by others)', () => {
    const connected: FileSummary = {
      found: true,
      sourceFile: 'config/index.js',
      symbols: [],
      callerFiles: [{ sourceFile: 'src/app.js', count: 4 }],
      calleeFiles: [],
    } as unknown as FileSummary;
    expect(formatFileContext(connected, graph)).toContain('Depended on by 1 file(s):');
  });
});

describe('formatFileLineContext (line-aware delivery)', () => {
  const graph = { meta: { generatedAt: '2026-06-17T10:00:00Z' } as GraphJson['meta'] } as Graph;
  const summaryNoEdges: FileSummary = {
    found: true,
    sourceFile: 'app/data/user-dao.js',
    symbols: [],
    callerFiles: [],
    calleeFiles: [],
  } as unknown as FileSummary;

  it('frames the enclosing symbol + its direct callees (the precise neighborhood)', () => {
    const ctx: FileLineContext = {
      found: true,
      sourceFile: 'app/data/user-dao.js',
      enclosingSymbol: {
        id: 'n',
        symbol: 'addUser',
        line: 17,
        kind: 'method',
        callsIn: 0,
        callsOut: 2,
      },
      callers: [],
      callees: [
        { symbol: 'getNextSequence', sourceFile: 'app/data/user-dao.js', line: 109 },
        { symbol: 'getRandomFutureDate', sourceFile: 'app/data/user-dao.js', line: 49 },
      ],
      blastRadius: { callerFiles: 0, callers: 0 },
    };
    const out = formatFileLineContext(ctx, summaryNoEdges, graph, 'app/data/user-dao.js', 30);
    expect(out).toContain('app/data/user-dao.js:30');
    expect(out).toContain('Inside `addUser` (method, declared :17) — 0 caller(s), 2 callee(s).');
    expect(out).toContain('getNextSequence');
    // No source text is injected — the Read already returns the lines.
    expect(out).not.toContain('```');
  });

  it('still helps a module-level line (no enclosing symbol) via the file role', () => {
    const ctx: FileLineContext = {
      found: true,
      sourceFile: 'config/index.js',
      enclosingSymbol: undefined,
      callers: [],
      callees: [],
      blastRadius: { callerFiles: 1, callers: 4 },
    };
    const summary: FileSummary = {
      found: true,
      sourceFile: 'config/index.js',
      symbols: [],
      callerFiles: [{ sourceFile: 'src/app.js', count: 4 }],
      calleeFiles: [],
    } as unknown as FileSummary;
    const out = formatFileLineContext(ctx, summary, graph, 'config/index.js', 12);
    expect(out).toContain('module-level');
    expect(out).toContain('File depended on by 1 file(s):');
  });

  it("returns '' when there is neither an enclosing symbol nor any cross-file edge", () => {
    // The true server.js case: zero graph structure → nothing to inject →
    // silent no-op → the dxkit arm behaves exactly like vanilla here.
    const ctx: FileLineContext = {
      found: true,
      sourceFile: 'server.js',
      enclosingSymbol: undefined,
      callers: [],
      callees: [],
      blastRadius: { callerFiles: 0, callers: 0 },
    };
    expect(formatFileLineContext(ctx, summaryNoEdges, graph, 'server.js', 78)).toBe('');
  });
});
