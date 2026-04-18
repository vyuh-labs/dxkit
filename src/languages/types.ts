import type { Coverage } from '../analyzers/tools/coverage';
import type { HealthMetrics } from '../analyzers/types';

export type LanguageId = 'typescript' | 'python' | 'go' | 'rust' | 'csharp';

export type LintSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * The narrow subset of HealthMetrics fields a language pack is allowed to
 * produce. Every current pack only touches these — widening this type
 * without updating the contract test means new fields slip through review.
 *
 * Keep in sync with `mergeMetrics` aggregation rules in `src/analyzers/
 * health.ts`: fields in AGGREGATED_VULN_FIELDS are summed across packs,
 * depAuditTool is joined, array fields (toolsUsed, toolsUnavailable) are
 * appended, all others are last-wins.
 */
export type LangMetrics = Pick<
  HealthMetrics,
  | 'lintErrors'
  | 'lintWarnings'
  | 'lintTool'
  | 'depVulnCritical'
  | 'depVulnHigh'
  | 'depVulnMedium'
  | 'depVulnLow'
  | 'depAuditTool'
  | 'testFramework'
  | 'toolsUsed'
  | 'toolsUnavailable'
  | 'npmScriptsCount'
  | 'nodeEngineVersion'
>;

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

  parseCoverage?(cwd: string): Coverage | null;
  extractImports?(content: string): string[];
  resolveImport?(from: string, spec: string, cwd: string): string | null;
  gatherMetrics?(cwd: string): Promise<Partial<LangMetrics>>;
  mapLintSeverity?(code: string): LintSeverity;
}
