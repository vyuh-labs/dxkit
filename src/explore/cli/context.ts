/**
 * `vyuh-dxkit context <query>` — the token-reduction surface. Returns
 * a slim, relevance-ranked structural slice for a query instead of the
 * full-file dump an agent would otherwise grep + read. Same payload
 * serves the human at a terminal and the LLM via the PreToolUse hook.
 *
 * Output is lean markdown by default (LLMs parse it natively + it's
 * more token-efficient than JSON); `--json` emits the stable envelope
 * for pipelines. The content is anchor-first ("start here"), grouped
 * by community for orientation, framed by blast radius, and honest
 * about truncation + same-name conflation.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { contextQuery, fileLineContextQuery, type ContextNode } from '../queries';
import { envelope, markdownHeader, printJson, printMarkdown, smallRepoGrepHint } from '../format';
import { extractWindow } from '../source-slice';
import { languageForFile } from '../../languages';
import type { Graph } from '../types';
import type { ExploreCliValues } from '../../explore-cli';

const DEFAULT_BUDGET = 2000;

/**
 * `<path>:<line>` form detector. A symbol query virtually never ends in
 * `:digits`, so this cleanly separates the location surface
 * (`context src/a.ts:42`) from the keyword surface (`context auth`).
 */
const FILE_LINE_RE = /^(.+):(\d+)$/;

export function runContext(
  graph: Graph,
  positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
  cwd: string,
): void {
  const arg = positionals[0];
  if (!arg) {
    process.stderr.write(
      'Usage: vyuh-dxkit context <query|file:line> [--substring] [--budget 2000] [--depth N] [--json]\n',
    );
    process.exit(1);
  }

  // Route the `file:line` form to the source-slice surface; everything
  // else is a keyword query.
  const m = FILE_LINE_RE.exec(arg);
  if (m) {
    runFileLineContext(graph, m[1], parseInt(m[2], 10), values, cwd);
    return;
  }

  const keyword = arg;
  const budget = parsePositiveInt(values.budget, DEFAULT_BUDGET);
  const depth = values.depth !== undefined ? parsePositiveInt(values.depth, Infinity) : undefined;
  const substring = !!values.substring;

  let result = contextQuery(graph, keyword, { budget, substring, maxDepth: depth });

  // Auto-fall-back to substring on an empty exact match (one call, not two).
  let autoExpanded = false;
  if (!result.matched && !substring) {
    const expanded = contextQuery(graph, keyword, { budget, substring: true, maxDepth: depth });
    if (expanded.matched) {
      result = expanded;
      autoExpanded = true;
    }
  }

  if (values.json) {
    printJson(
      envelope(
        'context',
        {
          query: keyword,
          budget,
          substring: substring || autoExpanded,
          autoExpanded,
          depth: depth ?? null,
        },
        graph,
        result,
      ),
    );
    return;
  }

  const sections: string[] = [markdownHeader('Context', `\`${keyword}\``, graph)];

  if (!result.matched) {
    const grepHint = smallRepoGrepHint(graph, keyword);
    if (result.suggestions.length > 0) {
      const lines = result.suggestions
        .map((s) => `  - \`${s.key}\` (${s.hits} hit${s.hits === 1 ? '' : 's'})`)
        .join('\n');
      sections.push(
        `No symbols matched \`${keyword}\` (exact or substring). Closest by typo-distance:\n\n${lines}\n\nPick one above, or try a different keyword.`,
      );
    } else {
      sections.push(
        `No symbols matched \`${keyword}\` — exact or substring — and no close alternatives. Try a different keyword.`,
      );
    }
    if (grepHint) sections.push(grepHint);
    printMarkdown(...sections);
    return;
  }
  if (autoExpanded) {
    sections.push('_(no exact symbol match — expanded via substring)_');
  }

  // Anchor — the "start here" line.
  if (result.anchor) {
    const a = result.anchor;
    const where = a.line ? `${a.sourceFile}:${a.line}` : a.sourceFile;
    sections.push(
      `**Start here:** \`${a.symbol}\` — \`${where}\` (called from ${a.calledFrom} place${a.calledFrom === 1 ? '' : 's'}).`,
    );
  }

  // Blast radius — change-impact framing.
  const { callers, callerFiles } = result.blastRadius;
  if (callers > 0) {
    sections.push(
      `**Blast radius:** changing the matched symbol${result.selection.some((s) => s.hop === 0) ? '(s)' : ''} touches ${callers} caller${callers === 1 ? '' : 's'} across ${callerFiles} file${callerFiles === 1 ? '' : 's'}.`,
    );
  } else {
    sections.push('**Blast radius:** no internal callers — likely an entry point or public API.');
  }

  // Community-grouped symbol listing (orientation). Each group is
  // ranked seeds-first then by call in-degree, and capped for
  // readability — the markdown is a scannable map, not an exhaustive
  // dump. The full selection is always available via `--json`.
  const PER_COMMUNITY_CAP = 12;
  for (const group of result.byCommunity) {
    const heading =
      group.communityId !== undefined
        ? `### ${group.role} (community ${group.communityId})`
        : `### ${group.role}`;
    const lines = [heading];
    const groupSel = dedupeBySymbol(
      result.selection
        .filter((s) => group.symbols.includes(s.symbol))
        .sort((a, b) => a.hop - b.hop || b.callsIn - a.callsIn),
    );
    for (const s of groupSel.slice(0, PER_COMMUNITY_CAP)) {
      const where = s.line ? `${s.sourceFile}:${s.line}` : s.sourceFile;
      const seed = s.hop === 0 ? ' _[seed]_' : '';
      lines.push(`- \`${s.symbol}\` — \`${where}\` (${s.callsIn} in / ${s.callsOut} out)${seed}`);
    }
    if (groupSel.length > PER_COMMUNITY_CAP) {
      lines.push(`- _+${groupSel.length - PER_COMMUNITY_CAP} more in this cluster_`);
    }
    sections.push(lines.join('\n'));
  }

  // Honest truncation footer.
  if (result.truncated) {
    sections.push(
      `_+${result.omittedCount} more symbol${result.omittedCount === 1 ? '' : 's'} omitted to fit the ${result.budget}-token budget — narrow the query or raise \`--budget\`._`,
    );
  }

  // Same-name conflation caveat — only when there's any risk worth noting.
  sections.push(
    '_Note: graphify conflates same-name symbols across files, so call counts are best-effort._',
  );

  printMarkdown(...sections);
}

/**
 * `vyuh-dxkit context <file:line>` — hand back the focused source chunk
 * around a location plus its structural neighborhood, so an agent reads
 * ~the enclosing symbol instead of the whole file. The graph resolves
 * the enclosing symbol + blast radius + callers/callees; the source
 * slice itself is read from disk (the graph carries no source text) and
 * carved to the budget by `extractWindow`, centered on the requested
 * line.
 *
 * Degrades in layers: if the file isn't in the graph we still return a
 * centered raw-line window (no structural context); if the file can't
 * be read we exit non-zero with a clear message.
 */
function runFileLineContext(
  graph: Graph,
  file: string,
  line: number,
  values: ExploreCliValues,
  cwd: string,
): void {
  const budget = parsePositiveInt(values.budget, DEFAULT_BUDGET);

  // Read the source from disk. The graph stores project-relative paths,
  // so resolve against cwd. A missing file is the one hard error here —
  // there's nothing to slice.
  let text: string;
  try {
    text = readFileSync(path.join(cwd, file), 'utf-8');
  } catch {
    process.stderr.write(
      `Cannot read ${file} (resolved under ${cwd}). Pass a path relative to the repo root.\n`,
    );
    process.exit(1);
  }

  const ctx = fileLineContextQuery(graph, file, line);
  // Stamp call-graph reliability from the language pack (Rule 6), so the
  // blast-radius reads honestly for languages graphify can't resolve.
  const rel = languageForFile(file)?.callGraphReliability;
  if (rel && rel !== 'full') ctx.callGraphReliability = rel;

  const chunk = extractWindow(text, line, {
    budgetTokens: budget,
    spanStart: ctx.span?.startLine,
    spanEndExclusive: ctx.span?.endLineExclusive,
  });

  if (values.json) {
    printJson(envelope('context', { file, line, budget }, graph, { ...ctx, chunk }));
    return;
  }

  const sections: string[] = [markdownHeader('Context', `\`${file}:${line}\``, graph)];

  // Enclosing-symbol + module + blast-radius framing.
  if (ctx.enclosingSymbol) {
    const s = ctx.enclosingSymbol;
    sections.push(
      `**Enclosing symbol:** \`${s.symbol}\` — \`${file}:${s.line}\` · ${s.kind} (${s.callsIn} in / ${s.callsOut} out). _Heuristic: declaration-to-next-declaration; confirm the boundary before editing._`,
    );
  } else if (ctx.found) {
    sections.push(
      '**Enclosing symbol:** none at-or-above this line (top-of-file / imports). Showing a centered window.',
    );
  } else {
    sections.push(
      '**Enclosing symbol:** file not in the code graph (vendored / autogenerated / unsupported, or not yet scanned). Showing a centered raw-line window — no structural context.',
    );
  }

  if (ctx.found) {
    const role = ctx.community?.role ?? 'unclustered';
    if (ctx.callGraphReliability === 'unreliable') {
      sections.push(`**Module:** ${role} · blast radius n/a (call graph can't be resolved here).`);
    } else {
      const n = ctx.blastRadius.callerFiles;
      sections.push(`**Module:** ${role} · blast radius: ${n} caller file${n === 1 ? '' : 's'}.`);
    }
  }

  // The source chunk — line-numbered for navigation, fenced with the
  // file's language for syntax highlighting.
  sections.push(renderChunk(file, chunk));
  if (chunk.truncated) {
    sections.push(
      `_Showing lines ${chunk.startLine}–${chunk.endLine} of the ${chunk.spanLines}-line span — raise \`--budget\` to widen the window._`,
    );
  }

  // Callers / callees of the enclosing symbol (structural neighborhood).
  if (ctx.callers.length > 0) {
    sections.push(
      ['**Callers (who reaches this symbol):**', ...ctx.callers.map(refLine)].join('\n'),
    );
  }
  if (ctx.callees.length > 0) {
    sections.push(['**Calls out to:**', ...ctx.callees.map(refLine)].join('\n'));
  }

  if (ctx.found) {
    sections.push(
      '_Note: blast radius is file-level and graphify can conflate same-name symbols, so call counts are best-effort._',
    );
  }

  printMarkdown(...sections);
}

/** One `- \`symbol\` — \`file:line\`` reference line. */
function refLine(r: { symbol: string; sourceFile: string; line?: number }): string {
  const where = r.line ? `${r.sourceFile}:${r.line}` : r.sourceFile;
  return `- \`${r.symbol}\` — \`${where}\``;
}

/** Render the slice as a line-numbered, language-fenced code block. */
function renderChunk(file: string, chunk: { startLine: number; lines: string[] }): string {
  const lang = fenceLanguage(file);
  const width = String(chunk.startLine + chunk.lines.length - 1).length;
  const body = chunk.lines
    .map((l, i) => `${String(chunk.startLine + i).padStart(width)}  ${l}`)
    .join('\n');
  return '```' + lang + '\n' + body + '\n```';
}

/** Map a file extension to a markdown code-fence language tag. */
function fenceLanguage(file: string): string {
  const i = file.lastIndexOf('.');
  if (i < 0) return '';
  const map: Record<string, string> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.cjs': 'js',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.cs': 'csharp',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.java': 'java',
    '.rb': 'ruby',
  };
  return map[file.slice(i).toLowerCase()] ?? '';
}

/**
 * Collapse repeated symbol names within a community group. The BFS can
 * surface the same stripped label from two different files (graphify's
 * same-name conflation); the listing keeps the first (lowest-hop)
 * occurrence so the output stays scannable.
 */
function dedupeBySymbol(nodes: ContextNode[]): ContextNode[] {
  const seen = new Set<string>();
  const out: ContextNode[] = [];
  for (const n of nodes) {
    const key = `${n.symbol}\x00${n.sourceFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  return n;
}
