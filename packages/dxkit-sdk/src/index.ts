/**
 * @vyuhlabs/dxkit-sdk — the frozen extension surface of dxkit.
 *
 * Everything exported from this barrel is contract: additive-only within a
 * major, pinned by the main repo's `test/sdk-surface-freeze.test.ts`. The
 * main package re-exports these same symbols internally (one concept, one
 * code path), so an extension and dxkit itself always agree on the shapes.
 */
export { SDK_MAJOR } from './version';
export type { FileRouteSupport, HttpFlowSupport, ModelSchemaSupport } from './descriptors';
export type { GrammarModelShape, GrammarShape, ResolvedCall } from './grammar';
export {
  ANY_METHOD,
  CATCHALL,
  bindingKey,
  catchAllStaticPrefix,
  isCatchAllPath,
  normalizeMethod,
  normalizePath,
} from './http-normalize';
export type { HttpMethod, NormalizeConfig, ServedMethod } from './http-normalize';
export { walk } from './ast';
export type { Node, ParsedFile, ParseFileFn, ParseSourceFn, Tree } from './ast';
