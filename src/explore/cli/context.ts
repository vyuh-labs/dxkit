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

import { contextQuery, type ContextNode } from '../queries';
import { envelope, markdownHeader, printJson, printMarkdown } from '../format';
import type { Graph } from '../types';
import type { ExploreCliValues } from '../../explore-cli';

const DEFAULT_BUDGET = 2000;

export function runContext(
  graph: Graph,
  positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
): void {
  const keyword = positionals[0];
  if (!keyword) {
    process.stderr.write(
      'Usage: vyuh-dxkit context <query> [--substring] [--budget 2000] [--depth N] [--json]\n',
    );
    process.exit(1);
  }

  const budget = parsePositiveInt(values.budget, DEFAULT_BUDGET);
  const depth = values.depth !== undefined ? parsePositiveInt(values.depth, Infinity) : undefined;
  const substring = !!values.substring;

  const result = contextQuery(graph, keyword, { budget, substring, maxDepth: depth });

  if (values.json) {
    printJson(
      envelope(
        'context',
        { query: keyword, budget, substring, depth: depth ?? null },
        graph,
        result,
      ),
    );
    return;
  }

  const sections: string[] = [markdownHeader('Context', `\`${keyword}\``, graph)];

  if (!result.matched) {
    if (result.suggestions.length > 0) {
      const lines = result.suggestions
        .map((s) => `  - \`${s.key}\` (${s.hits} hit${s.hits === 1 ? '' : 's'})`)
        .join('\n');
      sections.push(
        `No symbols matched \`${keyword}\`. Did you mean:\n\n${lines}\n\nRerun with \`--substring\` to expand from these, or pick one above.`,
      );
    } else {
      sections.push(
        `No symbols matched \`${keyword}\` (no close alternatives either). Try a different keyword or \`--substring\` for broader matching.`,
      );
    }
    printMarkdown(...sections);
    return;
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
