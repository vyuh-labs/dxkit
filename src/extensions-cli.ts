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
import { CONTRIBUTION_KINDS } from './extensions/contributions';
import { loadExclusions } from './analyzers/tools/exclusions';
import { detectActiveLanguages } from './languages';
import { landRefreshPaths, type LandMode } from './land-refresh';
import { detectDefaultBranch } from './ship-installers';
import { SDK_MAJOR } from '@vyuhlabs/dxkit-sdk';
import type {
  DxkitExtensionDefinition,
  VerifierFlowContext,
  WireConsumedCall,
  WireContractDoc,
  WireFindingsDoc,
  WireInventoryDoc,
} from '@vyuhlabs/dxkit-sdk';

export type ExtensionsSubcommand = 'list' | 'refresh' | 'dev' | 'init';

export interface ExtensionsOptions {
  readonly json?: boolean;
  /** refresh: land the snapshot changes ('pr' = standing PR, 'push' = direct
   *  [skip ci] commit). Omitted → refresh writes the working tree only. */
  readonly land?: string;
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
  const model = await gatherRepoFlowModel(cwd, { relativeTo: cwd });
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
      const chosen = target ? extensions.filter((e) => e.manifest.name === target) : extensions;
      if (target && chosen.length === 0) {
        logger.fail(`No extension named '${target}' under ${EXTENSIONS_DIR}/.`);
        return 1;
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

// ── init scaffold ───────────────────────────────────────────────────────────

const PY_STUB = `#!/usr/bin/env python3
"""dxkit extension starter: reads the stdin payload, emits a minimal valid
document. Replace the emit with your real extraction — the payload carries
your committed config block plus repo facts (exclude dirs, active languages).
Iterate with: vyuh-dxkit extensions dev <name>
"""
import json
import sys

payload = json.load(sys.stdin)
kind = payload["extension"]["contributes"]

doc = {
    "contract": {"schema": "contract.v1", "consumed": []},
    "inventory": {"schema": "inventory.v1", "entities": []},
    "findings": {"schema": "findings.v1", "findings": []},
    "export": {"schema": "export.v1", "delivered": False, "detail": "stub"},
}[kind]

json.dump(doc, sys.stdout)
`;

function initExtension(cwd: string, name: string, opts: ExtensionsOptions): number {
  const kinds = CONTRIBUTION_KINDS.map((d) => d.kind);
  if (!opts.plugin && (!opts.kind || !kinds.includes(opts.kind as (typeof kinds)[number]))) {
    logger.fail(`--kind must be one of ${kinds.map((k) => `'${k}'`).join(' | ')}.`);
    return 1;
  }
  if (
    opts.plugin &&
    opts.kind !== undefined &&
    !kinds.includes(opts.kind as (typeof kinds)[number])
  ) {
    logger.fail(`--kind must be one of ${kinds.map((k) => `'${k}'`).join(' | ')}.`);
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    logger.fail('Extension names are lowercase kebab-case.');
    return 1;
  }
  const dir = path.join(cwd, EXTENSIONS_DIR, name);
  const manifestPath = path.join(dir, 'extension.json');
  if (fs.existsSync(manifestPath)) {
    logger.fail(`${EXTENSIONS_DIR}/${name}/extension.json already exists.`);
    return 1;
  }
  if (opts.plugin) return initPluginExtension(cwd, name, opts, dir, manifestPath);
  const kindDef = CONTRIBUTION_KINDS.find((d) => d.kind === opts.kind)!;
  const stubRel = `${EXTENSIONS_DIR}/${name}/run.py`;
  const commandLine = opts.command ?? (opts.stub ? `python3 ${stubRel}` : undefined);
  if (!commandLine) {
    logger.fail('Pass --command "<cmd>" (your existing script) or --stub for a Python starter.');
    return 1;
  }
  const [bin, ...args] = commandLine.split(/\s+/);
  const manifest = {
    schemaVersion: 1,
    name,
    contributes: opts.kind,
    run: { command: bin, args, timeoutSeconds: 300 },
    refresh: 'on-merge',
    output: kindDef.snapshotPathFor(name),
    ...(opts.kind === 'findings' ? { gating: 'warn' } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (opts.stub) fs.writeFileSync(path.join(cwd, stubRel), PY_STUB);
  logger.header('vyuh-dxkit extensions init');
  logger.success(`  Wrote ${EXTENSIONS_DIR}/${name}/extension.json`);
  if (opts.stub) logger.success(`  Wrote ${stubRel} (a starter that already passes validation)`);
  logger.info('  Next:');
  logger.info(`    1. vyuh-dxkit extensions dev ${name}   # run + validate in seconds`);
  logger.info('    2. commit the manifest (and snapshot) — gates read snapshots offline');
  return 0;
}

/**
 * Rung-4 scaffold: a manifest + a CommonJS plugin stub that loads and
 * validates immediately. With `--kind` the stub exports the matching
 * producer returning a minimal valid document; without it the stub is a
 * gather-time dialect starter (zero-effect until tokens are filled in),
 * with the other contribution points shown as comments.
 */
function initPluginExtension(
  cwd: string,
  name: string,
  opts: ExtensionsOptions,
  dir: string,
  manifestPath: string,
): number {
  const kind = opts.kind as 'contract' | 'inventory' | 'findings' | 'export' | undefined;
  const kindDef = kind ? CONTRIBUTION_KINDS.find((d) => d.kind === kind) : undefined;
  const manifest = {
    schemaVersion: 1,
    name,
    ...(kind ? { contributes: kind } : {}),
    plugin: { module: 'plugin.js' },
    ...(kind ? { refresh: 'on-merge', output: kindDef!.snapshotPathFor(name) } : {}),
    ...(kind === 'findings' ? { gating: 'warn' } : {}),
  };

  const producerStubs: Record<string, string> = {
    contract: `contractProducer: (ctx) => ({
    schema: 'contract.v1',
    consumed: [], // { method: 'GET', url: '/api/x', file: 'src/a.ts', line: 3 }
  }),`,
    inventory: `inventoryProducer: (ctx) => ({
    schema: 'inventory.v1',
    entities: [], // { kind: 'screen', name: 'Checkout', file: 'src/screens/Checkout.jsx' }
  }),`,
    findings: `findingProducer: (ctx) => ({
    schema: 'findings.v1',
    findings: [], // { rule: 'my-rule', message: '…', severity: 'high', file: 'src/a.ts', line: 3 }
  }),`,
    export: `exporter: (ctx) => ({
    schema: 'export.v1',
    delivered: false,
    detail: 'stub — ctx.delivery carries the report to deliver',
  }),`,
  };
  const contribution = kind
    ? producerStubs[kind]
    : `httpFlowDialect: {
    pack: 'typescript', // which language pack's files this dialect widens
    // Teach flow a bespoke client wrapper: api.fetchJson('/x') → GET /x
    clientMethodCallees: { methods: [] }, // e.g. ['fetchJson']
    // methodAliases: { fetchjson: 'GET' },
  },`;

  const stub = `// dxkit rung-4 plugin (CommonJS — author in TypeScript and commit the
// compiled module, or write plain JS like this starter). Docs: the
// dxkit-author-extension skill, or docs/extension-sdk.md in the dxkit repo.
// Iterate with: vyuh-dxkit extensions dev ${name}
module.exports = {
  name: '${name}',
  // The SDK major this plugin targets (defineExtension from
  // @vyuhlabs/dxkit-sdk stamps this for you in TypeScript).
  sdkMajor: ${SDK_MAJOR},

  ${contribution}

  // Other contribution points (see DxkitExtensionDefinition in the SDK):
  //   contractReader:  parse a custom artifact format for flow.sources
  //   urlNormalizer:   (rawUrl) => string | null — rewrite ahead of the
  //                    canonical normalizer (base-URL/tenant schemes)
  //   integrationVerifier: assert over the gathered flow model; its
  //                    findings gate through the committed snapshot
};
`;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}
`,
  );
  fs.writeFileSync(path.join(dir, 'plugin.js'), stub);
  logger.header('vyuh-dxkit extensions init');
  logger.success(`  Wrote ${EXTENSIONS_DIR}/${name}/extension.json (rung-4 plugin)`);
  logger.success(`  Wrote ${EXTENSIONS_DIR}/${name}/plugin.js (loads + validates immediately)`);
  logger.info('  Next:');
  logger.info(`    1. vyuh-dxkit extensions dev ${name}   # load + validate in seconds`);
  logger.info(
    kind
      ? '    2. fill in the producer, then commit the manifest + snapshot'
      : '    2. fill in the dialect tokens, then commit — it applies at the next gather',
  );
  return 0;
}
