/**
 * CONTRACT_SOURCE_READERS — the registry of declared contract artifacts
 * (rung 2 of the extension ladder: a path to a file you already have).
 *
 * Formats are ENTRIES, not features: each reader is one module that parses
 * one well-known artifact format (Postman collection, Pact contract,
 * .http/.rest request file, HAR capture, OpenAPI document) into RAW
 * consumed/served observations; this module owns everything cross-cutting —
 * kind dispatch, side legality, path-pattern expansion, and normalization
 * through the ONE shared normalizer (a reader never normalizes; a client
 * call and a route can only agree on canonical form because both reduce
 * here). Adding a format is one module + one entry; the synthetic-reader
 * playbook test proves consumers pick a new entry up untouched, and the
 * arch gate keeps format kind-literals confined to this directory.
 *
 * Fail-open discipline: a missing file, an unparseable artifact, an unknown
 * kind, or an illegal side is a DISCLOSURE (collected, surfaced by doctor /
 * the map), never a crash — declared artifacts degrade the same way specs
 * always have.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ClientCall, RouteEndpoint } from '../extract';
import { ANY_METHOD, normalizeMethod, normalizePath, type NormalizeConfig } from '../normalize';
import { harReader } from './har';
import { httpFileReader } from './http-file';
import { openapiReader } from './openapi';
import { pactReader } from './pact';
import { postmanReader } from './postman';

/** Which contract side(s) a declared artifact may testify to. */
export type ContractSide = 'consumed' | 'served';

/** Raw (pre-normalization) observations a reader emits. */
export interface RawConsumedCall {
  readonly method: string;
  readonly url: string;
  readonly file: string;
  readonly line: number;
}
export interface RawServedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler?: string | null;
  readonly file: string;
  readonly line: number;
}
export interface ContractSourceParse {
  readonly consumed: readonly RawConsumedCall[];
  readonly served: readonly RawServedRoute[];
  /** Format-level problems, already file-prefixed. */
  readonly errors: readonly string[];
}

/** One registered artifact format. */
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

export const CONTRACT_SOURCE_READERS: readonly ContractSourceReader[] = [
  openapiReader,
  postmanReader,
  pactReader,
  httpFileReader,
  harReader,
];

export function contractSourceReaderFor(
  kind: string,
  registry: readonly ContractSourceReader[] = CONTRACT_SOURCE_READERS,
): ContractSourceReader | undefined {
  return registry.find((r) => r.kind === kind);
}

/** A `flow.sources[]` declaration (validated here, not at config read —
 *  the registry lives here, so the loud unknown-kind error does too). */
export interface FlowSourceDecl {
  readonly kind: string;
  readonly path: string;
  readonly side?: string;
}

export interface ContractSourceLoad {
  readonly calls: readonly ClientCall[];
  readonly routes: readonly RouteEndpoint[];
  /** Everything the load could not use, disclosed: unknown kinds, illegal
   *  sides, missing files, parse errors, dropped externals. */
  readonly disclosures: readonly string[];
}

/**
 * Expand a declared path: an exact repo-relative path, or a single-`*`
 * glob in the LAST segment (`requests/*.http`). Deliberately no `**` — a
 * declaration names artifacts, it does not scan the tree.
 */
function expandSourcePattern(cwd: string, pattern: string): string[] {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return [pattern];
  const dir = path.posix.dirname(pattern);
  const base = path.posix.basename(pattern);
  if (dir.includes('*') || base.indexOf('*') !== base.lastIndexOf('*')) return [];
  const re = new RegExp(`^${base.split('*').map(escapeRe).join('.*')}$`);
  try {
    return fs
      .readdirSync(path.join(cwd, dir))
      .filter((f) => re.test(f))
      .sort()
      .map((f) => path.posix.join(dir, f));
  } catch {
    return [];
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Load every declared contract artifact into normalized flow shapes. The
 * consumed side normalizes with the app's `stripUrlPrefixes` (absolute
 * URLs in captures/collections reduce to route paths); the served side
 * normalizes bare, exactly as spec routes always have. Consumed calls
 * carry the reader kind as their receiver; served routes carry it as
 * `via` — provenance without new fields.
 */
export function loadContractSources(
  cwd: string,
  sources: readonly FlowSourceDecl[],
  normalize: NormalizeConfig,
  registry: readonly ContractSourceReader[] = CONTRACT_SOURCE_READERS,
): ContractSourceLoad {
  const calls: ClientCall[] = [];
  const routes: RouteEndpoint[] = [];
  const disclosures: string[] = [];

  for (const decl of sources) {
    const reader = contractSourceReaderFor(decl.kind, registry);
    if (!reader) {
      const known = registry.map((r) => `'${r.kind}'`).join(' | ');
      disclosures.push(`flow.sources: unknown kind '${decl.kind}' — known kinds: ${known}`);
      continue;
    }
    if (decl.side !== undefined && decl.side !== 'consumed' && decl.side !== 'served') {
      disclosures.push(
        `flow.sources[${decl.kind}]: side must be 'consumed' or 'served' (got ${JSON.stringify(decl.side)})`,
      );
      continue;
    }
    const side: ContractSide = decl.side ?? reader.defaultSide;
    if (reader.sides !== 'both' && side !== reader.sides) {
      disclosures.push(
        `flow.sources[${decl.kind}]: a ${reader.displayName} testifies to the '${reader.sides}' side only`,
      );
      continue;
    }

    const files = expandSourcePattern(cwd, decl.path);
    if (files.length === 0) {
      disclosures.push(`flow.sources[${decl.kind}]: no file matches '${decl.path}'`);
      continue;
    }
    for (const rel of files) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
      } catch {
        disclosures.push(`flow.sources[${decl.kind}]: cannot read '${rel}'`);
        continue;
      }
      const parsed = reader.parse(content, rel);
      disclosures.push(...parsed.errors);

      let droppedExternal = 0;
      if (side === 'consumed') {
        for (const c of parsed.consumed) {
          const method = normalizeMethod(c.method);
          if (!method) continue;
          const p = normalizePath(c.url, normalize);
          if (p === null) {
            droppedExternal++;
            continue;
          }
          calls.push({
            method,
            rawUrl: c.url,
            path: p,
            receiver: reader.kind,
            file: c.file,
            line: c.line,
          });
        }
        // A consumed-side declaration may still carry served evidence the
        // reader chose to emit (a format that inherently has both); the
        // side declaration gates what we USE.
      } else {
        for (const s of [...parsed.served, ...consumedAsServed(parsed.consumed)]) {
          const method = s.method === ANY_METHOD ? ANY_METHOD : normalizeMethod(s.method);
          if (!method) continue;
          const p = normalizePath(s.path);
          if (p === null) {
            droppedExternal++;
            continue;
          }
          routes.push({
            method,
            path: p,
            via: reader.kind,
            handler: s.handler ?? null,
            file: s.file,
            line: s.line,
          });
        }
      }
      if (droppedExternal > 0) {
        disclosures.push(
          `flow.sources[${reader.kind}]: ${rel}: ${droppedExternal} entr${droppedExternal === 1 ? 'y' : 'ies'} dropped (external or non-path URL — add the host to flow.stripUrlPrefixes if it is your own)`,
        );
      }
    }
  }
  return { calls, routes, disclosures };
}

/** A request-shaped artifact declared `side: 'served'` reads each request
 *  as a route the repo serves (a Postman collection documenting your OWN
 *  API). */
function consumedAsServed(consumed: readonly RawConsumedCall[]): RawServedRoute[] {
  return consumed.map((c) => ({ method: c.method, path: c.url, file: c.file, line: c.line }));
}
