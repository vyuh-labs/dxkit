/**
 * `vyuh-dxkit explore hot-files` — files most depended on.
 *
 * Pure pipeline: parse args → call hotFilesQuery → format output.
 * No graph traversal in here (CLAUDE.md Rule 12 enforces);
 * everything goes through src/explore/queries.ts.
 */

import { hotFilesQuery, type HotFileResult } from '../queries';
import {
  envelope,
  markdownFooter,
  markdownHeader,
  markdownTable,
  printJson,
  printMarkdown,
} from '../format';
import type { Graph } from '../types';
import type { ExploreCliValues } from '../../explore-cli';

const DEFAULT_LIMIT = 20;

export function runHotFiles(
  graph: Graph,
  _positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
): void {
  const limit = parseLimit(values.limit, DEFAULT_LIMIT);
  const results = hotFilesQuery(graph, limit);

  if (values.json) {
    printJson(envelope('explore.hot-files', { limit }, graph, results));
    return;
  }

  // Markdown: header, table, footer hint.
  const rows = results.map((r) => ({
    Path: r.sourceFile,
    'Calls in': r.callsIn,
    'Imports in': r.importsIn,
    'Calls out': r.callsOut,
    Community: r.communityLabel
      ? `${r.communityId} (${r.communityLabel})`
      : r.communityId !== undefined
        ? String(r.communityId)
        : '',
  }));
  const headers = ['Path', 'Calls in', 'Imports in', 'Calls out', 'Community'] as const;

  if (results.length === 0) {
    printMarkdown(
      markdownHeader('Hot files', "what's central?", graph),
      'No files found in the graph. Either the repo has no inbound call edges, or the graph artifact is empty.',
    );
    return;
  }

  printMarkdown(
    markdownHeader('Hot files', "what's central?", graph),
    markdownTable(headers, rows),
    explainResults(results),
    markdownFooter('Drill into one: `vyuh-dxkit explore file <path>`.'),
  );
}

/**
 * One-line interpretation hint below the table. A file with high
 * "calls in" + low "calls out" is foundational infrastructure;
 * inverting that signals a coordinator / orchestrator.
 */
function explainResults(results: HotFileResult[]): string {
  if (results.length === 0) return '';
  const top = results[0];
  const ratio = top.callsOut > 0 ? top.callsIn / top.callsOut : top.callsIn;
  if (ratio >= 3) {
    return `A file with high "calls in" + low "calls out" is foundational infrastructure. \`${top.sourceFile}\` looks like one.`;
  }
  return 'A file with high "calls in" + low "calls out" is foundational infrastructure.';
}

function parseLimit(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  return Math.min(n, 1000); // sanity cap
}
