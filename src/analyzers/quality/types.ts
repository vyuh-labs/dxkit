/**
 * Quality analyzer types.
 */
import { Evidence } from '../evidence';

/** One side of a jscpd duplicate pair. */
export interface CloneSide {
  file: string;
  startLine: number;
  endLine: number;
}

/** A single duplicate block reported by jscpd. */
export interface CloneGroup {
  lines: number;
  tokens: number;
  a: CloneSide;
  b: CloneSide;
}

/** File-level hygiene offender (console.log / TODO / etc count per file). */
export interface FileOffender {
  file: string;
  count: number;
}

export interface DuplicationStats {
  totalLines: number;
  duplicatedLines: number;
  percentage: number;
  cloneCount: number;
  /** Top duplicate pairs, sorted by size descending. Populated on --detailed runs. */
  topClones?: CloneGroup[];
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

  // Top offenders for detailed reports (empty on summary-only runs)
  topConsoleFiles?: FileOffender[];
  topTodoFiles?: FileOffender[];
  topGodFiles?: FileOffender[]; // populated when graphify emits per-file data
  hygieneEvidence?: Evidence[]; // optional per-finding evidence (stale files etc.)
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
