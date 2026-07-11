/**
 * HTTP-flow dialect merging — how a rung-4 plugin's `httpFlowDialect`
 * extends a language pack's `httpFlow` descriptor WITHOUT forking it.
 *
 * A dialect is the same declarative table a pack declares
 * (`HttpFlowSupport`), scoped by `pack` id. At gather time the extractor
 * resolves a file's pack descriptor and folds every matching dialect in
 * through `mergeHttpFlow`; the merged table then flows through the ONE
 * extractor unchanged — a dialect can teach it a bespoke client wrapper or
 * a niche framework, never new engine behavior.
 *
 * Merge discipline is ADDITIVE-ONLY: token lists union (deduped), grouped
 * tables union their lists, boolean escape hatches OR. A dialect can only
 * widen what counts as HTTP — it can never remove or override a pack fact
 * (`methodAliases` conflicts resolve to the pack's value; `fileRoutes` is
 * pack-only, a routing convention is not extendable by token union). That
 * bias keeps a plugin from silently blinding native extraction.
 */

import type { HttpFlowDialect, HttpFlowSupport } from '@vyuhlabs/dxkit-sdk';

function unionStrings(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Fold `dialects` (already filtered to one pack) into that pack's own
 * descriptor. Returns the base untouched when there is nothing to merge,
 * and a dialect-only union when the pack declares no `httpFlow` at all (a
 * dialect can bring flow to a grammar-bearing pack that never had it).
 */
export function mergeHttpFlow(
  base: HttpFlowSupport | undefined,
  dialects: readonly HttpFlowSupport[],
): HttpFlowSupport | undefined {
  if (dialects.length === 0) return base;
  let merged: HttpFlowSupport = { ...(base ?? {}) };
  for (const d of dialects) merged = mergeOne(merged, d);
  return merged;
}

function mergeOne(base: HttpFlowSupport, d: HttpFlowSupport): HttpFlowSupport {
  const out: HttpFlowSupport = { ...base };

  const clientCallees = unionStrings(base.clientCallees, d.clientCallees);
  if (clientCallees) out.clientCallees = clientCallees;

  const routeDecorators = unionStrings(base.routeDecorators, d.routeDecorators);
  if (routeDecorators) out.routeDecorators = routeDecorators;

  if (base.clientMethodCallees || d.clientMethodCallees) {
    const methods =
      unionStrings(base.clientMethodCallees?.methods, d.clientMethodCallees?.methods) ?? [];
    const bases = unionStrings(base.clientMethodCallees?.bases, d.clientMethodCallees?.bases);
    out.clientMethodCallees = { methods, ...(bases ? { bases } : {}) };
  }

  if (base.routeRouterCallees || d.routeRouterCallees) {
    out.routeRouterCallees = {
      methods: unionStrings(base.routeRouterCallees?.methods, d.routeRouterCallees?.methods) ?? [],
      bases: unionStrings(base.routeRouterCallees?.bases, d.routeRouterCallees?.bases) ?? [],
    };
  }

  if (base.routeMemberDecorators || d.routeMemberDecorators) {
    const methods =
      unionStrings(base.routeMemberDecorators?.methods, d.routeMemberDecorators?.methods) ?? [];
    const bases = unionStrings(base.routeMemberDecorators?.bases, d.routeMemberDecorators?.bases);
    out.routeMemberDecorators = { methods, ...(bases ? { bases } : {}) };
  }

  if (base.routePathDecorators || d.routePathDecorators) {
    // The keyword + defaults are pack semantics; the pack's win on conflict.
    const winner = base.routePathDecorators ?? d.routePathDecorators;
    out.routePathDecorators = {
      names: unionStrings(base.routePathDecorators?.names, d.routePathDecorators?.names) ?? [],
      methodsKeyword: winner?.methodsKeyword ?? 'methods',
      defaultMethods: winner?.defaultMethods ?? ['GET'],
    };
  }

  if (base.routeCallees || d.routeCallees) {
    const names = unionStrings(base.routeCallees?.names, d.routeCallees?.names);
    const memberNames = unionStrings(base.routeCallees?.memberNames, d.routeCallees?.memberNames);
    const excludeArgCallees = unionStrings(
      base.routeCallees?.excludeArgCallees,
      d.routeCallees?.excludeArgCallees,
    );
    out.routeCallees = {
      ...(names ? { names } : {}),
      ...(memberNames ? { memberNames } : {}),
      ...(excludeArgCallees ? { excludeArgCallees } : {}),
      ...(base.routeCallees?.methodPrefixInPath || d.routeCallees?.methodPrefixInPath
        ? { methodPrefixInPath: true }
        : {}),
    };
  }

  if (base.clientRequestCallees || d.clientRequestCallees) {
    const names =
      unionStrings(base.clientRequestCallees?.names, d.clientRequestCallees?.names) ?? [];
    const bases = unionStrings(base.clientRequestCallees?.bases, d.clientRequestCallees?.bases);
    out.clientRequestCallees = { names, ...(bases ? { bases } : {}) };
  }

  if (base.methodAliases || d.methodAliases) {
    // Additive-only: a dialect may add aliases, never override a pack's.
    out.methodAliases = { ...(d.methodAliases ?? {}), ...(base.methodAliases ?? {}) };
  }

  // fileRoutes deliberately NOT merged from dialects: a file-routing
  // convention is structural, not a token list — extending it belongs to a
  // pack (Rule 6), not a plugin overlay.

  if (base.flowSignals || d.flowSignals) {
    out.flowSignals = [...(base.flowSignals ?? []), ...(d.flowSignals ?? [])];
  }

  return out;
}

/** Index dialects by their target pack id, for per-file resolution. */
export function dialectsByPack(
  dialects: readonly HttpFlowDialect[],
): ReadonlyMap<string, HttpFlowSupport[]> {
  const map = new Map<string, HttpFlowSupport[]>();
  for (const d of dialects) {
    const { pack, ...table } = d;
    const list = map.get(pack) ?? [];
    list.push(table);
    map.set(pack, list);
  }
  return map;
}
