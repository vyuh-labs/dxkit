/**
 * Flow setup — the detection + apply behind folding `flow init` into `init`.
 *
 * `init` runs `detectFlowTopology` to decide whether a repo even HAS a UI→API
 * surface worth gating (if not, the init wizard stays silent — zero burden).
 * When it does, init surfaces the two learnings this module computes — the
 * dominant host-helper to strip, and any multiple backend services — as confirm
 * prompts, then `applyFlowSetup` writes the resulting config (`.dxkit/policy.json:flow`
 * plus `.dxkit/workspace.json` when participants are named).
 *
 * Detection reuses the same `gatherFlowModel` the gate runs (Rule 2 — one
 * extractor); it never re-parses source itself. Fail-open throughout — an error
 * degrades to "no flow detected", which the caller treats as "don't ask".
 */

import { detectActiveLanguages, allFlowSourceExtensions } from '../../languages';
import { gatherFlowModel } from './gather';
import { isPlaceholderOnlyPath } from './model';
import { writeFlowPolicy, type FlowGateMode } from './config';
import { writeWorkspace, type WorkspaceParticipant } from '../../workspace';
import type { ClientCall, RouteEndpoint } from './extract';

/** Which halves of the UI→API contract this repo contains. */
export type FlowTopology = 'monorepo' | 'consumer-only' | 'provider-only' | 'none';

export interface FlowDetection {
  /** monorepo (both sides) · consumer-only (calls, no routes) · provider-only
   *  (routes, no calls) · none (nothing to gate — stay silent). */
  readonly topology: FlowTopology;
  readonly callCount: number;
  readonly routeCount: number;
  /** Calls that already bind to a served route — the healthy baseline. */
  readonly resolvedCount: number;
  /** Dominant host-helper prefix(es) across client calls — the strip-prefix the
   *  setup offers so a call like `${Config.api()}/x` matches a served `/x`. */
  readonly suggestedStripPrefixes: readonly string[];
  /** Distinct top-level directories that serve routes — a best-effort
   *  multi-service hint (robust multi-repo splitting is M4.3's `flow publish`). */
  readonly detectedServices: readonly string[];
}

const NONE: FlowDetection = {
  topology: 'none',
  callCount: 0,
  routeCount: 0,
  resolvedCount: 0,
  suggestedStripPrefixes: [],
  detectedServices: [],
};

/**
 * Detect the repo's flow topology by running the shared extractor. Returns
 * `topology: 'none'` (and the caller stays silent) when no flow-capable pack is
 * active, when extraction finds nothing, or on any error.
 */
export async function detectFlowTopology(cwd: string): Promise<FlowDetection> {
  // Cheap gate first: if no active pack extracts flow, don't even run the
  // extractor (keeps `init --yes` on a non-flow repo fast).
  if (allFlowSourceExtensions(detectActiveLanguages(cwd)).length === 0) return NONE;

  let model;
  try {
    model = await gatherFlowModel({ roots: [cwd] });
  } catch {
    return NONE;
  }

  const callCount = model.calls.length;
  const routeCount = model.routes.length;
  if (callCount === 0 && routeCount === 0) return NONE;

  const resolvedCount = model.bindings.filter(
    (b) => b.route !== null && !isPlaceholderOnlyPath(b.route.path),
  ).length;

  const topology: FlowTopology =
    callCount > 0 && routeCount > 0
      ? 'monorepo'
      : callCount > 0
        ? 'consumer-only'
        : 'provider-only';

  return {
    topology,
    callCount,
    routeCount,
    resolvedCount,
    suggestedStripPrefixes: dominantHostPrefixes(model.calls),
    detectedServices: servicesFromRoutes(model.routes),
  };
}

/**
 * The prefix of a raw client URL that is NOT part of the route path — an
 * absolute `scheme://host`, or a leading `${...}` base-URL helper template. A
 * relative URL (`/articles`) has no host prefix. This is exactly what a
 * strip-prefix removes so a templated call matches a served route.
 */
export function hostPrefixOf(rawUrl: string): string | null {
  // A template-literal URL is captured WITH its backticks (`${Config.api()}/x`);
  // strip a leading one so the `${...}` head is at the string start. A plain
  // string literal is captured without quotes, so this is a no-op for it.
  const s = rawUrl.replace(/^`/, '');
  const abs = /^(https?:\/\/[^/`]+)/.exec(s);
  if (abs) return abs[1];
  const tmpl = /^(\$\{[^}]+\})/.exec(s);
  if (tmpl) return tmpl[1];
  return null;
}

/** Host-helper prefixes ranked by frequency across calls, most common first.
 *  Empty when calls are all relative (nothing to strip). */
export function dominantHostPrefixes(calls: readonly ClientCall[]): string[] {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const p = hostPrefixOf(c.rawUrl);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** Distinct top-level directories that contain served routes — a coarse
 *  multi-service signal. Returns [] when routes live under one top-level dir
 *  (a single service). Deeper (nested / multi-repo) service splitting is
 *  M4.3's concern; here we only surface the obvious top-level split. */
export function servicesFromRoutes(routes: readonly RouteEndpoint[]): string[] {
  const dirs = new Set<string>();
  for (const r of routes) {
    const top = r.file.split(/[/\\]/)[0];
    if (top && top !== r.file) dirs.add(top); // skip files at repo root (no dir)
  }
  return dirs.size >= 2 ? [...dirs].sort() : [];
}

/** The confirmed setup a caller applies after the init prompts. */
export interface FlowSetupDecision {
  readonly mode: FlowGateMode;
  readonly stripUrlPrefixes: readonly string[];
  /** Named participants → written to workspace.json (the multi-service /
   *  cross-repo case). Omitted for a single-service monorepo. */
  readonly participants?: readonly WorkspaceParticipant[];
}

/**
 * Apply a confirmed flow setup: write `flow.mode` (+ strip prefixes) into
 * `.dxkit/policy.json` via the canonical writer, and — when participants are
 * named — `.dxkit/workspace.json`. Returns the repo-relative paths written (for
 * the init summary). Never throws on an already-current policy (idempotent).
 */
export function applyFlowSetup(cwd: string, decision: FlowSetupDecision): string[] {
  const written: string[] = [];
  const changed = writeFlowPolicy(cwd, {
    mode: decision.mode,
    ...(decision.stripUrlPrefixes.length
      ? { stripUrlPrefixes: [...decision.stripUrlPrefixes] }
      : {}),
  });
  if (changed) written.push('.dxkit/policy.json');
  if (decision.participants && decision.participants.length > 0) {
    writeWorkspace(cwd, { participants: [...decision.participants], external: [] });
    written.push('.dxkit/workspace.json');
  }
  return written;
}
