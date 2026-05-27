/**
 * `vyuh-dxkit explore api-surface` — exported symbols with no
 * internal callers (likely public API or CLI entry points).
 *
 * Reads per-pack exportDetection reliability from the canonical
 * registry helper. Packs declared 'unreliable' (today: ruby) are
 * excluded with an explanatory note.
 */

import { allExportDetectionDeclarations } from '../../languages';
import { apiSurfaceQuery } from '../queries';
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

const DEFAULT_LIMIT = 25;

export function runApiSurface(
  graph: Graph,
  _positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
): void {
  const limit = parseLimit(values.limit, DEFAULT_LIMIT);

  const declarations = allExportDetectionDeclarations();
  const unreliablePacks = declarations
    .filter((d) => d.reliability === 'unreliable')
    .map((d) => ({ pack: d.pack, strategy: d.strategy }));
  const packsExcluded = unreliablePacks.map((u) => u.pack);

  const results = apiSurfaceQuery(graph, packsExcluded, limit);

  if (values.json) {
    printJson(
      envelope('explore.api-surface', { limit, excluded: unreliablePacks }, graph, results),
    );
    return;
  }

  const sections: string[] = [];
  sections.push(markdownHeader('API surface', 'exported symbols with no internal callers', graph));

  if (unreliablePacks.length > 0) {
    sections.push(
      `*Excluded packs* (export detection unreliable): ` +
        unreliablePacks.map((u) => `**${u.pack}** (${u.strategy})`).join('; '),
    );
  }

  if (results.length === 0) {
    sections.push(
      'No exported symbols without internal callers found. Either the codebase has no public API surface graphify could detect, or every exported symbol has at least one internal caller.',
    );
    printMarkdown(...sections);
    return;
  }

  sections.push(
    markdownTable(
      ['Path', 'Symbol', 'Kind', 'Pack'] as const,
      results.map((r) => ({
        Path: r.line ? `${r.sourceFile}:${r.line}` : r.sourceFile,
        Symbol: r.symbol,
        Kind: r.kind,
        Pack: r.pack,
      })),
    ),
  );

  sections.push(
    'These are likely public API or CLI entry points. Verify before deleting — a missing internal caller can mean "external consumer only" rather than "dead code." Future releases will add a dedicated dead-code analyzer with stronger heuristics.',
  );

  sections.push(markdownFooter('Drill into one: `vyuh-dxkit explore file <path>`.'));

  printMarkdown(...sections);
}

function parseLimit(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  return Math.min(n, 1000);
}
