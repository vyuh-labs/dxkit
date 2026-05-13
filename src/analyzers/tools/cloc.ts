/**
 * cloc integration -- exact line counts per language.
 * Layer 2 (optional): available via `npx cloc` or system install.
 */
import { HealthMetrics } from '../types';
import { runJSON } from './runner';
import { getClocExcludeFlags } from './exclusions';

interface ClocOutput {
  header: { n_files: number; n_lines: number };
  SUM: { blank: number; comment: number; code: number; nFiles: number };
  [language: string]: { nFiles: number; blank: number; comment: number; code: number } | unknown;
}

const SKIP_KEYS = new Set(['header', 'SUM']);

/** Gather metrics from cloc --json. */
export function gatherClocMetrics(cwd: string): Partial<HealthMetrics> {
  // --timeout 0 disables per-file timeout (suppresses warning that breaks JSON parse)
  // D055 (2.4.7): getClocExcludeFlags emits BOTH `--exclude-dir` (basenames)
  // AND `--fullpath --not-match-d` (Perl regex on full path) so multi-segment
  // `.dxkit-ignore` entries like `Dev/Addons/DPLAddon/SAPB1/` exclude the
  // correct subtree instead of every dir named `Dev`.
  const excludeFlags = getClocExcludeFlags(cwd);
  const flags = `--json --timeout 0 ${excludeFlags}`;

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

  // D057 (2.4.7): cloc no longer writes `sourceFiles`. Pre-fix the
  // mergeLayer2 overlay blindly overwrote generic's find-based count
  // with cloc's, which (a) included markup/data files (JSON/XML/CSV)
  // that aren't source, and (b) on dpl-studio was broken by D055.
  // Field ownership: generic.ts owns sourceFiles; cloc owns line
  // counts + language breakdown. (Class-fix tracked as G_v4_8 in
  // recipe v4 — "each gather declares which fields it owns; merger
  // errors on overlap".)
  // totalLines stays cloc-authoritative because the find-based
  // wc pass in generic.ts can timeout on enormous trees; cloc is
  // the higher-fidelity source when available.
  return {
    totalLines: result.SUM.code + result.SUM.comment + result.SUM.blank,
    clocLanguages,
    toolsUsed: ['cloc'],
  };
}
