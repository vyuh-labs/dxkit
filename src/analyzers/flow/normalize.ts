/**
 * URL / route-path normalization — re-exported from @vyuhlabs/dxkit-sdk,
 * where the implementation moved (the frozen extension surface, CLAUDE.md
 * Rule 18). There is ONE normalizer: dxkit's extractors, the flow join, the
 * gate, and external extensions all reduce paths through the same function,
 * so a client call and a route declaration can never disagree on canonical
 * form because two normalizers drifted.
 *
 * Every existing consumer keeps this import path; the SDK module
 * (`packages/dxkit-sdk/src/http-normalize.ts`) is the single source.
 */
export {
  ANY_METHOD,
  CATCHALL,
  bindingKey,
  catchAllStaticPrefix,
  isCatchAllPath,
  normalizeMethod,
  normalizePath,
} from '@vyuhlabs/dxkit-sdk';
export type { HttpMethod, NormalizeConfig, ServedMethod } from '@vyuhlabs/dxkit-sdk';
