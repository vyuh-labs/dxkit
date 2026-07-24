/**
 * `vyuh-dxkit extensions [list|refresh|dev|init]` — the user surface of the
 * extension orchestrator (CLAUDE.md Rule 16).
 *
 *   - `list` (default): every committed extension with its kind, gating,
 *     refresh mode, and snapshot health (ok + age / missing / invalid) —
 *     plus manifest validation errors, so a silently-broken extension is
 *     visible in one command.
 *   - `refresh [name]`: EXECUTE extensions (all, or one by name) and write
 *     their committed snapshots. This is the trusted-context surface the
 *     on-merge workflow runs; export sinks receive the latest published
 *     report-history entry as their delivery document when one exists.
 *   - `dev <name>`: the authoring loop — run ONE extension, show the
 *     field-precise validation verdict and a summary of what landed,
 *     without requiring a full scan. Iteration in seconds; the errors are
 *     the docs.
 *   - `init <name> --kind <kind> --command "<cmd>" [--stub]`: scaffold a
 *     manifest (and optionally a Python starter that reads the stdin
 *     payload and emits a minimal valid document) that passes validation
 *     immediately.
 *
 * SECURITY: `refresh` and `dev` execute the repo's OWN committed manifests
 * — the Rule 17 trust boundary. Nothing here accepts a command from a CLI
 * flag; `init` writes a manifest for review + commit, it does not run it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as logger from './logger';
import {
  discoverExtensions,
  EXTENSIONS_DIR,
  isProducerExtension,
  type LoadedExtension,
  type ProducerExtension,
} from './extensions/manifest';
import { runExtension, type ExtensionRunOutcome } from './extensions/run';
import { loadPluginDefinition } from './extensions/plugin-host';
import { gatherRepoFlowModel } from './analyzers/flow/gather';
import { joinFlow } from './analyzers/flow/model';
import type { ClientCall } from './analyzers/flow/extract';
import { readExtensionSnapshot } from './extensions/snapshot';
import { loadExclusions } from './analyzers/tools/exclusions';
import { detectActiveLanguages } from './languages';
import { landRefreshPaths, type LandMode } from './land-refresh';
import { initExtension } from './extensions-init-cli';
import { detectDefaultBranch } from './ship-installers';
import type {
  DxkitExtensionDefinition,
  VerifierFlowContext,
  WireConsumedCall,
  WireContractDoc,
  WireFindingsDoc,
  WireInventoryDoc,
} from '@vyuhlabs/dxkit-sdk';
import { trustedLocalContext } from './analysis-trust';

export type ExtensionsSubcommand = 'list' | 'refresh' | 'dev' | 'init';

export interface ExtensionsOptions {
  readonly json?: boolean;
  /** refresh: land the snapshot changes ('pr' = standing PR, 'push' = direct
   *  [skip ci] commit). Omitted → refresh writes the working tree only. */
  readonly land?: string;
  /** refresh: run only extensions whose manifest declares this `refresh`
   *  trigger (e.g. 'on-merge'). The generated on-merge workflow passes it,
   *  so `refresh: manual` finally MEANS manual (S-14) — previously the
   *  unfiltered refresh ran every extension. Omitted → all (explicit
   *  operator invocation keeps its run-everything semantics). */
  readonly scheduled?: string;
  /** init: contribution kind. */
  readonly kind?: string;
  /** init: the run command line (first token = interpreter, rest = args). */
  readonly command?: string;
  /** init: also write a Python starter script that passes validation. */
  readonly stub?: boolean;
  /** init: scaffold a rung-4 TypeScript/CommonJS plugin instead of a
   *  rung-3 command extension. */
  readonly plugin?: boolean;
}

/** Repo facts every run receives — the canonical sources, resolved once. */
function repoFacts(cwd: string): { excludeDirs: string[]; activeLanguages: string[] } {
  return {
    excludeDirs: loadExclusions(cwd).dirs,
    activeLanguages: detectActiveLanguages(cwd).map((l) => l.id),
  };
}

/** The delivery document for export sinks: the newest committed report-history
 *  entry when the repo publishes report snapshots; undefined otherwise (the
 *  sink is then skipped with a disclosed reason — nothing to deliver yet). */
function latestDelivery(cwd: string): unknown {
  try {
    const dir = path.join(cwd, '.dxkit', 'reports');
    const newest = fs
      .readdirSync(dir)
      .filter((f) => /^health-audit-.*\.json$/.test(f))
      .sort()
      .pop();
    if (!newest) return undefined;
    return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function describeSnapshot(cwd: string, ext: ProducerExtension): string {
  const snap = readExtensionSnapshot(cwd, ext);
  if (snap.status === 'missing') return 'snapshot: missing (run `extensions refresh`)';
  if (snap.status === 'invalid') return `snapshot: INVALID (${snap.errors.length} error(s))`;
  const age =
    snap.ageDays === undefined ? '' : snap.ageDays === 0 ? ' · today' : ` · ${snap.ageDays}d old`;
  return `snapshot: ok (${snap.schemaId}${age})`;
}

function summarizeDoc(
  ext: LoadedExtension,
  outcome: ExtensionRunOutcome & { status: 'ok' },
): string[] {
  const lines: string[] = [];
  switch (ext.manifest.contributes) {
    case 'contract': {
      const doc = outcome.doc as WireContractDoc;
      lines.push(
        `  consumed: ${doc.consumed?.length ?? 0} · served: ${doc.served?.length ?? 0} · dynamic: ${doc.dynamicCalls?.length ?? 0}`,
      );
      break;
    }
    case 'inventory': {
      const doc = outcome.doc as WireInventoryDoc;
      const byKind = new Map<string, number>();
      for (const e of doc.entities) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
      const parts = [...byKind.entries()].map(([k, n]) => `${k} ${n}`);
      lines.push(
        `  entities: ${doc.entities.length}${parts.length ? ` (${parts.join(' · ')})` : ''}`,
      );
      break;
    }
    case 'findings': {
      const doc = outcome.doc as WireFindingsDoc;
      const bySev = new Map<string, number>();
      for (const f of doc.findings) bySev.set(f.severity, (bySev.get(f.severity) ?? 0) + 1);
      const parts = [...bySev.entries()].map(([s, n]) => `${s} ${n}`);
      lines.push(
        `  findings: ${doc.findings.length}${parts.length ? ` (${parts.join(' · ')})` : ''}`,
      );
      break;
    }
    case 'export':
      lines.push('  receipt written');
      break;
  }
  lines.push(`  snapshot: ${outcome.outputPath}`);
  return lines;
}

/** Wire shape of one consumed call (canonical path preferred). */
function wireCall(c: ClientCall): WireConsumedCall {
  return { method: c.method, url: c.path ?? c.rawUrl, file: c.file, line: c.line };
}

/**
 * The flow evidence an `integrationVerifier` receives: the repo's gathered
 * model in wire shapes, with `unserved` = consumed calls the canonical join
 * resolved against NO serving route (the gate's block candidates).
 */
async function verifierFlowContext(cwd: string): Promise<VerifierFlowContext> {
  const model = await gatherRepoFlowModel(cwd, { trust: trustedLocalContext(), relativeTo: cwd });
  const bindings = joinFlow(model.calls, model.routes);
  return {
    consumed: model.calls.map(wireCall),
    served: model.routes.map((r) => ({
      method: r.method,
      path: r.path,
      ...(r.handler ? { handler: r.handler } : {}),
      file: r.file,
      line: r.line,
    })),
    unserved: bindings
      .filter((b) => b.route === null && b.reason !== 'external')
      .map((b) => wireCall(b.call)),
  };
}

async function runOne(cwd: string, ext: LoadedExtension): Promise<ExtensionRunOutcome> {
  const facts = repoFacts(cwd);
  const delivery = ext.manifest.contributes === 'export' ? latestDelivery(cwd) : undefined;
  if (ext.manifest.contributes === 'export' && delivery === undefined) {
    return {
      status: 'skipped',
      reason: 'nothing to deliver yet (run `vyuh-dxkit health` to produce a report first)',
    };
  }
  // A producer plugin loads once here — for verifier detection (the flow
  // model is gathered only when one asks for it) — and the definition is
  // handed to the runner so it is not required twice.
  let pluginDefinition: DxkitExtensionDefinition | undefined;
  let flow: VerifierFlowContext | undefined;
  if (ext.manifest.plugin !== undefined) {
    const loadedPlugin = loadPluginDefinition(cwd, ext);
    if (!loadedPlugin.ok) return { status: 'invalid', errors: loadedPlugin.errors };
    for (const d of loadedPlugin.disclosures) logger.warn(`  ${d}`);
    pluginDefinition = loadedPlugin.definition;
    if (pluginDefinition.integrationVerifier !== undefined) {
      flow = await verifierFlowContext(cwd);
    }
  }
  return runExtension(cwd, ext, {
    excludeDirs: facts.excludeDirs,
    activeLanguages: facts.activeLanguages,
    ...(delivery !== undefined ? { delivery } : {}),
    ...(pluginDefinition !== undefined ? { pluginDefinition } : {}),
    ...(flow !== undefined ? { flow } : {}),
  });
}

function reportOutcome(name: string, outcome: ExtensionRunOutcome): boolean {
  if (outcome.status === 'ok') {
    logger.success(`  ${name}: ok`);
    return true;
  }
  if (outcome.status === 'skipped') {
    logger.warn(`  ${name}: skipped — ${outcome.reason}`);
    return true; // fail-open: a skip is disclosed, not a failure
  }
  logger.fail(`  ${name}: invalid`);
  for (const e of outcome.errors) logger.info(`    ${e}`);
  return false;
}

export async function runExtensionsCli(
  cwd: string,
  sub: ExtensionsSubcommand,
  target: string | undefined,
  opts: ExtensionsOptions = {},
): Promise<number> {
  const { extensions, errors } = discoverExtensions(cwd);

  switch (sub) {
    case 'list': {
      if (opts.json) {
        const payload = extensions.map((ext) =>
          isProducerExtension(ext)
            ? {
                name: ext.manifest.name,
                contributes: ext.manifest.contributes,
                refresh: ext.manifest.refresh,
                ...(ext.manifest.gating ? { gating: ext.manifest.gating } : {}),
                output: ext.manifest.output,
                ...(ext.manifest.plugin ? { plugin: ext.manifest.plugin.module } : {}),
                snapshot: readExtensionSnapshot(cwd, ext),
              }
            : {
                name: ext.manifest.name,
                plugin: ext.manifest.plugin?.module,
                gatherOnly: true,
              },
        );
        process.stdout.write(JSON.stringify({ extensions: payload, errors }) + '\n');
        return errors.length > 0 ? 1 : 0;
      }
      logger.header('vyuh-dxkit extensions');
      if (extensions.length === 0 && errors.length === 0) {
        logger.info(`  No extensions declared under ${EXTENSIONS_DIR}/.`);
        logger.info(
          '  Scaffold one: vyuh-dxkit extensions init <name> --kind <kind> --command "<cmd>"',
        );
        return 0;
      }
      for (const ext of extensions) {
        if (!isProducerExtension(ext)) {
          logger.info(
            `  ${logger.bold(ext.manifest.name)}  (plugin · gather-time — loads live on trusted context)`,
          );
          logger.info(`    module: ${ext.manifest.plugin?.module ?? '?'}`);
          continue;
        }
        const gating =
          ext.manifest.contributes === 'findings'
            ? ` · gating: ${ext.manifest.gating ?? 'warn'}`
            : '';
        const rung = ext.manifest.plugin ? 'plugin · ' : '';
        logger.info(
          `  ${logger.bold(ext.manifest.name)}  (${rung}${ext.manifest.contributes} · ${ext.manifest.refresh}${gating})`,
        );
        logger.info(`    ${describeSnapshot(cwd, ext)}`);
      }
      for (const e of errors) logger.fail(`  ${e}`);
      return errors.length > 0 ? 1 : 0;
    }

    case 'refresh': {
      let chosen = target ? extensions.filter((e) => e.manifest.name === target) : extensions;
      if (target && chosen.length === 0) {
        logger.fail(`No extension named '${target}' under ${EXTENSIONS_DIR}/.`);
        return 1;
      }
      if (opts.scheduled) {
        const skipped = chosen.filter((e) => e.manifest.refresh !== opts.scheduled);
        chosen = chosen.filter((e) => e.manifest.refresh === opts.scheduled);
        for (const e of skipped) {
          logger.info(
            `  ${e.manifest.name}: refresh '${e.manifest.refresh}' — skipped by --scheduled ${opts.scheduled}`,
          );
        }
      }
      logger.header('vyuh-dxkit extensions refresh');
      for (const e of errors) logger.fail(`  ${e}`);
      if (chosen.length === 0) {
        logger.info('  Nothing to refresh.');
        return errors.length > 0 ? 1 : 0;
      }
      // Capture pre-refresh snapshot bytes so landing can ignore pure
      // generatedAt restamps (every run restamps; metadata churn must not
      // land a commit on every merge — the flow-refresh substance rule).
      const landable = chosen
        .filter(isProducerExtension)
        .filter((e) => e.manifest.contributes !== 'export');
      const before = new Map<string, string | null>(
        landable.map((e) => {
          try {
            return [e.manifest.output, fs.readFileSync(path.join(cwd, e.manifest.output), 'utf8')];
          } catch {
            return [e.manifest.output, null];
          }
        }),
      );
      let ok = true;
      const refreshedNames: string[] = [];
      for (const ext of chosen) {
        const r = await runOne(cwd, ext);
        if (r.status === 'ok') refreshedNames.push(ext.manifest.name);
        ok = reportOutcome(ext.manifest.name, r) && ok;
      }
      if (opts.land === 'pr' || opts.land === 'push') {
        const result = landRefreshPaths({
          cwd,
          mode: opts.land as LandMode,
          paths: landable.map((e) => e.manifest.output),
          branchName: 'dxkit/extensions-refresh',
          defaultBranch: detectDefaultBranch(cwd),
          commitTitle: 'chore(extensions): refresh committed snapshots',
          prTitle: `chore(extensions): snapshot refresh (${refreshedNames.join(', ') || 'no-op'})`,
          prBody:
            'Automated extension-snapshot refresh. Gates read these committed ' +
            'snapshots offline; merging keeps their verdicts current.\n\n' +
            refreshedNames.map((n) => `- \`${n}\``).join('\n'),
          isSubstantive: () =>
            landable.some((e) => {
              const prev = before.get(e.manifest.output) ?? null;
              let cur: string | null = null;
              try {
                cur = fs.readFileSync(path.join(cwd, e.manifest.output), 'utf8');
              } catch {
                cur = null;
              }
              const strip = (t: string | null): string => {
                if (t === null) return 'absent';
                try {
                  const o = JSON.parse(t) as Record<string, unknown>;
                  delete o['generatedAt'];
                  return JSON.stringify(o);
                } catch {
                  return t;
                }
              };
              return strip(prev) !== strip(cur);
            }),
        });
        if (result.outcome === 'clean') logger.info('  land: no substantive snapshot change');
        else logger.success(`  land: ${result.outcome}${result.prUrl ? ` — ${result.prUrl}` : ''}`);
        if (result.note) logger.warn(`  ${result.note}`);
      } else if (opts.land !== undefined) {
        logger.fail(`--land must be 'pr' or 'push' (got '${opts.land}')`);
        return 1;
      }
      return ok && errors.length === 0 ? 0 : 1;
    }

    case 'dev': {
      if (!target) {
        logger.fail('Usage: vyuh-dxkit extensions dev <name>');
        return 1;
      }
      const ext = extensions.find((e) => e.manifest.name === target);
      if (!ext) {
        logger.fail(`No extension named '${target}' under ${EXTENSIONS_DIR}/.`);
        for (const e of errors.filter((x) => x.includes(target))) logger.info(`  ${e}`);
        return 1;
      }
      logger.header(`vyuh-dxkit extensions dev — ${target}`);
      if (ext.manifest.plugin !== undefined && !isProducerExtension(ext)) {
        // Gather-only plugin: the dev loop is load + validate + show what
        // registered — there is no document to emit.
        const loadedPlugin = loadPluginDefinition(cwd, ext);
        if (!loadedPlugin.ok) {
          logger.fail('  plugin is INVALID — fix the fields below and re-run:');
          for (const e of loadedPlugin.errors) logger.info(`    ${e}`);
          return 1;
        }
        logger.success('  plugin loads and is VALID');
        for (const d of loadedPlugin.disclosures) logger.warn(`  ${d}`);
        const def = loadedPlugin.definition;
        if (def.httpFlowDialect) {
          logger.info(
            `  httpFlowDialect → merges into the '${def.httpFlowDialect.pack}' pack at gather time`,
          );
        }
        if (def.contractReader) {
          logger.info(
            `  contractReader '${def.contractReader.kind}' → declare it in flow.sources to use: { "kind": "${def.contractReader.kind}", "path": "<artifact>" }`,
          );
        }
        if (def.urlNormalizer) {
          logger.info('  urlNormalizer → rewrites raw URLs ahead of canonical normalization');
        }
        return 0;
      }
      const outcome = await runOne(cwd, ext);
      if (outcome.status === 'ok') {
        logger.success('  emit is VALID');
        for (const line of summarizeDoc(ext, outcome)) logger.info(line);
        return 0;
      }
      if (outcome.status === 'skipped') {
        logger.warn(`  skipped — ${outcome.reason}`);
        return 1;
      }
      logger.fail('  emit is INVALID — fix the fields below and re-run:');
      for (const e of outcome.errors) logger.info(`    ${e}`);
      return 1;
    }

    case 'init': {
      if (!target) {
        logger.fail('Usage: vyuh-dxkit extensions init <name> --kind <kind> --command "<cmd>"');
        return 1;
      }
      return initExtension(cwd, target, opts);
    }
  }
}
