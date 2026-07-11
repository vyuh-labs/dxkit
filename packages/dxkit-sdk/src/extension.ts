/**
 * The rung-4 plugin surface — `defineExtension` and the contribution-point
 * types an in-process TS plugin may declare.
 *
 * A plugin is a committed CommonJS module (`.dxkit/extensions/<name>/` next
 * to its manifest, `plugin: { module: "plugin.js" }`) whose default export
 * is a `DxkitExtensionDefinition`. `defineExtension` is typed sugar: it
 * stamps the SDK major the plugin was compiled against and returns the
 * definition unchanged — a plain object literal with the same shape is
 * equally valid (dxkit validates structurally at load), so a plugin has no
 * hard runtime dependency on this package.
 *
 * Every contribution point maps 1:1 onto an EXISTING dxkit registry — a
 * plugin never gets a side channel (rungs above never fork rungs below):
 *   - `httpFlowDialect`    → merged into the named pack's `httpFlow`
 *                            descriptor union at gather time;
 *   - `contractReader`     → registered into the contract-source reader
 *                            registry, dispatchable from `flow.sources`;
 *   - `urlNormalizer`      → the `rewriteUrl` hook on the ONE normalizer;
 *   - `contractProducer` / `inventoryProducer` / `findingProducer` /
 *     `exporter`           → the refresh-time producer for the manifest's
 *                            `contributes` kind — the rung-3 wire protocol
 *                            called in-process instead of over stdin/stdout;
 *   - `integrationVerifier`→ a findings producer that additionally receives
 *                            the repo's gathered flow model, so a user
 *                            assertion can feed the gate verdict through
 *                            the same committed-snapshot seam.
 *
 * TRUST (load-bearing): a plugin executes in-process and is honored only
 * from the repo's committed tree — the npm-scripts trust boundary. Under
 * `--untrusted` plugins are never loaded: gather-time contributions simply
 * don't apply (symmetrically on both gate sides, so degradation is never a
 * false block) and producer output falls back to the committed snapshot.
 */

import type { ContractSourceReader } from './contract-reader';
import type { HttpFlowSupport } from './descriptors';
import { SDK_MAJOR } from './version';
import type {
  WireConsumedCall,
  WireContractDoc,
  WireExportReceipt,
  WireFindingsDoc,
  WireInventoryDoc,
  WireServedRoute,
} from './wire';

/**
 * An HTTP-flow dialect: the SAME declarative table a language pack declares
 * (`HttpFlowSupport`), scoped to one pack by id. Merged into that pack's
 * descriptor at gather time, flowing through the one extractor — a bespoke
 * client wrapper or niche framework becomes visible to flow with zero
 * walker code. `pack` is the language-pack id (`'typescript'`, `'python'`,
 * …) whose source files the dialect applies to; the pack must have a
 * tree-sitter grammar (a dialect extends extraction, it cannot add a
 * language).
 */
export interface HttpFlowDialect extends HttpFlowSupport {
  pack: string;
}

/** Canonical repo facts dxkit hands every plugin call — the one source of
 *  truth for these, so a plugin never re-derives them. */
export interface ExtensionRepoFacts {
  /** Absolute repo root (the plugin's cwd-independent anchor). */
  readonly root: string;
  /** Directory basenames every dxkit analysis excludes (node_modules, …). */
  readonly excludeDirs: readonly string[];
  /** Active language-pack ids in this repo. */
  readonly activeLanguages: readonly string[];
}

/** The context every producer-shaped contribution is called with — the
 *  in-process mirror of the rung-3 stdin payload. */
export interface ExtensionContext {
  /** The extension's manifest name. */
  readonly name: string;
  /** The manifest's committed `config` block, verbatim. */
  readonly config: Record<string, unknown>;
  readonly repo: ExtensionRepoFacts;
}

/** Exporter context: the post-run document to deliver rides along. */
export interface ExporterContext extends ExtensionContext {
  /** The report / verdict JSON the refresh surface hands over. */
  readonly delivery: unknown;
}

/**
 * The repo's gathered flow evidence, in wire shapes, for an
 * `integrationVerifier`. `unserved` are the consumed calls that resolved
 * against NO serving route — the gate's block candidates.
 */
export interface VerifierFlowContext {
  readonly consumed: readonly WireConsumedCall[];
  readonly served: readonly WireServedRoute[];
  readonly unserved: readonly WireConsumedCall[];
}

/** Integration-verifier context: producer context plus the flow model. */
export interface IntegrationVerifierContext extends ExtensionContext {
  readonly flow: VerifierFlowContext;
}

/** Refresh-time producer for `contributes: 'contract'`. */
export type ContractProducer = (
  ctx: ExtensionContext,
) => WireContractDoc | Promise<WireContractDoc>;

/** Refresh-time producer for `contributes: 'inventory'`. */
export type InventoryProducer = (
  ctx: ExtensionContext,
) => WireInventoryDoc | Promise<WireInventoryDoc>;

/** Refresh-time producer for `contributes: 'findings'`. */
export type FindingProducer = (ctx: ExtensionContext) => WireFindingsDoc | Promise<WireFindingsDoc>;

/** Refresh-time delivery sink for `contributes: 'export'`. */
export type Exporter = (ctx: ExporterContext) => WireExportReceipt | Promise<WireExportReceipt>;

/**
 * A user assertion over the gathered flow model (`contributes: 'findings'`).
 * Runs at refresh time on trusted context only; its findings enter the gate
 * through the same committed-snapshot seam as every findings extension —
 * higher-confidence verification with no parallel pipeline.
 */
export type IntegrationVerifier = (
  ctx: IntegrationVerifierContext,
) => WireFindingsDoc | Promise<WireFindingsDoc>;

/**
 * Custom base-URL / host-helper logic beyond `stripUrlPrefixes` — the
 * `rewriteUrl` hook on the ONE normalizer. Called with each raw URL before
 * standard normalization; return a rewritten string to take effect, or
 * `null` for "no opinion" (standard handling continues on the original).
 * The rewritten value still flows through the full canonical pipeline — a
 * normalizer hook can never bypass normalization.
 */
export type UrlNormalizer = (rawUrl: string) => string | null;

/**
 * Everything a rung-4 plugin may contribute. At least one contribution
 * point is required; `name` must equal the manifest's. See the module
 * header for where each point registers.
 */
export interface DxkitExtensionDefinition {
  /** Must equal the extension's manifest `name` (one identity). */
  name: string;
  /**
   * The SDK major this plugin targets. Stamped automatically by
   * `defineExtension`; dxkit refuses to load a plugin whose declared major
   * disagrees with the running SDK, and discloses when none is declared.
   */
  sdkMajor?: number;
  httpFlowDialect?: HttpFlowDialect;
  contractReader?: ContractSourceReader;
  urlNormalizer?: UrlNormalizer;
  contractProducer?: ContractProducer;
  inventoryProducer?: InventoryProducer;
  findingProducer?: FindingProducer;
  exporter?: Exporter;
  integrationVerifier?: IntegrationVerifier;
}

/**
 * Typed sugar for authoring a plugin: stamps the SDK major the plugin was
 * compiled against and returns the definition otherwise unchanged. An
 * explicit `sdkMajor` in the definition wins (declaring a target major
 * deliberately), though there is rarely a reason to.
 */
export function defineExtension<T extends DxkitExtensionDefinition>(
  definition: T,
): T & { sdkMajor: number } {
  return { sdkMajor: SDK_MAJOR, ...definition };
}
