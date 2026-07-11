/**
 * The contract-source reader contract — how a declared artifact format
 * (rung 2 of the extension ladder) or a rung-4 `contractReader` plugin
 * turns one artifact file into raw consumed/served observations.
 *
 * A reader is deliberately dumb: it parses ONE format into raw shapes and
 * never normalizes — dxkit re-normalizes every observation through the ONE
 * shared normalizer (`normalizePath` / `normalizeMethod`) at load, so a
 * client call and a route can only agree on canonical form because both
 * reduce in one place. Everything cross-cutting (kind dispatch, side
 * legality, path-pattern expansion, disclosure collection) lives in the
 * consuming registry (`src/analyzers/flow/contract-sources/` in the dxkit
 * monorepo); a reader supplies format knowledge only.
 *
 * Total-function discipline: `parse` returns its problems in `errors`,
 * never throws — a malformed artifact is a disclosure, not a crash.
 */

/** Which contract side(s) a declared artifact may testify to. */
export type ContractSide = 'consumed' | 'served';

/** Raw (pre-normalization) outbound-call observation a reader emits. */
export interface RawConsumedCall {
  readonly method: string;
  readonly url: string;
  readonly file: string;
  readonly line: number;
}

/** Raw (pre-normalization) served-route observation a reader emits. */
export interface RawServedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler?: string | null;
  readonly file: string;
  readonly line: number;
}

/** Everything one artifact file parsed into. */
export interface ContractSourceParse {
  readonly consumed: readonly RawConsumedCall[];
  readonly served: readonly RawServedRoute[];
  /** Format-level problems, already file-prefixed. */
  readonly errors: readonly string[];
}

/**
 * One registered artifact format. Built-in readers (OpenAPI, Postman, Pact,
 * .http, HAR) and rung-4 plugin readers implement the same interface and
 * register into the same registry — one code path per concept regardless of
 * who authored the entry.
 */
export interface ContractSourceReader {
  /** The `flow.sources[].kind` token. */
  readonly kind: string;
  readonly displayName: string;
  /** Sides this format can testify to ('both' → the declaration may choose). */
  readonly sides: ContractSide | 'both';
  /** Side used when the declaration omits one. */
  readonly defaultSide: ContractSide;
  /** Cheap filename signal for doctor's "declare this artifact" probe. */
  sniff(filePath: string): boolean;
  /** Parse one artifact file into raw observations. Total: parse errors are
   *  returned, never thrown. */
  parse(content: string, filePath: string): ContractSourceParse;
}
