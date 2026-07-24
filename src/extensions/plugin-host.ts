/**
 * The ONE plugin loader — every rung-4 plugin module is loaded and
 * validated here (arch-gated: `createRequire` is banned outside this file
 * in src/, the mirror of the extension runner's confinement).
 *
 * Loading model: a plugin is a committed CommonJS module named by its
 * manifest (`plugin.module`, a `.js`/`.cjs` sibling of extension.json).
 * The module's default export (or `module.exports`) is a
 * `DxkitExtensionDefinition` — `defineExtension` output or a plain object
 * with the same shape (validated structurally here, field-precisely, so a
 * plain-JS author gets the same guardrails the TS types give).
 *
 * TRUST (load-bearing, the honest sandbox story): a plugin executes
 * IN-PROCESS — requiring the module runs its top-level code. The
 * enforcement boundary is trust-tier gating, not an OS sandbox: plugins
 * are honored only from the repo's own committed tree (the npm-scripts
 * boundary — a PR that edits a plugin is reviewed like a PR that edits a
 * CI workflow), load only on trusted surfaces (gather on a developer
 * machine, `extensions refresh`/`dev`, the on-merge workflow), and are
 * NEVER loaded under `--untrusted` — gather-time contributions simply
 * don't apply (symmetrically on both gate sides, so degradation is a
 * narrower lens, never a false block) and producer kinds fall back to
 * their committed snapshots. Contribution calls are try/caught; a broken
 * plugin is a disclosure, never a crashed gather.
 *
 * Version contract: a definition carries the SDK major it targets
 * (`defineExtension` stamps it). A mismatch with the running SDK is a
 * REFUSAL (the plugin was compiled against different frozen shapes); an
 * absent stamp is a disclosure, not an error — plain-object plugins are
 * legitimate.
 */

import { createRequire } from 'module';
import * as path from 'path';
import type { AnalysisTrustContext } from '../analysis-trust';
import {
  SDK_MAJOR,
  type ContractSourceReader,
  type DxkitExtensionDefinition,
  type HttpFlowDialect,
} from '@vyuhlabs/dxkit-sdk';
import { CONTRACT_SOURCE_READERS } from '../analyzers/flow/contract-sources';
import { discoverExtensions, type LoadedExtension } from './manifest';

export type PluginLoadResult =
  | {
      readonly ok: true;
      readonly definition: DxkitExtensionDefinition;
      /** Non-fatal observations (missing sdkMajor stamp, unknown keys). */
      readonly disclosures: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Shallow shape checks for each `HttpFlowSupport` field a dialect may carry
 * — enough that a plain-JS typo (`clientCallees: 'fetch'`) fails loudly at
 * load instead of half-working in the extractor (a string has `.includes`
 * too). Deep semantics stay with the extractor; unknown keys are disclosed
 * (the "did you misspell a field" net).
 */
const DIALECT_FIELD_SHAPES: Record<string, (v: unknown) => boolean> = {
  clientCallees: isStringArray,
  routeDecorators: isStringArray,
  clientMethodCallees: (v) => isObject(v) && isStringArray(v['methods']),
  routeRouterCallees: (v) =>
    isObject(v) && isStringArray(v['methods']) && isStringArray(v['bases']),
  routeMemberDecorators: (v) => isObject(v) && isStringArray(v['methods']),
  routePathDecorators: (v) =>
    isObject(v) &&
    isStringArray(v['names']) &&
    typeof v['methodsKeyword'] === 'string' &&
    isStringArray(v['defaultMethods']),
  routeCallees: (v) => isObject(v),
  clientRequestCallees: (v) => isObject(v) && isStringArray(v['names']),
  methodAliases: (v) => isObject(v) && Object.values(v).every((x) => typeof x === 'string'),
  fileRoutes: (v) =>
    isObject(v) &&
    typeof v['handlerFile'] === 'string' &&
    isStringArray(v['baseDirs']) &&
    isStringArray(v['methodExports']),
  flowSignals: (v) => Array.isArray(v),
};

/** Which definition key supplies the producer for each wire kind — shared
 *  with the runner so selection and validation agree (one concept). */
export const PRODUCER_KEY_BY_KIND = {
  contract: 'contractProducer',
  inventory: 'inventoryProducer',
  findings: 'findingProducer',
  export: 'exporter',
} as const;

function validateDefinition(
  raw: unknown,
  ext: LoadedExtension,
): { errors: string[]; disclosures: string[] } {
  const errors: string[] = [];
  const disclosures: string[] = [];
  const at = `${ext.dir}/${ext.manifest.plugin?.module ?? '?'}`;
  const add = (field: string, problem: string) => errors.push(`${at}: ${field} ${problem}`);

  if (!isObject(raw)) {
    add('definition', 'must export a DxkitExtensionDefinition object (module.exports or default)');
    return { errors, disclosures };
  }
  if (raw['name'] !== ext.manifest.name) {
    add(
      'name',
      `(${JSON.stringify(raw['name'])}) must equal the manifest name ('${ext.manifest.name}') — one identity`,
    );
  }
  const sdkMajor = raw['sdkMajor'];
  if (sdkMajor === undefined) {
    disclosures.push(
      `${at}: no sdkMajor declared — the plugin cannot be checked against the running SDK (major ${SDK_MAJOR}); use defineExtension to stamp it`,
    );
  } else if (sdkMajor !== SDK_MAJOR) {
    add(
      'sdkMajor',
      `(${JSON.stringify(sdkMajor)}) targets a different SDK major than the running one (${SDK_MAJOR}) — refusing to load; rebuild the plugin against the current @vyuhlabs/dxkit-sdk`,
    );
  }

  const KNOWN_KEYS = new Set([
    'name',
    'sdkMajor',
    'httpFlowDialect',
    'contractReader',
    'urlNormalizer',
    'contractProducer',
    'inventoryProducer',
    'findingProducer',
    'exporter',
    'integrationVerifier',
  ]);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      disclosures.push(`${at}: unknown key '${key}' ignored (misspelled contribution point?)`);
    }
  }

  const dialect = raw['httpFlowDialect'];
  if (dialect !== undefined) {
    if (!isObject(dialect) || typeof dialect['pack'] !== 'string' || dialect['pack'].length === 0) {
      add('httpFlowDialect.pack', 'must name the language pack the dialect applies to');
    } else {
      for (const [field, value] of Object.entries(dialect)) {
        if (field === 'pack') continue;
        const shape = DIALECT_FIELD_SHAPES[field];
        if (!shape) {
          disclosures.push(
            `${at}: httpFlowDialect.${field} is not an HttpFlowSupport field — ignored (misspelled?)`,
          );
        } else if (!shape(value)) {
          add(`httpFlowDialect.${field}`, 'has the wrong shape (see HttpFlowSupport in the SDK)');
        }
      }
    }
  }

  const reader = raw['contractReader'];
  if (reader !== undefined) {
    if (!isObject(reader)) {
      add('contractReader', 'must be a ContractSourceReader object');
    } else {
      const kind = reader['kind'];
      if (typeof kind !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(kind)) {
        add('contractReader.kind', 'must be a lowercase kebab-case token');
      } else if (CONTRACT_SOURCE_READERS.some((r) => r.kind === kind)) {
        add(
          'contractReader.kind',
          `('${kind}') collides with a built-in reader — pick a distinct token`,
        );
      }
      if (typeof reader['displayName'] !== 'string') {
        add('contractReader.displayName', 'must be a string');
      }
      const sides = reader['sides'];
      if (sides !== 'consumed' && sides !== 'served' && sides !== 'both') {
        add('contractReader.sides', "must be 'consumed' | 'served' | 'both'");
      }
      const defaultSide = reader['defaultSide'];
      if (defaultSide !== 'consumed' && defaultSide !== 'served') {
        add('contractReader.defaultSide', "must be 'consumed' | 'served'");
      }
      if (typeof reader['sniff'] !== 'function') add('contractReader.sniff', 'must be a function');
      if (typeof reader['parse'] !== 'function') add('contractReader.parse', 'must be a function');
    }
  }

  if (raw['urlNormalizer'] !== undefined && typeof raw['urlNormalizer'] !== 'function') {
    add('urlNormalizer', 'must be a function (rawUrl) => string | null');
  }

  // Producer keys ↔ the manifest's contributes, both directions: a producer
  // without a declared wire kind silently never runs; a declared kind
  // without its producer can never refresh.
  const contributes = ext.manifest.contributes;
  for (const [kind, key] of Object.entries(PRODUCER_KEY_BY_KIND)) {
    const fn = raw[key];
    if (fn === undefined) continue;
    if (typeof fn !== 'function') {
      add(key, 'must be a function');
      continue;
    }
    if (contributes === undefined) {
      add(key, `needs the manifest to declare contributes: '${kind}' (plus refresh + output)`);
    } else if (contributes !== kind) {
      add(key, `is the '${kind}' producer but the manifest declares contributes: '${contributes}'`);
    }
  }
  const verifier = raw['integrationVerifier'];
  if (verifier !== undefined) {
    if (typeof verifier !== 'function') {
      add('integrationVerifier', 'must be a function');
    } else if (contributes !== 'findings') {
      add(
        'integrationVerifier',
        "needs the manifest to declare contributes: 'findings' — its assertions enter the gate as findings",
      );
    } else if (typeof raw['findingProducer'] === 'function') {
      add(
        'integrationVerifier',
        'and findingProducer cannot both be declared — one producer per extension (split into two extensions if you need both)',
      );
    }
  }
  if (contributes !== undefined) {
    const requiredKey = PRODUCER_KEY_BY_KIND[contributes];
    const hasProducer =
      typeof raw[requiredKey] === 'function' ||
      (contributes === 'findings' && typeof verifier === 'function');
    if (!hasProducer) {
      add(
        requiredKey,
        `is missing — the manifest declares contributes: '${contributes}', so the plugin must export its producer${contributes === 'findings' ? ' (findingProducer or integrationVerifier)' : ''}`,
      );
    }
  }

  const contributionKeys = [
    'httpFlowDialect',
    'contractReader',
    'urlNormalizer',
    'contractProducer',
    'inventoryProducer',
    'findingProducer',
    'exporter',
    'integrationVerifier',
  ];
  if (!contributionKeys.some((k) => raw[k] !== undefined)) {
    add(
      'definition',
      `must declare at least one contribution point (${contributionKeys.join(', ')})`,
    );
  }

  return { errors, disclosures };
}

/**
 * Load + validate one plugin extension's module. Cache-busted on every
 * call (loads are rare; a stale module during an `extensions dev` loop
 * would be a lie). Never throws — a module that throws at load is a
 * field-precise error result.
 */
export function loadPluginDefinition(cwd: string, ext: LoadedExtension): PluginLoadResult {
  const moduleRel = ext.manifest.plugin?.module;
  if (!moduleRel) {
    return { ok: false, errors: [`${ext.dir}: not a plugin extension (no plugin.module)`] };
  }
  const extDirAbs = path.resolve(cwd, ext.dir);
  const moduleAbs = path.resolve(extDirAbs, moduleRel);
  // Belt + braces on top of manifest validation: the module stays inside
  // the extension directory.
  if (moduleAbs !== extDirAbs && !moduleAbs.startsWith(extDirAbs + path.sep)) {
    return {
      ok: false,
      errors: [`${ext.dir}: plugin.module escapes the extension directory — refusing to load`],
    };
  }

  const requireFrom = createRequire(path.join(cwd, 'package.json'));
  let mod: unknown;
  try {
    delete requireFrom.cache[moduleAbs];
    mod = requireFrom(moduleAbs);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `${ext.dir}/${moduleRel}: failed to load — ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }
  const def =
    isObject(mod) && mod['default'] !== undefined && isObject(mod['default'])
      ? mod['default']
      : mod;

  const { errors, disclosures } = validateDefinition(def, ext);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, definition: def as unknown as DxkitExtensionDefinition, disclosures };
}

/**
 * Everything the FLOW GATHER consumes from loaded plugins, assembled once
 * per gather: dialects to merge into pack descriptors, readers to augment
 * the contract-source registry, and the composed rewriteUrl hook (first
 * non-null opinion wins, in extension-name order — discovery sorts).
 */
export interface FlowPluginOverlay {
  readonly dialects: readonly HttpFlowDialect[];
  readonly readers: readonly ContractSourceReader[];
  readonly rewriteUrl?: (rawUrl: string) => string | null;
  /** Load failures + observations, fail-open: a broken plugin narrows the
   *  lens and is disclosed; it never crashes a gather. */
  readonly disclosures: readonly string[];
}

const EMPTY_OVERLAY: FlowPluginOverlay = { dialects: [], readers: [], disclosures: [] };

/**
 * Load every committed plugin extension's gather-time contributions.
 * `trust` is REQUIRED (4.2): loading a plugin is a `require` of
 * repo-declared JS, so the caller must state whose tree this is — an
 * omission fails to compile instead of silently defaulting to trusted (the
 * class that shipped). An untrusted context disables loading entirely, with
 * one disclosure naming what was skipped — callers apply the SAME overlay
 * to both gate sides, so the degraded lens can never mint a false block.
 */
export function loadFlowPluginOverlay(cwd: string, trust: AnalysisTrustContext): FlowPluginOverlay {
  const { extensions } = discoverExtensions(cwd);
  const pluginExts = extensions.filter((e) => e.manifest.plugin !== undefined);
  if (pluginExts.length === 0) return EMPTY_OVERLAY;
  if (!trust.repoExecutionAllowed) {
    return {
      ...EMPTY_OVERLAY,
      disclosures: [
        `plugins not loaded (untrusted content): ${pluginExts.map((e) => e.manifest.name).join(', ')} — gather-time contributions disabled on both sides; committed snapshots still read`,
      ],
    };
  }

  const dialects: HttpFlowDialect[] = [];
  const readers: ContractSourceReader[] = [];
  const hooks: Array<(u: string) => string | null> = [];
  const disclosures: string[] = [];
  const seenReaderKinds = new Set<string>();

  for (const ext of pluginExts) {
    const loaded = loadPluginDefinition(cwd, ext);
    if (!loaded.ok) {
      disclosures.push(...loaded.errors);
      continue;
    }
    disclosures.push(...loaded.disclosures);
    const def = loaded.definition;
    if (def.httpFlowDialect) dialects.push(def.httpFlowDialect);
    if (def.contractReader) {
      if (seenReaderKinds.has(def.contractReader.kind)) {
        disclosures.push(
          `${ext.dir}: contractReader kind '${def.contractReader.kind}' already registered by another plugin — skipped`,
        );
      } else {
        seenReaderKinds.add(def.contractReader.kind);
        readers.push(def.contractReader);
      }
    }
    if (def.urlNormalizer) hooks.push(def.urlNormalizer);
  }

  const rewriteUrl =
    hooks.length === 0
      ? undefined
      : (rawUrl: string): string | null => {
          for (const hook of hooks) {
            try {
              const r = hook(rawUrl);
              if (typeof r === 'string') return r;
            } catch {
              /* a throwing hook is a no-opinion */
            }
          }
          return null;
        };

  return {
    dialects,
    readers,
    ...(rewriteUrl ? { rewriteUrl } : {}),
    disclosures,
  };
}
