/**
 * File-convention route derivation — the served side for frameworks that route
 * by a handler file's LOCATION on disk (Next.js App Router `route.ts` under
 * `app/`, SvelteKit `+server.ts` under `src/routes/`, Next.js Pages Router
 * files under `pages/api/`) rather than an in-source decorator or router call.
 *
 * Two concerns live here, both framework-GENERAL:
 *
 *   1. The **path algebra** (`deriveFileRoutePath`) — turn a repo-relative file
 *      path into the served URL by stripping the routing base, dropping
 *      organizational segments (route groups `(x)`, parallel slots `@x`),
 *      excluding private `_`-segments, and canonicalizing dynamic segments
 *      (`[id]` / `[[...slug]]` / `[...slug]`) to `{var}`. These conventions are
 *      shared across every file-route framework, so — like the `:id`→`{var}`
 *      canonicalization in `normalize.ts` (Rule 6 boundary) — they are NOT a
 *      per-pack fact. The pack supplies only the framework-specific inputs
 *      (`FileRouteSupport`: handler filename, base dirs, url prefix, verb
 *      exports); no `'route'` / `'app'` literal ever appears in this file.
 *
 *   2. The **verb-export read** (`exportedMethodNames`) — which HTTP-verb-named
 *      exports a handler file declares. Next.js App Router + SvelteKit express
 *      the method as the exported symbol's name (`export function GET`).
 *
 * Pure over its inputs. Every derived path is finished through the shared
 * `normalizePath`, so a file-route endpoint and a client call that targets it
 * reduce to the SAME canonical key and join — identity (Rule 9) stays uniform
 * across every route-discovery mechanism.
 */

import type { Node } from '../../ast/parse';
import type { FileRouteSupport } from '../../languages/types';
import { normalizePath, CATCHALL, type NormalizeConfig } from './normalize';

/** A route group / layout segment: an entire segment wrapped in parentheses,
 *  organizational only (`(payload)`, `(marketing)`) — dropped from the URL. */
const ROUTE_GROUP = /^\(.+\)$/;
/** A parallel-route slot (`@modal`) — renders into a slot, adds no URL segment. */
const PARALLEL_SLOT = /^@/;
/** A catch-all / optional-catch-all segment (`[...slug]`, `[[...slug]]`). */
const CATCH_ALL = /^\[\[?\.\.\.[^\]]+\]\]?$/;
/** A single dynamic segment (`[id]`). */
const DYNAMIC = /^\[.+\]$/;
/** The placeholder a single dynamic segment canonicalizes to (matches normalize.ts). */
const PLACEHOLDER = '{var}';

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function stripExt(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(0, dot) : basename;
}

/**
 * Locate the routing base within `segments`. Returns the index of the first
 * segment AFTER the base (where the route path begins), or -1 when no base
 * matches. The longest (most-specific) declared base wins, so `src/app` is
 * preferred over `app` when a path contains both.
 */
function findBaseEnd(segments: readonly string[], baseDirs: readonly string[]): number {
  const bases = [...baseDirs]
    .map((b) => toPosix(b).split('/').filter(Boolean))
    .sort((a, b) => b.length - a.length);
  for (const base of bases) {
    for (let i = 0; i + base.length <= segments.length; i++) {
      if (base.every((seg, k) => segments[i + k] === seg)) return i + base.length;
    }
  }
  return -1;
}

/**
 * Canonicalize one directory segment to its URL contribution:
 *   - `''` → drop (route group / parallel slot: not part of the URL);
 *   - `'{*}'` → catch-all segment (`[...slug]`) — a prefix matcher (the shared
 *     `CATCHALL` marker, distinct from a single dynamic segment);
 *   - `'{var}'` → single dynamic segment (`[id]`);
 *   - `null` → the whole route is NOT served (a private `_`-segment opts the
 *     subtree out of routing);
 *   - otherwise the literal segment.
 */
function classifySegment(seg: string): string | null {
  if (seg.startsWith('_')) return null; // private subtree — not routable
  if (ROUTE_GROUP.test(seg) || PARALLEL_SLOT.test(seg)) return ''; // organizational
  if (CATCH_ALL.test(seg)) return CATCHALL; // [...slug] → prefix matcher
  if (DYNAMIC.test(seg)) return PLACEHOLDER; // [id] → single dynamic segment
  return seg;
}

/**
 * Derive the served URL path for a handler file at `relPath` (repo-relative,
 * either separator), or `null` when the file is not a served route under this
 * descriptor — a non-handler basename, a file outside every base dir, a private
 * subtree, or a base-root handler with no path segments (a bare `/`, which the
 * shared normalizer drops as signal-free). The result is the canonical path the
 * flow join keys on.
 */
export function deriveFileRoutePath(
  relPath: string,
  desc: FileRouteSupport,
  config?: NormalizeConfig,
): string | null {
  const segments = toPosix(relPath).split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const basename = segments[segments.length - 1];
  const stem = stripExt(basename);
  const wildcard = desc.handlerFile === '*';
  if (!wildcard && stem !== desc.handlerFile) return null;

  const baseEnd = findBaseEnd(segments, desc.baseDirs);
  if (baseEnd < 0) return null;

  // Route segments: the dirs between the base and the handler file. In wildcard
  // mode the filename IS the last path segment (`index` collapses to its dir).
  const routeSegments = wildcard
    ? [...segments.slice(baseEnd, segments.length - 1), stem].filter((s) => s !== 'index')
    : segments.slice(baseEnd, segments.length - 1);

  const parts: string[] = [];
  for (const seg of routeSegments) {
    const mapped = classifySegment(seg);
    if (mapped === null) return null; // private subtree
    if (mapped === '') continue; // organizational segment
    parts.push(mapped);
  }

  const prefix = desc.urlPrefix ? toPosix(desc.urlPrefix).split('/').filter(Boolean) : [];
  const raw = '/' + [...prefix, ...parts].join('/');
  return normalizePath(raw, config);
}

/** A verb-named export found in a handler file: the method name + its line. */
export interface MethodExport {
  readonly name: string;
  readonly line: number;
}

/**
 * Collect the HTTP-verb-named exports a handler file declares, intersected with
 * the descriptor's `methodExports`. Handles the three export shapes a route
 * handler uses: `export function GET`, `export const GET =`, and
 * `export { GET }`. Only DIRECT exports count — a verb-named function nested
 * inside another (non-exported) declaration is not a route method. Deduped by
 * name (first occurrence wins for the line).
 */
export function exportedMethodNames(root: Node, methodExports: readonly string[]): MethodExport[] {
  const wanted = new Set(methodExports);
  const found = new Map<string, number>();

  for (const stmt of allNamedDescendants(root)) {
    if (stmt.type !== 'export_statement') continue;

    const decl = stmt.childForFieldName('declaration');
    if (decl) {
      if (decl.type === 'function_declaration' || decl.type === 'generator_function_declaration') {
        addIfWanted(decl.childForFieldName('name'), wanted, found);
      } else if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
        for (const d of decl.namedChildren) {
          if (d && d.type === 'variable_declarator')
            addIfWanted(d.childForFieldName('name'), wanted, found);
        }
      }
      continue;
    }

    // `export { GET, POST }`
    const clause = stmt.namedChildren.find((c) => c?.type === 'export_clause') ?? null;
    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec && spec.type === 'export_specifier')
          addIfWanted(spec.childForFieldName('name'), wanted, found);
      }
    }
  }

  return [...found].map(([name, line]) => ({ name, line }));
}

function addIfWanted(
  nameNode: Node | null,
  wanted: ReadonlySet<string>,
  found: Map<string, number>,
): void {
  if (
    nameNode &&
    nameNode.type === 'identifier' &&
    wanted.has(nameNode.text) &&
    !found.has(nameNode.text)
  ) {
    found.set(nameNode.text, nameNode.startPosition.row + 1);
  }
}

/**
 * Top-level named children only — an export can appear as a direct child of the
 * program, so walking the immediate named descendants suffices and avoids
 * descending into function bodies (where a nested `export`-shaped node cannot
 * legally live anyway). Kept as a helper so the intent is explicit.
 */
function allNamedDescendants(root: Node): Node[] {
  return root.namedChildren.filter((c): c is Node => c !== null);
}
