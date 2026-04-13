/**
 * Quality analyzer types.
 */

export interface DuplicationStats {
  totalLines: number;
  duplicatedLines: number;
  percentage: number;
  cloneCount: number;
}

export interface QualityMetrics {
  // Lint
  lintErrors: number;
  lintWarnings: number;
  lintTool: string | null;

  // Duplication (jscpd)
  duplication: DuplicationStats | null;

  // Complexity (graphify)
  maxFunctionsInFile: number | null;
  maxFunctionsFilePath: string | null;
  avgCohesion: number | null;
  communityCount: number | null;
  functionCount: number | null;

  // Dead code (graphify)
  deadImportCount: number | null;
  orphanModuleCount: number | null;

  // Hygiene (grep + cloc + find)
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  consoleLogCount: number;
  commentRatio: number | null; // comment lines / total lines (from cloc)
  staleFiles: string[]; // .swp, .bak, .orig, temp files committed to git
  mixedLanguages: boolean; // e.g., .js alongside .ts in same directory

  // Slop score (computed from above)
  slopScore: number; // 0-100, higher = cleaner
}

export interface QualityReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  metrics: QualityMetrics;
  slopScore: number;
  toolsUsed: string[];
  toolsUnavailable: string[];
}
