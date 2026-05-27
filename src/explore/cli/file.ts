/**
 * `vyuh-dxkit explore file <path>` — drill into a single file's
 * neighborhood. Per CLAUDE.md Rule 12: graph traversal flows through
 * queries.ts.
 *
 * If the user passes an absolute path, convert to project-relative
 * (the graph artifact uses project-relative paths throughout).
 */

import * as path from 'node:path';
import { fileSummaryQuery } from '../queries';
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

export function runFile(
  graph: Graph,
  positionals: ReadonlyArray<string>,
  values: ExploreCliValues,
  cwd: string,
): void {
  const rawPath = positionals[0];
  if (!rawPath) {
    process.stderr.write(
      'Usage: vyuh-dxkit explore file <path>\nProvide a path (relative or absolute) to a source file in the repo.\n',
    );
    process.exit(1);
  }

  // Convert absolute to project-relative if needed. Graphify writes
  // project-relative paths to graph.json so the lookup key must
  // match that shape.
  const resolved = path.isAbsolute(rawPath)
    ? path.relative(cwd, rawPath).replace(/\\/g, '/')
    : rawPath.replace(/\\/g, '/');

  const result = fileSummaryQuery(graph, resolved);

  if (values.json) {
    printJson(envelope('explore.file', { path: resolved }, graph, result));
    return;
  }

  if (!result.found) {
    printMarkdown(
      markdownHeader('File', resolved, graph),
      `File \`${resolved}\` is not in the graph. Common reasons:\n` +
        `- File doesn't exist (typo in path?)\n` +
        `- Excluded by .dxkit-ignore / minified-detection / unsupported extension\n` +
        `- Pack for this file's language isn't active in the project`,
    );
    return;
  }

  const symbolRows = result.symbols.map((s) => ({
    Kind: s.kind,
    Symbol: s.label,
    Line: s.line ?? '',
    Exported: s.exported === undefined ? '?' : s.exported ? '✓' : '·',
    'Calls in': s.callsIn,
    'Calls out': s.callsOut,
  }));
  const symbolHeaders = ['Kind', 'Symbol', 'Line', 'Exported', 'Calls in', 'Calls out'] as const;

  const callerRows = result.callerFiles
    .slice(0, 20)
    .map((c) => ({ File: c.sourceFile, Calls: c.count }));
  const calleeRows = result.calleeFiles
    .slice(0, 20)
    .map((c) => ({ File: c.sourceFile, Calls: c.count }));

  const sections: string[] = [];
  sections.push(markdownHeader('File', resolved, graph));

  // Community + summary line
  const summary: string[] = [];
  if (result.communityId !== undefined) {
    const dir = result.communityLabel || '—';
    const pack = result.communityPack || '—';
    summary.push(`**Community**: ${result.communityId} (${dir}, ${pack})`);
  }
  const kindCounts: Record<string, number> = {};
  for (const s of result.symbols) kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
  const symBreakdown = Object.entries(kindCounts)
    .map(([k, c]) => `${c} ${k}${c === 1 ? '' : 's'}`)
    .join(', ');
  if (symBreakdown) summary.push(`**Symbols**: ${symBreakdown}`);
  const exportedSymbols = result.symbols.filter((s) => s.exported === true);
  if (exportedSymbols.length > 0) {
    summary.push(
      `**Exported**: ${exportedSymbols
        .map((s) => s.label)
        .slice(0, 8)
        .join(', ')}${exportedSymbols.length > 8 ? ` (+${exportedSymbols.length - 8} more)` : ''}`,
    );
  }
  if (summary.length > 0) sections.push(summary.join('\n'));

  if (symbolRows.length > 0) {
    sections.push('### Symbols defined here');
    sections.push(markdownTable(symbolHeaders, symbolRows));
  }

  if (callerRows.length > 0) {
    sections.push(
      `### Callers (${result.callerFiles.length} file${result.callerFiles.length === 1 ? '' : 's'})`,
    );
    sections.push(markdownTable(['File', 'Calls'] as const, callerRows));
  } else {
    sections.push(
      '### Callers\n\nNo other files call into this file. Either it is a leaf module (entry point, top-level CLI handler) or its consumers are outside the graphify-extracted set.',
    );
  }

  if (calleeRows.length > 0) {
    sections.push(
      `### Callees (${result.calleeFiles.length} file${result.calleeFiles.length === 1 ? '' : 's'})`,
    );
    sections.push(markdownTable(['File', 'Calls'] as const, calleeRows));
  }

  if (result.importsOut.length > 0) {
    sections.push(
      `### Imports out (${result.importsOut.length} file${result.importsOut.length === 1 ? '' : 's'})`,
    );
    sections.push(result.importsOut.map((i) => `- ${i.sourceFile}`).join('\n'));
  }
  if (result.importsIn.length > 0) {
    sections.push(
      `### Imports in (${result.importsIn.length} file${result.importsIn.length === 1 ? '' : 's'})`,
    );
    sections.push(result.importsIn.map((i) => `- ${i.sourceFile}`).join('\n'));
  }

  sections.push(markdownFooter('Drill into a caller: `vyuh-dxkit explore file <path>`.'));

  printMarkdown(...sections);
}
