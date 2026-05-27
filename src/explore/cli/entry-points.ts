/**
 * `vyuh-dxkit explore entry-points` — what does this repo do?
 *
 * Cross-references graph nodes with the active packs'
 * architecturalShape (per CLAUDE.md Rule 8 — no hardcoded framework
 * strings here). Detects the project's stack via `detect(cwd)` so
 * only active-pack patterns contribute.
 */

import { detect } from '../../detect';
import { allPrimaryComponentPaths, allRoutePaths, dominantVocabulary } from '../../languages';
import { entryPointsQuery, type EntryPointResult } from '../queries';
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

const DEFAULT_LIMIT = 10;

export function runEntryPoints(
  graph: Graph,
  _positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
  cwd: string,
): void {
  const limit = parseLimit(values.limit, DEFAULT_LIMIT);

  const stack = detect(cwd);
  const primaryPaths = allPrimaryComponentPaths(stack.languages);
  const routePaths = allRoutePaths(stack.languages);
  const vocabulary = dominantVocabulary(stack.languages);

  const results = entryPointsQuery(graph, primaryPaths, routePaths, limit);

  if (values.json) {
    printJson(
      envelope(
        'explore.entry-points',
        { limit, primaryPaths, routePaths, packs: graph.meta.packs },
        graph,
        results,
      ),
    );
    return;
  }

  if (primaryPaths.length === 0 && routePaths.length === 0) {
    printMarkdown(
      markdownHeader('Entry points', 'what does this repo do?', graph),
      `No entry-point patterns declared for the active packs (${graph.meta.packs.join(', ') || 'none detected'}).\n\n` +
        'Each language pack declares its own primary-component / route path conventions in `LanguageSupport.architecturalShape` (CLAUDE.md Rule 8). Packs without conventional entry-point paths (e.g. Rust) intentionally omit them.',
    );
    return;
  }

  if (results.length === 0) {
    printMarkdown(
      markdownHeader('Entry points', 'what does this repo do?', graph),
      `No source files matched the active packs' entry-point patterns.\n\n` +
        `Patterns tried: ${[...primaryPaths, ...routePaths].map((p) => `\`${p}\``).join(', ')}\n\n` +
        `Either this repo has no conventional entry points, or the patterns don't match this codebase's structure.`,
    );
    return;
  }

  // Group by componentType + emit one table per group.
  const grouped = new Map<string, EntryPointResult[]>();
  for (const r of results) {
    const key = r.componentType;
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }

  const sections: string[] = [];
  sections.push(markdownHeader('Entry points', 'what does this repo do?', graph));

  // Vocabulary line so the reader knows the pack's framing.
  const vocabLine: string[] = [];
  if (vocabulary?.components) vocabLine.push(`components → **${vocabulary.components}**`);
  if (vocabulary?.routes) vocabLine.push(`routes → **${vocabulary.routes}**`);
  if (vocabulary?.models) vocabLine.push(`models → **${vocabulary.models}**`);
  if (vocabLine.length > 0) {
    sections.push(`*Pack vocabulary*: ${vocabLine.join(', ')}.`);
  }

  for (const [type, rows] of grouped) {
    sections.push(`### ${capitalize(type)} (${rows.length})`);
    sections.push(
      markdownTable(
        ['Path', 'Symbol', 'Calls out', 'Pack'] as const,
        rows.map((r) => ({
          Path: r.line ? `${r.sourceFile}:${r.line}` : r.sourceFile,
          Symbol: r.symbol,
          'Calls out': r.callsOut,
          Pack: r.pack,
        })),
      ),
    );
  }

  sections.push(markdownFooter('Drill into one: `vyuh-dxkit explore file <path>`.'));

  printMarkdown(...sections);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function parseLimit(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  return Math.min(n, 1000);
}
