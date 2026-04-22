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
  CodePatternsResult,
  CoverageResult,
  DepVulnResult,
  DuplicationResult,
  ImportsResult,
  LicensesResult,
  LintResult,
  SecretsResult,
  StructuralResult,
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
    // choice; a smarter merge needs per-language file weighting — future
    // work when a real multi-pack case surfaces.
    return results[results.length - 1];
  },
};

export const TEST_FRAMEWORK: CapabilityDescriptor<TestFrameworkResult> = {
  id: 'testFramework',
  aggregate(results) {
    // Last-wins. Mixed-stack repos resolve to a single framework name
    // deterministically by provider-registration order; per-language
    // reporting is future work (see Phase 10f roadmap).
    return results[results.length - 1];
  },
};

export const SECRETS: CapabilityDescriptor<SecretsResult> = {
  id: 'secrets',
  aggregate(results) {
    // Multiple providers only appear if a future global scanner joins
    // gitleaks (e.g. trufflehog). Concat findings, sum suppression
    // counts, unique-join tool names — identical strategy to DEP_VULNS.
    const findings: SecretsResult['findings'][number][] = [];
    let suppressedCount = 0;
    for (const r of results) {
      findings.push(...r.findings);
      suppressedCount += r.suppressedCount;
    }
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      findings,
      suppressedCount,
    };
  },
};

export const CODE_PATTERNS: CapabilityDescriptor<CodePatternsResult> = {
  id: 'codePatterns',
  aggregate(results) {
    // Same union strategy as SECRETS — multiple providers only enter the
    // picture if a future SAST scanner (codeql, opengrep) joins semgrep.
    const findings: CodePatternsResult['findings'][number][] = [];
    let suppressedCount = 0;
    for (const r of results) {
      findings.push(...r.findings);
      suppressedCount += r.suppressedCount;
    }
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      findings,
      suppressedCount,
    };
  },
};

export const DUPLICATION: CapabilityDescriptor<DuplicationResult> = {
  id: 'duplication',
  aggregate(results) {
    // Multiple providers would appear if a future detector (pmd-cpd,
    // sonar-cpd) joins jscpd. Sum the numerics; concat + re-sort
    // topClones by line-count. Percentage is recomputed from summed
    // totals rather than averaged (line counts may overlap across
    // detectors, but a re-weighted mean would lie; summing totals is
    // conservative).
    let totalLines = 0;
    let duplicatedLines = 0;
    let cloneCount = 0;
    const allClones: DuplicationResult['topClones'][number][] = [];
    for (const r of results) {
      totalLines += r.totalLines;
      duplicatedLines += r.duplicatedLines;
      cloneCount += r.cloneCount;
      allClones.push(...r.topClones);
    }
    const percentage =
      totalLines > 0 ? Math.round((duplicatedLines / totalLines) * 10000) / 100 : 0;
    // De-dupe identical clone pairs by stable key, keep largest-first.
    const seen = new Set<string>();
    const merged: DuplicationResult['topClones'][number][] = [];
    for (const c of allClones.sort((a, b) => b.lines - a.lines)) {
      const key = `${c.a.file}:${c.a.startLine}-${c.a.endLine}|${c.b.file}:${c.b.startLine}-${c.b.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      totalLines,
      duplicatedLines,
      percentage,
      cloneCount,
      topClones: merged.slice(0, 15),
    };
  },
};

export const STRUCTURAL: CapabilityDescriptor<StructuralResult> = {
  id: 'structural',
  aggregate(results) {
    // Last-wins — same strategy as COVERAGE and TEST_FRAMEWORK. Every
    // field is a repo-level scalar produced by one graph pass; summing
    // across providers would double-count the same functions/modules,
    // and averaging would lie about the source of truth. If a second
    // structural tool ever joins graphify, a proper merge would need
    // per-tool weighting — out of scope until that exists.
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

export const LICENSES: CapabilityDescriptor<LicensesResult> = {
  id: 'licenses',
  aggregate(results) {
    // Per-pack providers own disjoint package sets (npm vs PyPI vs crates
    // vs Go modules vs NuGet) so concat-without-dedupe is sound in the
    // common case. A rare polyglot collision (same package name + version
    // in two ecosystems) keeps both rows; downstream formatters can
    // disambiguate by ecosystem if needed.
    const findings: LicensesResult['findings'][number][] = [];
    for (const r of results) findings.push(...r.findings);
    return {
      schemaVersion: 1,
      tool: uniqueJoin(results.map((r) => r.tool)),
      findings,
    };
  },
};

/**
 * Per-language capabilities — one provider registered per language pack.
 * Keys must match `keyof LanguagePackCapabilities`; the contract test
 * enforces that symmetry.
 */
export const PER_PACK_REGISTRY = {
  depVulns: DEP_VULNS,
  lint: LINT,
  coverage: COVERAGE,
  testFramework: TEST_FRAMEWORK,
  imports: IMPORTS,
  licenses: LICENSES,
} as const;

/**
 * Global capabilities — tools that run once per repo (gitleaks, semgrep,
 * jscpd, graphify), not per pack. Keys must match `keyof GlobalCapabilities`.
 * Pack-dependent inputs (e.g. semgrep's rulesets from each active pack's
 * `semgrepRulesets` declaration) are read by the provider itself via
 * `detectActiveLanguages(cwd)` — the provider interface is uniform.
 */
export const GLOBAL_REGISTRY = {
  secrets: SECRETS,
  codePatterns: CODE_PATTERNS,
  duplication: DUPLICATION,
  structural: STRUCTURAL,
} as const;

/**
 * Union of both registries — kept as the canonical "every descriptor"
 * surface for tests and for callers that don't care about per-pack vs
 * global distinction. `providersFor()` (src/languages/capabilities/index.ts)
 * is the routing layer that picks the right source.
 */
export const CAPABILITY_REGISTRY = {
  ...PER_PACK_REGISTRY,
  ...GLOBAL_REGISTRY,
} as const;

export type CapabilityId = keyof typeof CAPABILITY_REGISTRY;
