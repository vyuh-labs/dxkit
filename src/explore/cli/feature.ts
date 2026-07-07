/**
 * `vyuh-dxkit explore feature <keyword>` — where is feature X
 * implemented? The marquee query of the explore CLI.
 *
 * Three-stage resolution (per Sprint 0 spec):
 *   1. Direct symbolIndex match
 *   2. Substring expansion (opt-in via --substring; off by default)
 *   3. Structural expansion (community + 1-hop callers/callees)
 *
 * On zero hits, prints "did you mean..." suggestions from
 * edit-distance against symbolIndex keys.
 */

import { featureQuery, type FeatureCluster } from '../queries';
import {
  envelope,
  markdownFooter,
  markdownHeader,
  markdownTable,
  printJson,
  printMarkdown,
  smallRepoGrepHint,
} from '../format';
import type { Graph } from '../types';
import type { ExploreCliValues } from '../../explore-cli';

const DEFAULT_LIMIT = 50;

export function runFeature(
  graph: Graph,
  positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
): void {
  const keyword = positionals[0];
  if (!keyword) {
    process.stderr.write(
      'Usage: vyuh-dxkit explore feature <keyword> [--substring] [--limit 50]\n',
    );
    process.exit(1);
  }

  const limit = parseLimit(values.limit, DEFAULT_LIMIT);
  const substring = !!values.substring;
  let result = featureQuery(graph, keyword, { limit, substring });

  // Auto-fall-back to substring expansion on an empty exact match, so a miss
  // does the work of two calls instead of dead-ending with "rerun with
  // --substring". Only when the caller didn't already ask for it.
  let autoExpanded = false;
  if (result.results.length === 0 && !substring) {
    const expanded = featureQuery(graph, keyword, { limit, substring: true });
    if (expanded.results.length > 0) {
      result = expanded;
      autoExpanded = true;
    }
  }

  if (values.json) {
    printJson(
      envelope(
        'explore.feature',
        { keyword, limit, substring: substring || autoExpanded, autoExpanded },
        graph,
        result,
      ),
    );
    return;
  }

  const sections: string[] = [];
  sections.push(markdownHeader('Feature', `\`${keyword}\``, graph));

  if (result.results.length === 0) {
    const grepHint = smallRepoGrepHint(graph, keyword);
    if (result.suggestions.length > 0) {
      const lines = result.suggestions
        .map((s) => `  - \`${s.key}\` (${s.hits} hit${s.hits === 1 ? '' : 's'})`)
        .join('\n');
      sections.push(
        `No exact or substring match for \`${keyword}\`. Closest symbols (typo-distance):\n\n${lines}\n\nPick a specific symbol above, or try a different keyword.`,
      );
    } else {
      sections.push(
        `No symbols matched \`${keyword}\` — exact or substring — and no close alternatives. Try a different keyword, or check \`vyuh-dxkit explore communities\` to see the natural-module structure.`,
      );
    }
    if (grepHint) sections.push(grepHint);
    printMarkdown(...sections);
    return;
  }

  // Summary line + central entry point (if any).
  const totalSeeds = result.results.reduce((sum, c) => sum + c.seedHits, 0);
  const expandNote = autoExpanded ? ' _(no exact symbol match — expanded via substring)_' : '';
  sections.push(
    `**Seed matches**: ${totalSeeds} symbol${totalSeeds === 1 ? '' : 's'} across ${result.results.length} cluster${result.results.length === 1 ? '' : 's'}.${expandNote}`,
  );

  // Per-cluster sections.
  for (const cluster of result.results) {
    sections.push(buildClusterSection(cluster));
  }

  if (result.centralEntryPoint) {
    const cep = result.centralEntryPoint;
    const where = cep.line ? `${cep.sourceFile}:${cep.line}` : cep.sourceFile;
    sections.push(
      `\nThe most-called seed symbol is **\`${cep.symbol}\`** at \`${where}\` — called from ${cep.calledFrom} place${cep.calledFrom === 1 ? '' : 's'}. A natural starting read.`,
    );
  }

  sections.push(markdownFooter('Drill into one: `vyuh-dxkit explore file <path>`.'));

  printMarkdown(...sections);
}

function buildClusterSection(cluster: FeatureCluster): string {
  const lines: string[] = [];
  const id = cluster.clusterId + 1;
  const role = cluster.role;
  const seedNote = cluster.seedHits === 0 ? ' (expansion only — no direct seed)' : '';
  lines.push(`### Cluster ${id} — ${role}${seedNote}`);
  if (cluster.communityId !== undefined) {
    lines.push(
      `*Community*: ${cluster.communityId}${cluster.dominantSourceDir ? ` (${cluster.dominantSourceDir})` : ''}`,
    );
  }
  if (cluster.keySymbols.length > 0) {
    lines.push(`*Key symbols*: ${cluster.keySymbols.map((s) => `\`${s}\``).join(', ')}`);
  }
  lines.push('');
  lines.push(
    markdownTable(
      ['File'] as const,
      cluster.files.slice(0, 12).map((f) => ({ File: f })),
    ),
  );
  if (cluster.files.length > 12) {
    lines.push(
      `\n*+ ${cluster.files.length - 12} more file${cluster.files.length - 12 === 1 ? '' : 's'}*`,
    );
  }
  return lines.join('\n');
}

function parseLimit(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return defaultValue;
  return Math.min(n, 1000);
}
