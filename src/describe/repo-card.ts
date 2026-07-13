/**
 * Pure `DescribeInput → RepoCardDoc`. The label mapping is the whole point:
 * every count is split by how dxkit knows it (`EpistemicLabel`), and the
 * mapping is a pure function of fields the gather already produced — no new
 * bookkeeping, no second confidence scale.
 *
 * Label rules (mirror of DESIGN-describe-contract-map.md):
 *   - route  → observed when statically extracted (decorator/router-call/
 *     file-route); derived when it comes from a declared contract (spec /
 *     openapi / postman / pact / http / har).
 *   - call   → observed when its URL is a literal (path resolved); unknown
 *     when the URL is computed (path === null).
 *   - binding→ exact=observed, var-match=derived, catch-all/placeholder=
 *     inferred, no-route/external=unknown (carries the existing confidence).
 *   - model  → derived from a spec, else observed; dynamic models=unknown.
 */
import { evidenceEnvelope, type EpistemicLabel } from '../evidence/conventions';
import { activeLanguagesFromStack } from '../languages/index';
import type { RouteEndpoint, ClientCall } from '../analyzers/flow/extract';
import type { FlowBinding, BindingReason } from '../analyzers/flow/model';
import type { ModelEntity } from '../analyzers/model-schema/model';
import { REPO_CARD_SCHEMA, type LabeledCounts, type RepoCardDoc } from './repo-card-schema';
import type { DescribeInput } from './gather';

/**
 * Route provenances dxkit extracts from source itself (the closed static-
 * extraction core) → `observed`. Anything else — `spec` and every declared
 * contract-source kind from the reader registry — is trusted-but-unseen →
 * `derived`. Inverting the test this way keeps contract-format kinds out of
 * this module (they live in the reader registry) and auto-labels any future
 * contract kind `derived`.
 */
const OBSERVED_ROUTE_VIA = new Set(['decorator', 'router-call', 'file-route']);

export function labelForRoute(via: string): EpistemicLabel {
  return OBSERVED_ROUTE_VIA.has(via) ? 'observed' : 'derived';
}

export function labelForCall(call: Pick<ClientCall, 'path'>): EpistemicLabel {
  return call.path === null ? 'unknown' : 'observed';
}

export function labelForBinding(reason: BindingReason): EpistemicLabel {
  switch (reason) {
    case 'exact':
      return 'observed';
    case 'var-match':
      return 'derived';
    case 'catch-all':
    case 'placeholder-only':
      return 'inferred';
    case 'no-route':
    case 'external':
      return 'unknown';
  }
}

export function labelForModel(via: ModelEntity['via']): EpistemicLabel {
  return via === 'spec' ? 'derived' : 'observed';
}

/** Tally a labeled breakdown from a list of (item → label) classifications. */
function tally<T>(items: readonly T[], label: (t: T) => EpistemicLabel): LabeledCounts {
  const counts = { observed: 0, derived: 0, inferred: 0, unknown: 0 };
  for (const it of items) counts[label(it)]++;
  return { total: items.length, ...counts };
}

/** Human-readable disclosures — the honesty channel in prose form. */
function buildNotes(input: DescribeInput): string[] {
  const notes: string[] = [];
  const { flow, diagnosis, models, coverage, freshness, provenance } = input;

  if (diagnosis === null) {
    notes.push(
      'No flow-capable pack resolved a spine for this stack; route/call analysis may be partial.',
    );
  }
  if (flow.dynamicCalls.length > 0) {
    notes.push(
      `${flow.dynamicCalls.length} call site(s) build their URL at runtime and cannot be resolved (labeled unknown).`,
    );
  }
  if (models.dynamicModels.length > 0) {
    notes.push(
      `${models.dynamicModels.length} model(s) are shaped at runtime and cannot be extracted (labeled unknown).`,
    );
  }
  if (coverage.paths.opaque > 0) {
    notes.push(
      `${coverage.paths.opaque} call path(s) are opaque (a leading variable segment); their binding is inferred, not observed.`,
    );
  }
  const rung = diagnosis?.connection.rung;
  if (rung && rung !== 'monorepo') {
    notes.push(
      `The consumed side was located via "${rung}"; unconsumed-route findings are only as complete as the visible consumers.`,
    );
  }
  if (freshness?.stale) {
    notes.push('The committed contract is stale relative to the served side.');
  }
  if (provenance.workingTreeDirty) {
    notes.push('Card reflects a dirty working tree (uncommitted changes present).');
  }
  return notes;
}

/** Infrastructure flags → display names (observed facts). */
function infraNames(infra: DescribeInput['stack']['infrastructure']): string[] {
  const out: string[] = [];
  if (infra.docker) out.push('docker');
  if (infra.postgres) out.push('postgres');
  if (infra.redis) out.push('redis');
  return out;
}

export function buildRepoCard(input: DescribeInput): RepoCardDoc {
  const { stack, provenance, flow, diagnosis, models, coverage, freshness } = input;

  const routes = tally(flow.routes, (r: RouteEndpoint) => labelForRoute(r.via));
  const calls = tally(flow.calls, (c) => labelForCall(c));
  const bindings = tally(flow.bindings, (b: FlowBinding) => labelForBinding(b.reason));

  // Seam counts: prefer the canonical diagnosis; fall back to the model so a
  // stack without a diagnosis still reports honest seam numbers.
  const unresolvedCalls =
    diagnosis?.unresolved.length ?? flow.bindings.filter((b) => b.route === null).length;
  const unconsumedRoutes =
    diagnosis?.servedUnconsumed.length ??
    flow.routes.filter((r) => !flow.bindings.some((b) => b.route && b.route.path === r.path))
      .length;

  return {
    ...evidenceEnvelope(REPO_CARD_SCHEMA),
    schema: REPO_CARD_SCHEMA,
    provenance: {
      commitSha: provenance.commitSha,
      branch: provenance.branch,
      workingTreeDirty: provenance.workingTreeDirty,
    },
    stack: {
      name: stack.projectName,
      description: stack.projectDescription,
      languages: activeLanguagesFromStack(stack).map((l) => l.displayName),
      framework: stack.framework ?? null,
      infrastructure: infraNames(stack.infrastructure),
    },
    flow: {
      routes,
      calls,
      bindings,
      unresolvedCalls,
      unconsumedRoutes,
      dynamicCalls: flow.dynamicCalls.length,
      connectionRung: diagnosis?.connection.rung ?? 'unresolved',
    },
    models: {
      models: tally(models.models, (m: ModelEntity) => labelForModel(m.via)),
      dynamicModels: models.dynamicModels.length,
    },
    freshness: freshness
      ? {
          generatedAt: freshness.generatedAt,
          commitSha: freshness.commitSha ?? null,
          stale: freshness.stale,
          participants: freshness.participants.length,
        }
      : null,
    coverage: {
      callSitesSeen: coverage.callSitesSeen,
      extracted: coverage.extracted,
      dynamic: coverage.dynamic,
      paths: { ...coverage.paths },
      note: coverage.note,
    },
    notes: buildNotes(input),
    zeroWrite: true,
  };
}
