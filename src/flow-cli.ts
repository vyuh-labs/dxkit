/**
 * `vyuh-dxkit flow extract` — the flow-map CSV command. Thin CLI wrapper: it
 * resolves roots + config, calls the gather engine, and writes the parity CSVs.
 * All analysis lives in `src/analyzers/flow/`; this file only wires I/O.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as logger from './logger';
import { gatherFlowModel } from './analyzers/flow/gather';
import { flowCsvFiles } from './analyzers/flow/csv';
import { summarize, type FlowModel } from './analyzers/flow/model';
import { buildFlowMap, buildFlowTrace } from './explore/flow-view';
import { readFlowConfig } from './analyzers/flow/config';
import {
  buildConsumedContract,
  buildServedContract,
  writeConsumedContract,
  writeServedContract,
} from './analyzers/flow/contract';
import { publishFlow } from './analyzers/flow/publish';
import {
  buildFlowConsole,
  type ConsoleEndpoint,
  type FlowConsoleInput,
} from './analyzers/flow/console';
import { computeChangedFiles } from './baseline/changed-files';
import { evaluateFlowGateForGuardrail } from './baseline/flow-gate-check';
import { loadAllowlist } from './allowlist/file';
import { readVisNetworkBundle } from './dashboard/vendor';
import { readDxkitVersion } from './issue-cli';

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

/** Gather one flow model — shared by extract / map / trace / refresh. Specs
 *  come from BOTH the `--specs` flag and `.dxkit/policy.json:flow.specs`; strip
 *  prefixes and other flow config come from that same policy section. */
async function gatherModel(
  opts: FlowViewOptions,
  extra?: { relativeTo?: string },
): Promise<FlowModel> {
  const config = readFlowConfig(opts.cwd);
  const policySpecs = config.specs.map((s) => path.resolve(opts.cwd, s));
  return gatherFlowModel({
    roots: resolveRoots(opts),
    specs: [...splitPaths(opts.specs, opts.cwd), ...policySpecs],
    stripUrlPrefixes: config.stripUrlPrefixes,
    ...(extra?.relativeTo !== undefined ? { relativeTo: extra.relativeTo } : {}),
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

/** Default on-disk location for the generated console artifact. */
const CONSOLE_REPORT_REL = path.join('.dxkit', 'reports', 'flow-console.html');

export interface FlowConsoleOptions extends FlowViewOptions {
  /** Base ref to scope the console to (and gate against). Absent → full map. */
  readonly diff?: string;
  /** Output HTML path (default `.dxkit/reports/flow-console.html`). */
  readonly out?: string;
  /** Skip the broken-integration gate pass even in diff scope. */
  readonly noGate?: boolean;
}

/**
 * `vyuh-dxkit flow console` — generate the self-contained interactive HTML
 * console (design §E): the UI→API map plus a browser-side request runner per
 * endpoint. A renderer over the same `FlowModel` the map/gate read; dxkit makes
 * no HTTP call, it only writes the document.
 *
 * With `--diff <ref>` the console is PR-scoped: only endpoints the change
 * touches are shown, and the integration gate marks any net-new broken bindings
 * so a reviewer can exercise exactly what moved. Without it, the full map.
 */
export async function runFlowConsole(opts: FlowConsoleOptions): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow console');

  // Diff scope: the files this change touched (or null → can't scope → full).
  // Computed BEFORE the overlay write below so dxkit's own `graph.json` output
  // never leaks into the changed set.
  let scope: 'full' | 'diff' = opts.diff ? 'diff' : 'full';
  let changedSet: Set<string> | null = null;
  let diffFileCount: number | undefined;
  if (opts.diff) {
    const changed = computeChangedFiles(opts.cwd, opts.diff);
    if (changed) {
      changedSet = new Set(changed);
      diffFileCount = changed.length;
    } else {
      scope = 'full'; // base unreachable / not a git repo → don't fake a scope
    }
  }

  // Repo-relative locators — diff scoping matches `computeChangedFiles` (which
  // reports repo-relative paths) and the artifact is portable across machines
  // (Rule 9 pattern, as `flow refresh`).
  const model = await gatherModel(opts, { relativeTo: opts.cwd });
  const map = buildFlowMap(opts.cwd, model);
  const isAffected = (sourceFile: string, consumerFiles: readonly string[]): boolean =>
    changedSet !== null &&
    (changedSet.has(sourceFile) || consumerFiles.some((f) => changedSet!.has(f)));

  // Gate: net-new broken integrations for this change (diff scope only).
  const broken: ConsoleEndpoint[] = [];
  if (scope === 'diff' && opts.diff && !opts.noGate) {
    try {
      const outcome = await evaluateFlowGateForGuardrail({
        cwd: opts.cwd,
        baseRef: opts.diff,
        allowlist: loadAllowlist(opts.cwd),
      });
      if (outcome.ran) {
        for (const f of outcome.findings) {
          broken.push({
            id: f.id,
            method: f.method,
            path: f.path,
            via: 'call-site',
            handler: null,
            sourceFile: f.file,
            line: f.line,
            consumerCount: 1,
            consumerFiles: [f.file],
            affected: true,
            broken: { reason: f.reason, verdict: f.verdict },
          });
        }
      }
    } catch {
      // Fail-open: the console is a reviewer aid, never itself a gate.
    }
  }

  const consumed: ConsoleEndpoint[] = map.endpoints.map((e) => ({
    id: e.endpoint.id,
    method: e.endpoint.method,
    path: e.endpoint.path,
    via: e.endpoint.via,
    handler: e.endpoint.handler,
    sourceFile: e.endpoint.sourceFile,
    line: e.endpoint.line,
    consumerCount: e.consumerCount,
    consumerFiles: e.consumerFiles,
    affected: isAffected(e.endpoint.sourceFile, e.consumerFiles),
  }));
  const unconsumed: ConsoleEndpoint[] = map.unconsumedEndpoints.map((ep) => ({
    id: ep.id,
    method: ep.method,
    path: ep.path,
    via: ep.via,
    handler: ep.handler,
    sourceFile: ep.sourceFile,
    line: ep.line,
    consumerCount: 0,
    consumerFiles: [],
    affected: isAffected(ep.sourceFile, []),
  }));

  const shownEndpoints = scope === 'diff' ? consumed.filter((e) => e.affected) : consumed;
  const shownUnconsumed = scope === 'diff' ? unconsumed.filter((e) => e.affected) : unconsumed;

  const bundle = readVisNetworkBundle() ?? '';
  const input: FlowConsoleInput = {
    repoName: path.basename(path.resolve(opts.cwd)),
    generatedAt: new Date().toISOString(),
    dxkitVersion: readDxkitVersion(),
    scope,
    baseRef: scope === 'diff' ? opts.diff : undefined,
    diffFileCount,
    endpoints: shownEndpoints,
    unconsumed: shownUnconsumed,
    broken,
    totals: { endpoints: map.totalEndpoints, bindings: map.totalBindings },
    visNetworkBundle: bundle,
  };
  const html = buildFlowConsole(input);
  const outPath = path.resolve(opts.cwd, opts.out ?? CONSOLE_REPORT_REL);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);

  if (opts.json) {
    emitJson({
      outPath,
      scope,
      totalEndpoints: map.totalEndpoints,
      shownEndpoints: shownEndpoints.length + shownUnconsumed.length,
      broken: broken.length,
      bindings: map.totalBindings,
      hasGraph: !!bundle,
    });
    return;
  }

  const scopeNote =
    scope === 'diff'
      ? `scoped to ${diffFileCount ?? '?'} changed file(s) vs ${opts.diff}`
      : 'full map';
  logger.success(
    `Flow console written (${scopeNote}): ${map.totalEndpoints} endpoint(s), ${broken.length} net-new break(s).`,
  );
  logger.info(`  ${path.relative(opts.cwd, outPath)}`);
  logger.info('');
  logger.info(
    'Open it in a browser, enter a dev/staging Base URL + token, and exercise the calls.',
  );
  logger.info(
    'Auth stays in your tab — dxkit generated this page statically and makes no requests.',
  );
}

/** Current HEAD commit SHA, or undefined outside a git repo (best-effort). */
function headCommitSha(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `vyuh-dxkit flow refresh` — write this repo's flow contract snapshots
 * (`.dxkit/flow/served.json` + `consumed.json`). A backend commits `served.json`
 * so a frontend in another repo can gate against it; a frontend commits
 * `consumed.json` so a backend can see who still binds each route. A monorepo
 * commits both (or neither — its guardrail computes both sides live). This is
 * the one command that needs a full flow gather + write; the per-PR gate reads
 * the committed snapshots (or gathers live in a monorepo) without a refresh.
 */
export async function runFlowRefresh(opts: FlowViewOptions): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow refresh');
  // Repo-relative locators — the snapshots are committed + cross-repo, so a
  // binding's `file` must mean the same thing on every machine (Rule 9).
  const model = await gatherModel(opts, { relativeTo: opts.cwd });
  const meta = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    ...(headCommitSha(opts.cwd) !== undefined ? { commitSha: headCommitSha(opts.cwd) } : {}),
  };
  const served = buildServedContract(model, meta);
  const consumed = buildConsumedContract(model, meta);
  const servedPath = writeServedContract(opts.cwd, served);
  const consumedPath = writeConsumedContract(opts.cwd, consumed);

  if (opts.json) {
    emitJson({
      served: { path: servedPath, routes: served.routes.length },
      consumed: { path: consumedPath, bindings: consumed.bindings.length },
    });
    return;
  }
  logger.success(
    `served.json: ${served.routes.length} route(s) · consumed.json: ${consumed.bindings.length} binding(s)`,
  );
  logger.info(`  ${path.relative(opts.cwd, servedPath)}`);
  logger.info(`  ${path.relative(opts.cwd, consumedPath)}`);
  logger.info('');
  logger.info('Commit these so the counterpart repo can gate against them.');
}

/**
 * `vyuh-dxkit flow publish` — the multi-repo handshake. Reads
 * `.dxkit/workspace.json`, gathers every participant's served routes (from its
 * local path, or pinned at a git ref), and writes this repo's `served.json` as
 * the UNION of the whole mesh — so this repo's gate resolves calls against
 * services it does not co-locate. With no participants it publishes this repo's
 * own served/consumed (the monorepo case). See `flow refresh` for the
 * single-repo snapshot without the mesh union.
 */
export async function runFlowPublish(opts: FlowViewOptions): Promise<void> {
  if (!opts.json) logger.header('vyuh-dxkit flow publish');
  const config = readFlowConfig(opts.cwd);
  const commitSha = headCommitSha(opts.cwd);
  const result = await publishFlow(opts.cwd, {
    stripUrlPrefixes: config.stripUrlPrefixes,
    specs: [
      ...splitPaths(opts.specs, opts.cwd),
      ...config.specs.map((s) => path.resolve(opts.cwd, s)),
    ],
    generatedAt: new Date().toISOString(),
    ...(commitSha !== undefined ? { commitSha } : {}),
  });

  if (opts.json) {
    emitJson({
      servedPath: result.servedPath,
      consumedPath: result.consumedPath,
      totalServedRoutes: result.totalServedRoutes,
      consumedBindings: result.consumedBindings,
      contentHash: result.contentHash,
      participants: result.participants,
    });
    return;
  }

  logger.success(
    `Published mesh contract: ${result.totalServedRoutes} served route(s) across ${result.participants.length} participant(s) + this repo (hash ${result.contentHash}).`,
  );
  for (const p of result.participants) {
    let detail: string;
    if (p.source === 'missing') detail = 'path not found — skipped';
    else if (p.source === 'unreachable') detail = 'remote fetch failed — skipped';
    else detail = `${p.routes} route(s) (${p.source})`;
    logger.info(`  • ${p.name}: ${detail}`);
  }
  logger.info(`  ${path.relative(opts.cwd, result.servedPath)}`);
  logger.info(`  ${path.relative(opts.cwd, result.consumedPath)}`);
  logger.info('');
  logger.info('Commit these so this repo can gate against the whole mesh offline.');
}
