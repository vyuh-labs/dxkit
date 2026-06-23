/**
 * Shared output helpers for the explore CLI subcommands. Pure
 * formatters — JSON envelope shape + markdown table builders — so
 * each subcommand handler stays a thin pipeline (parse args → call
 * queries → format output).
 *
 * Output contract:
 *   - JSON mode emits a stable envelope: command / args / meta / results
 *   - Markdown mode emits header → meta line → result block → footer hint
 *   - Adding fields later is additive; never mutate existing field
 *     names within v1
 */

import type { Graph } from './types';

/**
 * Stable JSON envelope every `--json` mode subcommand emits. Skills
 * and scripts consume `results` directly; `meta` carries the artifact
 * provenance so consumers can detect a stale graph + decide whether
 * to suggest `--refresh`.
 */
export interface ExploreEnvelope<T> {
  command: string;
  args: Record<string, unknown>;
  meta: {
    schemaVersion: number;
    graphGeneratedAt: string;
    truncated: boolean;
  };
  results: T;
}

/**
 * Build the JSON envelope from a query result + the graph metadata.
 * Pure function — no I/O, no side effects. Subcommands call this in
 * `--json` mode and print the result via `JSON.stringify`.
 */
export function envelope<T>(
  command: string,
  args: Record<string, unknown>,
  graph: Graph,
  results: T,
): ExploreEnvelope<T> {
  return {
    command,
    args,
    meta: {
      schemaVersion: graph.schemaVersion,
      graphGeneratedAt: graph.meta.generatedAt,
      truncated: graph.meta.truncated,
    },
    results,
  };
}

/**
 * Build the standard markdown header that every subcommand emits.
 * Includes the meta line (file count + node count + generation
 * timestamp) so the reader knows what artifact they're looking at,
 * plus a truncation note when applicable.
 */
export function markdownHeader(title: string, framing: string, graph: Graph): string {
  const m = graph.meta;
  const dateOnly = m.generatedAt.slice(0, 10);
  const lines = [
    `## ${title} — ${framing}`,
    '',
    `From .dxkit/reports/graph.json (generated ${dateOnly}, ${m.sourceFilesInGraph} source files, ${graph.nodes.length} nodes).`,
  ];
  if (m.truncated) {
    lines.push('');
    lines.push(`> ⚠ Graph is truncated: ${m.truncatedReason}. Results may be incomplete.`);
  }
  return lines.join('\n');
}

/**
 * Build a markdown table from a row set. `headers` defines the
 * column order; `rows` is an array of records keyed by the same
 * header strings. Missing values render as empty strings.
 */
export function markdownTable<R extends Record<string, string | number>>(
  headers: ReadonlyArray<keyof R & string>,
  rows: ReadonlyArray<R>,
): string {
  if (rows.length === 0) return '';
  const lines: string[] = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const row of rows) {
    const cells = headers.map((h) => {
      const v = row[h];
      return v === undefined || v === null ? '' : String(v);
    });
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * Build the standard footer hint pointing at the natural next
 * subcommand. Optional; subcommands omit when no clear next step.
 */
export function markdownFooter(hint: string): string {
  return `\n${hint}`;
}

/**
 * Print a JSON envelope to stdout. Output is single-line (no
 * pretty-print) so it stays pipe-friendly for `jq` consumers.
 */
export function printJson<T>(env: ExploreEnvelope<T>): void {
  process.stdout.write(JSON.stringify(env) + '\n');
}

/**
 * Print markdown sections to stdout, joined by a blank line. Each
 * section is a multi-line string built by the helpers above.
 */
export function printMarkdown(...sections: string[]): void {
  process.stdout.write(sections.filter((s) => s && s.length > 0).join('\n\n') + '\n');
}
