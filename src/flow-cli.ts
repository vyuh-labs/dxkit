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
import { summarize, type FlowModel } from './analyzers/flow/model';
import { buildFlowMap, buildFlowTrace } from './explore/flow-view';

export interface FlowExtractOptions {
  readonly cwd: string;
  readonly frontend?: string;
  readonly backend?: string;
  /** Comma-separated OpenAPI spec paths (served side, unioned with static). */
  readonly specs?: string;
  readonly out?: string;
  readonly json?: boolean;
}

/** Shared options for the graph-backed `flow` / `flow trace` views. */
export interface FlowViewOptions {
  readonly cwd: string;
  readonly frontend?: string;
  readonly backend?: string;
  readonly specs?: string;
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

/**
 * Emit a machine payload to stdout. In `--json` mode cli.ts routes all logger
 * prose to stderr (`setJsonMode`), so the JSON contract requires writing the
 * payload straight to stdout — never through the logger, which would land it on
 * stderr and corrupt the contract. Mirrors the allowlist / reviewers CLIs.
 */
function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function splitPaths(value: string | undefined, cwd: string): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(cwd, s));
}

/** Resolve scan roots from --frontend/--backend, defaulting to cwd (monorepo). */
function resolveRoots(opts: { cwd: string; frontend?: string; backend?: string }): string[] {
  const roots: string[] = [];
  if (opts.frontend) roots.push(path.resolve(opts.cwd, opts.frontend));
  if (opts.backend) roots.push(path.resolve(opts.cwd, opts.backend));
  if (roots.length === 0) roots.push(opts.cwd);
  return roots;
}

/** Gather one flow model — shared by extract / map / trace. */
async function gatherModel(opts: FlowViewOptions): Promise<FlowModel> {
  return gatherFlowModel({
    roots: resolveRoots(opts),
    specs: splitPaths(opts.specs, opts.cwd),
    stripUrlPrefixes: readStripPrefixes(opts.cwd),
  });
}

export async function runFlowExtract(opts: FlowExtractOptions): Promise<void> {
  logger.header('vyuh-dxkit flow extract');
  const model = await gatherModel(opts);
  const summary = summarize(model);

  const outDir = path.resolve(opts.cwd, opts.out ?? 'csv_output');
  fs.mkdirSync(outDir, { recursive: true });
  const files = flowCsvFiles(model);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outDir, name), content);
  }

  if (opts.json) {
    emitJson({ ...summary, outDir, files: Object.keys(files) });
    return;
  }
  const pct = summary.calls ? Math.round((100 * summary.resolved) / summary.calls) : 0;
  logger.success(
    `${summary.calls} client calls, ${summary.routes} routes · ${summary.resolved}/${summary.calls} bound (${pct}%)`,
  );
  logger.info(`CSVs written to ${outDir} — ${Object.keys(files).join(', ')}`);
}

/**
 * `vyuh-dxkit flow` — the traceability map. Writes the flow overlay onto
 * graph.json (the native artifact the dashboard + gate also read) and prints
 * every served endpoint with how many UI surfaces consume it, plus the
 * served-but-unconsumed set (dead-route or cross-repo candidates).
 */
export async function runFlowMap(opts: FlowViewOptions): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow');
  const model = await gatherModel(opts);
  const map = buildFlowMap(opts.cwd, model);

  if (opts.json) {
    emitJson(map);
    return;
  }

  logger.success(
    `${map.totalEndpoints} endpoints · ${map.totalBindings} UI→API bindings · ${map.unconsumedEndpoints.length} unconsumed`,
  );
  if (map.endpoints.length) {
    logger.info('');
    logger.info('Consumed endpoints (by UI surfaces):');
    for (const row of map.endpoints) {
      const files = row.consumerFiles.slice(0, 3).join(', ');
      const more = row.consumerFiles.length > 3 ? ` +${row.consumerFiles.length - 3} more` : '';
      logger.info(`  ${row.endpoint.label}  ← ${row.consumerCount} call(s): ${files}${more}`);
    }
  }
  if (map.unconsumedEndpoints.length) {
    logger.info('');
    logger.info('Served but unconsumed (dead route or cross-repo consumer):');
    for (const ep of map.unconsumedEndpoints.slice(0, 20)) {
      logger.info(`  ${ep.label}`);
    }
    if (map.unconsumedEndpoints.length > 20) {
      logger.info(`  … and ${map.unconsumedEndpoints.length - 20} more`);
    }
  }
  logger.info('');
  logger.info('Trace one: vyuh-dxkit flow trace "<METHOD> <path>"');
}

/**
 * `vyuh-dxkit flow trace "<METHOD> <path>"` — the full trace for one endpoint:
 * its served-side handler + every UI call site + the change blast radius.
 */
export async function runFlowTrace(opts: FlowViewOptions & { target: string }): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow trace');
  const model = await gatherModel(opts);
  const { trace, candidates } = buildFlowTrace(opts.cwd, model, opts.target);

  if (opts.json) {
    emitJson({ trace, candidates });
    return;
  }

  if (!trace.found || !trace.endpoint) {
    logger.fail(`No endpoint matches "${opts.target}".`);
    if (candidates.length) {
      logger.info('Known endpoints:');
      for (const c of candidates.slice(0, 20)) logger.info(`  ${c}`);
      if (candidates.length > 20) logger.info(`  … and ${candidates.length - 20} more`);
    }
    return;
  }

  const ep = trace.endpoint;
  logger.success(ep.label);
  logger.info(`  handler: ${trace.handler ?? '(unknown)'}  ·  via: ${ep.via}`);
  logger.info(`  served at: ${ep.sourceFile}${ep.line ? `:${ep.line}` : ''}`);
  logger.info('');
  if (trace.consumers.length) {
    logger.info(`Consumed by ${trace.consumers.length} UI call site(s):`);
    for (const c of trace.consumers) {
      const sym = c.symbol ? `${c.symbol}  ` : '';
      logger.info(`  ${sym}${c.file}${c.line ? `:${c.line}` : ''}`);
    }
  } else {
    logger.info('No UI call site in this scan consumes it.');
  }
  const br = trace.blastRadius;
  logger.info('');
  logger.info(
    `Blast radius: ${br.directConsumers} direct consumer(s) in ${br.consumerFiles} file(s)` +
      (br.upstreamCallers ? `, ${br.upstreamCallers} upstream caller(s)` : ''),
  );
}
