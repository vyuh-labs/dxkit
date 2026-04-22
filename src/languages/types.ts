import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnResult,
  ImportsResult,
  LicensesResult,
  LintResult,
  TestFrameworkResult,
} from './capabilities/types';

export type LanguageId = 'typescript' | 'python' | 'go' | 'rust' | 'csharp';

export type LintSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Capability providers a language pack may expose. Every data-producing
 * surface lives here after Phase 10e.C.5 — the legacy `gatherMetrics`
 * channel is gone, and the capability dispatcher is the only route from
 * a language pack to the analyzer layer. Each provider is optional so a
 * pack can ship incrementally as underlying tool support lands.
 */
export interface LanguagePackCapabilities {
  depVulns?: CapabilityProvider<DepVulnResult>;
  lint?: CapabilityProvider<LintResult>;
  coverage?: CapabilityProvider<CoverageResult>;
  testFramework?: CapabilityProvider<TestFrameworkResult>;
  imports?: CapabilityProvider<ImportsResult>;
  licenses?: CapabilityProvider<LicensesResult>;
}

/**
 * Everything dxkit needs to know about a language lives in one implementation
 * of this interface. See `src/languages/index.ts` for the registry.
 *
 * Optional methods mean "feature not supported yet" — dispatchers should
 * tolerate their absence.
 */
export interface LanguageSupport {
  id: LanguageId;
  displayName: string;

  sourceExtensions: string[];
  testFilePatterns: string[];
  extraExcludes?: string[];

  detect(cwd: string): boolean;

  tools: string[];
  semgrepRulesets: string[];

  mapLintSeverity?(code: string): LintSeverity;

  /** Capability providers for the dispatcher channel. */
  capabilities?: LanguagePackCapabilities;
}
