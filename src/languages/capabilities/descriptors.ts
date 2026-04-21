/**
 * Capability descriptors.
 *
 * Each capability the dispatcher knows about has one descriptor. The
 * descriptor bundles the capability's stable id with its aggregate
 * function — how to combine multiple providers' results into one
 * envelope. Aggregation is bespoke per capability rather than a generic
 * 'sum' / 'append' / 'last' strategy because the merge semantics
 * legitimately differ (depVulns sums counts AND concats findings AND
 * joins tool names AND prefers any provider that did osv enrichment),
 * and a 5-strategy enum would lie about that.
 *
 * The dispatcher never calls aggregate() with an empty array — that
 * case is handled upstream by returning null.
 */

import type {
  CapabilityEnvelope,
  CoverageResult,
  DepVulnResult,
  ImportsResult,
  LintResult,
  TestFrameworkResult,
} from './types';

export interface CapabilityDescriptor<T extends CapabilityEnvelope> {
  readonly id: string;
  /** Combine ≥1 non-null results from different providers into one envelope. */
  aggregate(results: ReadonlyArray<T>): T;
}

function uniqueJoin(values: ReadonlyArray<string>, sep = ', '): string {
  const seen = new Set<string>();
  for (const v of values) seen.add(v);
  return [...seen].join(sep);
}

export const DEP_VULNS: CapabilityDescriptor<DepVulnResult> = {
  id: 'depVulns',
  aggregate(results) {
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    const findings: DepVulnResult['findings'] = [];
    let enrichment: DepVulnResult['enrichment'] = null;
    for (const r of results) {
      critical += r.counts.critical;
      high += r.counts.high;
      medium += r.counts.medium;
      low += r.counts.low;
      if (r.findings) findings.push(...r.findings);
      if (r.enrichment) enrichment = r.enrichment;
    }
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      enrichment,
      counts: { critical, high, medium, low },
      findings: findings.length > 0 ? findings : undefined,
    };
  },
};

export const LINT: CapabilityDescriptor<LintResult> = {
  id: 'lint',
  aggregate(results) {
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const r of results) {
      critical += r.counts.critical;
      high += r.counts.high;
      medium += r.counts.medium;
      low += r.counts.low;
    }
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      counts: { critical, high, medium, low },
    };
  },
};

export const COVERAGE: CapabilityDescriptor<CoverageResult> = {
  id: 'coverage',
  aggregate(results) {
    // Multiple coverage providers in one repo are uncommon (mono-repos with
    // mixed stacks would hit this). Last-wins is the deterministic-but-lossy
    // choice; a smarter merge needs per-language file weighting and lands
    // with the coverage capability migration in Phase 10e.B.3.
    return results[results.length - 1];
  },
};

export const TEST_FRAMEWORK: CapabilityDescriptor<TestFrameworkResult> = {
  id: 'testFramework',
  aggregate(results) {
    // Last-wins. Mixed-stack repos already resolve this via the language
    // pack's gatherMetrics today; per-pack reporting lands in Phase 10e.B.5.
    return results[results.length - 1];
  },
};

export const IMPORTS: CapabilityDescriptor<ImportsResult> = {
  id: 'imports',
  aggregate(results) {
    // Keys are disjoint between packs (each pack owns its source extensions),
    // so plain-union merge is sound. We still defensively skip later-writer
    // collisions so an accidental overlap would be visible in logs rather
    // than silently dropping edges.
    const extensions = new Set<string>();
    const extracted = new Map<string, ReadonlyArray<string>>();
    const edges = new Map<string, ReadonlySet<string>>();
    for (const r of results) {
      for (const ext of r.sourceExtensions) extensions.add(ext);
      for (const [file, specs] of r.extracted) {
        if (!extracted.has(file)) extracted.set(file, specs);
      }
      for (const [file, targets] of r.edges) {
        if (!edges.has(file)) edges.set(file, targets);
      }
    }
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      sourceExtensions: [...extensions],
      extracted,
      edges,
    };
  },
};

/**
 * Single registry of descriptors keyed by their `LanguagePackCapabilities`
 * slot name. The contract test enforces that every key here matches a slot
 * on the type, and every descriptor.id matches its key — so the type, the
 * descriptor, and the runtime never drift.
 */
export const CAPABILITY_REGISTRY = {
  depVulns: DEP_VULNS,
  lint: LINT,
  coverage: COVERAGE,
  testFramework: TEST_FRAMEWORK,
  imports: IMPORTS,
} as const;

export type CapabilityId = keyof typeof CAPABILITY_REGISTRY;
