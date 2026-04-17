import type { Coverage } from '../analyzers/tools/coverage';
import type { HealthMetrics } from '../analyzers/types';

export type LanguageId = 'typescript' | 'python' | 'go' | 'rust' | 'csharp';

export type LintSeverity = 'critical' | 'high' | 'medium' | 'low';

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
  gatherMetrics?(cwd: string): Promise<Partial<HealthMetrics>>;
  mapLintSeverity?(code: string): LintSeverity;
}
