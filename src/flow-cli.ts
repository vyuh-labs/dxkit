/**
 * `vyuh-dxkit flow extract` — the flow-map CSV command. Thin CLI wrapper: it
 * resolves roots + config, calls the gather engine, and writes the parity CSVs.
 * All analysis lives in `src/analyzers/flow/`; this file only wires I/O.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as logger from './logger';
import { gatherFlowModel } from './analyzers/flow/gather';
import { flowCsvFiles } from './analyzers/flow/csv';
import { summarize } from './analyzers/flow/model';

export interface FlowExtractOptions {
  readonly cwd: string;
  readonly frontend?: string;
  readonly backend?: string;
  /** Comma-separated OpenAPI spec paths (served side, unioned with static). */
  readonly specs?: string;
  readonly out?: string;
  readonly json?: boolean;
}

/** Host-helper strip prefixes from `.dxkit/policy.json:flow.stripUrlPrefixes`. */
function readStripPrefixes(cwd: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.dxkit', 'policy.json'), 'utf8');
    const prefixes = (JSON.parse(raw) as { flow?: { stripUrlPrefixes?: unknown } })?.flow
      ?.stripUrlPrefixes;
    return Array.isArray(prefixes)
      ? prefixes.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

function splitPaths(value: string | undefined, cwd: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(cwd, s));
}

export async function runFlowExtract(opts: FlowExtractOptions): Promise<void> {
  const roots: string[] = [];
  if (opts.frontend) roots.push(path.resolve(opts.cwd, opts.frontend));
  if (opts.backend) roots.push(path.resolve(opts.cwd, opts.backend));
  if (roots.length === 0) roots.push(opts.cwd); // monorepo default: scan cwd

  logger.header('vyuh-dxkit flow extract');
  const model = await gatherFlowModel({
    roots,
    specs: splitPaths(opts.specs, opts.cwd),
    stripUrlPrefixes: readStripPrefixes(opts.cwd),
  });
  const summary = summarize(model);

  const outDir = path.resolve(opts.cwd, opts.out ?? 'csv_output');
  fs.mkdirSync(outDir, { recursive: true });
  const files = flowCsvFiles(model);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), content);
  }

  if (opts.json) {
    logger.info(JSON.stringify({ ...summary, outDir, files: Object.keys(files) }));
    return;
  }
  const pct = summary.calls ? Math.round((100 * summary.resolved) / summary.calls) : 0;
  logger.success(
    `${summary.calls} client calls, ${summary.routes} routes · ${summary.resolved}/${summary.calls} bound (${pct}%)`,
  );
  logger.info(`CSVs written to ${outDir} — ${Object.keys(files).join(', ')}`);
}
