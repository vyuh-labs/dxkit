/**
 * Presentation layer for `vyuh-dxkit context-hook` — the compact
 * `additionalContext` bodies the hook injects. Split out of
 * `context-hook.ts` (which owns the stdin/route/dedup orchestration) so
 * each file stays a cohesive unit under the large-file bar: this module is
 * pure string-building over already-queried graph data, trivially unit-
 * testable without touching stdin or the filesystem.
 *
 * Three shapes, one per hook target:
 *   - `formatFileContext` — a FILE the agent opened (whole-file read): its
 *     symbols + who depends on it + what it calls into.
 *   - `formatFileLineContext` — a FILE at a LINE (Read's `offset`): the
 *     location's enclosing symbol + its direct callers/callees, plus the
 *     file's cross-file role. Useful even for symbol-less regions.
 *   - `formatHookContext` — a search PATTERN (Bash/Grep/Glob): the anchor
 *     symbol, blast radius, and the top neighborhood symbols.
 *
 * Each returns '' when there's nothing worth the token cost, which the
 * hook treats as "don't fire" (the additive/fail-open contract).
 */
import type { ContextResult, FileLineContext, FileSummary } from './queries';
import type { Graph } from './types';

/**
 * Compact `additionalContext` body for a FILE target: the file's
 * symbols, who depends on it (caller files), and what it reaches into
 * (callee files). Terser than the CLI's markdown — the hook pays this on
 * every read. Leads with provenance + a best-effort caveat so the agent
 * calibrates trust.
 */
export function formatFileContext(summary: FileSummary, graph: Graph): string {
  // Fire only when there's structure worth the tokens: named symbols, or the
  // file's cross-file role (who imports it / what it reaches into). A file
  // with none of those (and no line to localize) has nothing useful to add —
  // return '' so the hook stays a silent no-op (additive contract).
  if (
    summary.symbols.length === 0 &&
    summary.callerFiles.length === 0 &&
    summary.calleeFiles.length === 0
  ) {
    return '';
  }
  const lines: string[] = [];
  lines.push(
    `dxkit graph context for \`${summary.sourceFile}\` (from .dxkit/reports/graph.json, generated ${graph.meta.generatedAt.slice(0, 10)} — structural map, the file's actual contents remain authoritative):`,
  );

  const topSymbols = summary.symbols.slice(0, 12);
  if (topSymbols.length > 0) {
    lines.push(`- Symbols (${summary.symbols.length}):`);
    for (const s of topSymbols) {
      const where = s.line ? `:${s.line}` : '';
      const flags = [s.exported ? 'exported' : '', s.callsIn > 0 ? `${s.callsIn} caller(s)` : '']
        .filter(Boolean)
        .join(', ');
      lines.push(`    ${s.label} (${s.kind}${where})${flags ? ` — ${flags}` : ''}`);
    }
    if (summary.symbols.length > topSymbols.length) {
      lines.push(`    (+${summary.symbols.length - topSymbols.length} more)`);
    }
  }

  if (summary.callerFiles.length > 0) {
    const top = summary.callerFiles.slice(0, 6);
    lines.push(`- Depended on by ${summary.callerFiles.length} file(s):`);
    for (const c of top) lines.push(`    ${c.sourceFile} (${c.count} call(s))`);
    if (summary.callerFiles.length > top.length) {
      lines.push(`    (+${summary.callerFiles.length - top.length} more)`);
    }
  }

  if (summary.calleeFiles.length > 0) {
    const top = summary.calleeFiles.slice(0, 6);
    lines.push(`- Calls into ${summary.calleeFiles.length} file(s):`);
    for (const c of top) lines.push(`    ${c.sourceFile} (${c.count} call(s))`);
    if (summary.calleeFiles.length > top.length) {
      lines.push(`    (+${summary.calleeFiles.length - top.length} more)`);
    }
  }

  if (summary.communityLabel) {
    lines.push(`- Module group: ${summary.communityLabel}`);
  }

  return lines.join('\n');
}

/**
 * Compact `additionalContext` for a FILE target with a LINE (Read's
 * `offset`). Frames the location's structural neighborhood: the enclosing
 * symbol + its direct callers/callees, plus the file's cross-file role
 * (who imports it, what it reaches into) and module group.
 *
 * It deliberately injects NO source text — the Read the agent just issued
 * already returns the lines; the hook's value is the structure the Read
 * does NOT show (who reaches this symbol, blast radius, what it calls).
 * That's also why this works for symbol-less regions (top-level config,
 * an entrypoint's middleware block): even with no enclosing symbol, the
 * file's role orients the agent — exactly the case a file-level symbol map
 * left empty. Returns '' (→ silent no-op) when there's no enclosing symbol
 * AND no cross-file edges to report.
 */
export function formatFileLineContext(
  ctx: FileLineContext,
  summary: FileSummary,
  graph: Graph,
  file: string,
  line: number,
): string {
  const enc = ctx.enclosingSymbol;
  const hasFileEdges = summary.callerFiles.length > 0 || summary.calleeFiles.length > 0;
  if (!enc && !hasFileEdges) return '';

  const lines: string[] = [];
  lines.push(
    `dxkit graph context for \`${file}:${line}\` (from .dxkit/reports/graph.json, generated ${graph.meta.generatedAt.slice(0, 10)} — structural map, the file's actual contents remain authoritative):`,
  );

  if (enc) {
    const where = enc.line ? `${enc.kind}, declared :${enc.line}` : enc.kind;
    lines.push(
      `- Inside \`${enc.symbol}\` (${where}) — ${enc.callsIn} caller(s), ${enc.callsOut} callee(s).`,
    );
    if (ctx.callers.length > 0) {
      const top = ctx.callers.slice(0, 6);
      lines.push(`- Callers of \`${enc.symbol}\`:`);
      for (const c of top)
        lines.push(`    ${c.symbol} — ${c.line ? `${c.sourceFile}:${c.line}` : c.sourceFile}`);
    }
    if (ctx.callees.length > 0) {
      const top = ctx.callees.slice(0, 6);
      lines.push(`- \`${enc.symbol}\` calls:`);
      for (const c of top)
        lines.push(`    ${c.symbol} — ${c.line ? `${c.sourceFile}:${c.line}` : c.sourceFile}`);
    }
  } else {
    lines.push(
      `- Line ${line} is module-level (top of file / config) — not inside a tracked symbol.`,
    );
  }

  if (summary.callerFiles.length > 0) {
    const top = summary.callerFiles.slice(0, 6);
    lines.push(`- File depended on by ${summary.callerFiles.length} file(s):`);
    for (const c of top) lines.push(`    ${c.sourceFile} (${c.count} call(s))`);
  }
  if (summary.calleeFiles.length > 0) {
    const top = summary.calleeFiles.slice(0, 6);
    lines.push(`- File calls into ${summary.calleeFiles.length} file(s):`);
    for (const c of top) lines.push(`    ${c.sourceFile} (${c.count} call(s))`);
  }
  if (summary.communityLabel) lines.push(`- Module group: ${summary.communityLabel}`);

  return lines.join('\n');
}

/**
 * Compact `additionalContext` body for a PATTERN target. Terser than the
 * CLI's markdown (the hook pays this cost on every grep): an anchor line,
 * blast radius, and the top symbols grouped by their leading community.
 * Leads with a one-line provenance + best-effort caveat so the agent
 * calibrates trust.
 */
export function formatHookContext(result: ContextResult, graph: Graph): string {
  const lines: string[] = [];
  lines.push(
    `dxkit graph context for \`${result.query}\` (from .dxkit/reports/graph.json, generated ${graph.meta.generatedAt.slice(0, 10)} — structural hint, grep results remain authoritative):`,
  );

  if (result.anchor) {
    const a = result.anchor;
    const where = a.line ? `${a.sourceFile}:${a.line}` : a.sourceFile;
    lines.push(`- Start here: \`${a.symbol}\` (${where}), called from ${a.calledFrom} place(s).`);
  }
  if (result.blastRadius.callers > 0) {
    lines.push(
      `- Blast radius: ${result.blastRadius.callers} caller(s) across ${result.blastRadius.callerFiles} file(s).`,
    );
  }

  // Top symbols overall (seeds first, then by in-degree), capped tight.
  const top = [...result.selection]
    .sort((a, b) => a.hop - b.hop || b.callsIn - a.callsIn)
    .slice(0, 10);
  if (top.length > 0) {
    lines.push('- Relevant symbols:');
    for (const s of top) {
      const where = s.line ? `${s.sourceFile}:${s.line}` : s.sourceFile;
      lines.push(`    ${s.symbol} (${where})`);
    }
  }
  if (result.truncated) {
    lines.push(`- (+${result.omittedCount} more symbols in the wider neighborhood)`);
  }

  return lines.join('\n');
}
