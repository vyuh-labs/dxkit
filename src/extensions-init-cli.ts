/**
 * `vyuh-dxkit extensions init` — the scaffold for both rungs (split from
 * extensions-cli.ts, which owns list/refresh/dev; init shares nothing with
 * them beyond the registries below).
 *
 *   - rung 3 (`--kind` [+ `--command` | `--stub`]): a manifest + optionally
 *     a Python starter that reads the stdin payload and emits a minimal
 *     valid document.
 *   - rung 4 (`--plugin` [+ `--kind`]): a manifest + a CommonJS plugin stub
 *     that loads and validates immediately — a producer stub when a kind is
 *     declared, else a gather-time dialect starter with the remaining
 *     contribution points shown as comments.
 *
 * `init` writes files for review + commit; it never executes anything.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SDK_MAJOR } from '@vyuhlabs/dxkit-sdk';
import * as logger from './logger';
import { EXTENSIONS_DIR } from './extensions/manifest';
import { CONTRIBUTION_KINDS } from './extensions/contributions';
import type { ExtensionsOptions } from './extensions-cli';

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

export function initExtension(cwd: string, name: string, opts: ExtensionsOptions): number {
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
