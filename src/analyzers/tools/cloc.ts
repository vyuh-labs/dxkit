/**
 * cloc integration -- exact line counts per language.
 * Layer 2 (optional): available via `npx cloc` or system install.
 */
import { HealthMetrics } from '../types';
import { runJSON } from './runner';
import { getClocExcludeDirs } from './exclusions';

interface ClocOutput {
  header: { n_files: number; n_lines: number };
  SUM: { blank: number; comment: number; code: number; nFiles: number };
  [language: string]: { nFiles: number; blank: number; comment: number; code: number } | unknown;
}

const SKIP_KEYS = new Set(['header', 'SUM']);

/** Gather metrics from cloc --json. */
export function gatherClocMetrics(cwd: string): Partial<HealthMetrics> {
  // --timeout 0 disables per-file timeout (suppresses warning that breaks JSON parse)
  // cloc uses basename matching for --exclude-dir, so use dir names without slashes
  const excludeDirs = getClocExcludeDirs(cwd);
  const flags = `--json --timeout 0 --exclude-dir=${excludeDirs}`;

  // Try system cloc first (faster), then npx as fallback
  const result = runJSON<ClocOutput>(`cloc . ${flags} 2>/dev/null`, cwd, 180000);

  if (!result || !result.SUM) {
    const fallback = runJSON<ClocOutput>(`npx cloc . ${flags} 2>/dev/null`, cwd, 180000);
    if (!fallback || !fallback.SUM) {
      return { toolsUnavailable: ['cloc'] };
    }
    return parseClocResult(fallback);
  }

  return parseClocResult(result);
}

function parseClocResult(result: ClocOutput): Partial<HealthMetrics> {
  const clocLanguages: HealthMetrics['clocLanguages'] = [];

  for (const [key, value] of Object.entries(result)) {
    if (SKIP_KEYS.has(key)) continue;
    const lang = value as { nFiles: number; blank: number; comment: number; code: number };
    if (typeof lang.nFiles !== 'number') continue;
    clocLanguages.push({
      language: key,
      files: lang.nFiles,
      code: lang.code,
      comment: lang.comment,
      blank: lang.blank,
    });
  }

  // Sort by code lines descending
  clocLanguages.sort((a, b) => b.code - a.code);

  return {
    sourceFiles: result.SUM.nFiles,
    totalLines: result.SUM.code + result.SUM.comment + result.SUM.blank,
    clocLanguages,
    toolsUsed: ['cloc'],
  };
}
