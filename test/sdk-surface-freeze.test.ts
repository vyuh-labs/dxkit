/**
 * The SDK surface-freeze net (CLAUDE.md Rule 18).
 *
 * @vyuhlabs/dxkit-sdk is the frozen extension surface: additive-only within
 * a major. This test makes an accidental narrowing a CI failure instead of
 * a customer report, in three layers:
 *
 *  1. RUNTIME EXPORT SET — the exact export-name snapshot. Removing or
 *     renaming an export fails here; ADDING one also fails until the list
 *     below is updated, which is the point: growing the frozen surface is
 *     a deliberate act (changelog + review), never a side effect.
 *  2. ONE CODE PATH — the main package's re-exports are reference-identical
 *     to the SDK's exports. If someone re-implements a frozen helper in
 *     src/ instead of re-exporting, the identity check fails (and the
 *     Rule 18 arch-check catches the re-declaration shape).
 *  3. COMPILE-TIME PINS — the exported type aliases at the bottom reference
 *     every frozen type and structurally pin the contracts that stay
 *     frozen IN PLACE in the main package (DepVulnsProvider's declaration
 *     fields — a pack contract entangled with the internal LanguageId
 *     union, deliberately not moved into the SDK; extensions contribute
 *     dep findings via findings.v1, never by implementing the provider).
 *     Enforced by `npm run typecheck:test`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as sdk from '@vyuhlabs/dxkit-sdk';
import type {
  ContractProducer,
  ContractSide,
  ContractSourceParse,
  ContractSourceReader,
  ContributionKind,
  DxkitExtensionDefinition,
  Exporter,
  ExporterContext,
  ExtensionContext,
  ExtensionManifest,
  ExtensionPluginSpec,
  ExtensionRepoFacts,
  ExtensionRunSpec,
  FileRouteSupport,
  FindingProducer,
  HttpFlowDialect,
  IntegrationVerifier,
  IntegrationVerifierContext,
  InventoryProducer,
  RawConsumedCall,
  RawServedRoute,
  UrlNormalizer,
  VerifierFlowContext,
  GrammarModelShape,
  GrammarShape,
  HttpFlowSupport,
  HttpMethod,
  ModelSchemaSupport,
  NormalizeConfig,
  Node,
  ParsedFile,
  ParseFileFn,
  ParseSourceFn,
  ResolvedCall,
  ServedMethod,
  Tree,
  WireConsumedCall,
  WireContractDoc,
  WireDoc,
  WireDynamicCall,
  WireExportReceipt,
  WireFinding,
  WireFindingsDoc,
  WireInventoryDoc,
  WireInventoryEntity,
  WireInventoryField,
  WireInventoryRelation,
  WireSchemaId,
  WireServedRoute,
  WireSeverity,
} from '@vyuhlabs/dxkit-sdk';
import {
  ANY_METHOD as mainAnyMethod,
  CATCHALL as mainCatchall,
  bindingKey as mainBindingKey,
  catchAllStaticPrefix as mainCatchAllStaticPrefix,
  isCatchAllPath as mainIsCatchAllPath,
  normalizeMethod as mainNormalizeMethod,
  normalizePath as mainNormalizePath,
} from '../src/analyzers/flow/normalize';
import { walk as mainWalk } from '../src/ast/parse';
import type {
  HttpFlowSupport as MainHttpFlowSupport,
  ModelSchemaSupport as MainModelSchemaSupport,
} from '../src/languages/types';
import type { ContractSourceReader as MainContractSourceReader } from '../src/analyzers/flow/contract-sources';
import type {
  DepVulnGatherOptions,
  DepVulnsProvider,
} from '../src/languages/capabilities/provider';
import type { DepVulnGatherOutcome } from '../src/languages/capabilities/types';
import type { ExecutionRequirement } from '../src/execution';

/**
 * The frozen runtime export set. Additive-only: append (with a changelog
 * entry) when the surface deliberately grows; a removal or rename is an SDK
 * major bump.
 */
const FROZEN_RUNTIME_EXPORTS = [
  'ANY_METHOD',
  'CATCHALL',
  'SDK_MAJOR',
  'WIRE_SCHEMA_IDS',
  'bindingKey',
  'catchAllStaticPrefix',
  'defineExtension',
  'isCatchAllPath',
  'normalizeMethod',
  'normalizePath',
  'walk',
].sort();

describe('sdk surface freeze (Rule 18)', () => {
  it('exports exactly the frozen runtime surface', () => {
    const actual = Object.keys(sdk)
      .filter((k) => k !== '__esModule' && k !== 'default')
      .sort();
    expect(actual).toEqual(FROZEN_RUNTIME_EXPORTS);
  });

  it('pins the wire-schema id registry (append-only)', () => {
    // Append-only by contract: new ids (new kinds, new versions) extend the
    // array; an id is NEVER removed — committed extension snapshots keep
    // being read forever.
    expect(sdk.WIRE_SCHEMA_IDS).toEqual([
      'contract.v1',
      'inventory.v1',
      'findings.v1',
      'export.v1',
    ]);
  });

  it('main re-exports are reference-identical to the SDK (one code path)', () => {
    expect(mainNormalizePath).toBe(sdk.normalizePath);
    expect(mainNormalizeMethod).toBe(sdk.normalizeMethod);
    expect(mainBindingKey).toBe(sdk.bindingKey);
    expect(mainIsCatchAllPath).toBe(sdk.isCatchAllPath);
    expect(mainCatchAllStaticPrefix).toBe(sdk.catchAllStaticPrefix);
    expect(mainAnyMethod).toBe(sdk.ANY_METHOD);
    expect(mainCatchall).toBe(sdk.CATCHALL);
    expect(mainWalk).toBe(sdk.walk);
  });

  it('SDK_MAJOR agrees with the published package version', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../packages/dxkit-sdk/package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(pkg.name).toBe('@vyuhlabs/dxkit-sdk');
    expect(Number(pkg.version.split('.')[0])).toBe(sdk.SDK_MAJOR);
  });
});

// ── Layer 3: compile-time pins (enforced by `npm run typecheck:test`) ───────

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Every frozen TYPE export must stay importable — removal fails typecheck. */
export type FrozenTypeSurface = [
  ContractProducer,
  ContractSide,
  ContractSourceParse,
  ContractSourceReader,
  ContributionKind,
  DxkitExtensionDefinition,
  Exporter,
  ExporterContext,
  ExtensionContext,
  ExtensionManifest,
  ExtensionPluginSpec,
  ExtensionRepoFacts,
  ExtensionRunSpec,
  FileRouteSupport,
  FindingProducer,
  HttpFlowDialect,
  IntegrationVerifier,
  IntegrationVerifierContext,
  InventoryProducer,
  RawConsumedCall,
  RawServedRoute,
  UrlNormalizer,
  VerifierFlowContext,
  GrammarModelShape,
  GrammarShape,
  HttpFlowSupport,
  HttpMethod,
  ModelSchemaSupport,
  NormalizeConfig,
  Node,
  ParsedFile,
  ParseFileFn,
  ParseSourceFn,
  ResolvedCall,
  ServedMethod,
  Tree,
  WireConsumedCall,
  WireContractDoc,
  WireDoc,
  WireDynamicCall,
  WireExportReceipt,
  WireFinding,
  WireFindingsDoc,
  WireInventoryDoc,
  WireInventoryEntity,
  WireInventoryField,
  WireInventoryRelation,
  WireSchemaId,
  WireServedRoute,
  WireSeverity,
];

/** The main package must not fork a frozen type — identical, not just similar. */
export type MainReexportsAreTheSdkTypes = [
  Expect<Equal<MainHttpFlowSupport, HttpFlowSupport>>,
  Expect<Equal<MainModelSchemaSupport, ModelSchemaSupport>>,
  Expect<Equal<MainContractSourceReader, ContractSourceReader>>,
];

/** The verb vocabulary is frozen content, not just a frozen name. */
export type FrozenVocabulary = [
  Expect<Equal<HttpMethod, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'>>,
  Expect<Equal<ServedMethod, HttpMethod | 'ANY'>>,
  Expect<Equal<WireSeverity, 'critical' | 'high' | 'medium' | 'low'>>,
  Expect<Equal<ContributionKind, 'contract' | 'inventory' | 'findings' | 'export'>>,
];

/**
 * DepVulnsProvider is frozen IN PLACE (main package): its declaration
 * fields are contract for language packs. Narrowing or renaming either
 * field, or changing the outcome channel, fails typecheck here.
 */
export type DepVulnsProviderFrozenInPlace = [
  Expect<Equal<DepVulnsProvider['manifestPatterns'], readonly string[]>>,
  Expect<Equal<DepVulnsProvider['lockfilePatterns'], readonly string[] | undefined>>,
  Expect<Equal<ReturnType<DepVulnsProvider['gatherOutcome']>, Promise<DepVulnGatherOutcome>>>,
  Expect<Equal<Parameters<DepVulnsProvider['gatherOutcome']>[1], DepVulnGatherOptions | undefined>>,
  // 4.0 (Rule 20): the execution-environment declaration joined the pack
  // contract — a deliberate frozen-in-place field addition (all implementers
  // are in-tree packs; extensions contribute dep findings via findings.v1 and
  // never implement this interface).
  Expect<Equal<ReturnType<DepVulnsProvider['execution']>, ExecutionRequirement>>,
];
