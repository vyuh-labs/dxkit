/**
 * `vyuh-dxkit explore communities` — natural-module summary.
 *
 * Pure pipeline: parse args → call communitiesQuery → format output.
 * Per CLAUDE.md Rule 12: graph traversal flows through queries.ts.
 */

import { communitiesQuery } from '../queries';
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

const DEFAULT_LIMIT = 8;

export function runCommunities(
  graph: Graph,
  _positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
): void {
  const limit = parseLimit(values.limit, DEFAULT_LIMIT);
  const results = communitiesQuery(graph, limit);

  if (values.json) {
    printJson(envelope('explore.communities', { limit }, graph, results));
    return;
  }

  if (results.length === 0) {
    printMarkdown(
      markdownHeader('Communities', 'natural modules in this repo', graph),
      'No communities found in the graph. Either the repo is too small for Louvain clustering to find structure, or the graph artifact is empty.',
    );
    return;
  }

  const rows = results.map((r) => ({
    ID: r.id,
    Dir: r.dominantSourceDir || '—',
    Pack: r.dominantPack || '—',
    Nodes: r.nodeCount,
    Cohesion: r.cohesion.toFixed(2),
    'Top hot files': r.topHotFiles.map((f) => basename(f)).join(', ') || '—',
  }));
  const headers = ['ID', 'Dir', 'Pack', 'Nodes', 'Cohesion', 'Top hot files'] as const;

  printMarkdown(
    markdownHeader('Communities', 'natural modules in this repo', graph),
    markdownTable(headers, rows),
    markdownFooter("Drill into a community's central file: `vyuh-dxkit explore file <path>`."),
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function parseLimit(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  return Math.min(n, 1000);
}
