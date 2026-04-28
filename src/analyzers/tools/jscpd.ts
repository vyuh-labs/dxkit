/**
 * jscpd integration — duplicate-code detection.
 *
 * The `jscpdProvider` is registered in `GLOBAL_CAPABILITIES.duplication`
 * (src/languages/capabilities/global.ts). jscpd runs once per repo with
 * a cross-language source-file pattern and respects the project's
 * `.gitignore` via the `--gitignore` flag — crucial on large repos,
 * jscpd without it walks into `node_modules` and OOMs.
 *
 * The source-file pattern is the union of every pack's
 * `sourceExtensions` (LP-recipe pattern, Phase 10i.0-LP). jscpd's
 * tokenizer is language-aware so a single union glob is safe; pack-
 * driven derivation keeps adding a new language to a one-line scaffold
 * change rather than a cross-cutting edit here.
 */

import { LANGUAGES } from '../../languages';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { DuplicationClone, DuplicationResult } from '../../languages/capabilities/types';
import { run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';

interface JscpdRawDuplicate {
  lines?: number;
  tokens?: number;
  firstFile?: { name?: string; start?: number; end?: number };
  secondFile?: { name?: string; start?: number; end?: number };
}

interface JscpdReport {
  statistics: {
    total: {
      lines: number;
      duplicatedLines: number;
      percentage: number;
    };
  };
  duplicates: JscpdRawDuplicate[];
}

/**
 * Outcome union mirrors the other global wrappers (gitleaks, semgrep,
 * graphify). Collapses to `DuplicationResult | null` at the provider
 * level; keeping the `unavailable.reason` at this level lets internal
 * callers distinguish install-missing from parse-failure if needed.
 */
export type DuplicationGatherOutcome =
  | { kind: 'success'; envelope: DuplicationResult }
  | { kind: 'unavailable'; reason: string };

/**
 * Union of source extensions across all language packs, derived
 * pack-side. Iterates LANGUAGES fresh on every call so a new pack lands
 * in the glob without an edit here (matches `allSourceExtensions`'s
 * pattern from Phase 10i.0-LP.3). A union pattern (rather than per-pack
 * invocation) so mixed-stack repos pay for one jscpd run, not N.
 *
 * Note: returns a function so the registry mutation in
 * `test/recipe-playbook.test.ts` (which appends a synthetic pack to
 * LANGUAGES) takes effect — module-load capture would freeze the union
 * before the test injection.
 */
function buildJscpdPattern(): string {
  const exts = new Set<string>();
  for (const lang of LANGUAGES) {
    for (const e of lang.sourceExtensions) {
      exts.add(e.replace(/^\./, ''));
    }
  }
  return `**/*.{${[...exts].sort().join(',')}}`;
}

/** Extract the top N clone pairs sorted largest-first. */
function topClonesFrom(duplicates: JscpdRawDuplicate[], limit = 15): DuplicationClone[] {
  return duplicates
    .filter((d) => d.firstFile?.name && d.secondFile?.name && d.lines)
    .map((d) => ({
      lines: d.lines || 0,
      tokens: d.tokens || 0,
      a: {
        file: d.firstFile!.name!,
        startLine: d.firstFile!.start || 0,
        endLine: d.firstFile!.end || 0,
      },
      b: {
        file: d.secondFile!.name!,
        startLine: d.secondFile!.start || 0,
        endLine: d.secondFile!.end || 0,
      },
    }))
    .sort((x, y) => y.lines - x.lines)
    .slice(0, limit);
}

/**
 * Single source of truth for the jscpd invocation. Consumed by
 * `jscpdProvider` (capability dispatcher).
 */
export function gatherJscpdResult(cwd: string): DuplicationGatherOutcome {
  const status = findTool(TOOL_DEFS.jscpd, cwd);
  if (!status.available || !status.path) return { kind: 'unavailable', reason: 'not installed' };

  const reportDir = `/tmp/dxkit-jscpd-${Date.now()}`;
  const pattern = buildJscpdPattern();
  run(
    `${status.path} --reporters json --output '${reportDir}' --gitignore --pattern '${pattern}' --min-lines 5 --min-tokens 50 '${cwd}' > /dev/null 2>&1`,
    cwd,
    300000,
  );

  const reportRaw = run(`cat '${reportDir}/jscpd-report.json' 2>/dev/null`, cwd);
  run(`rm -rf '${reportDir}'`, cwd);

  if (!reportRaw) return { kind: 'unavailable', reason: 'no output' };

  let data: JscpdReport;
  try {
    data = JSON.parse(reportRaw) as JscpdReport;
  } catch {
    return { kind: 'unavailable', reason: 'parse error' };
  }

  const t = data.statistics?.total;
  if (!t) return { kind: 'unavailable', reason: 'no total stats' };

  const duplicates = data.duplicates || [];
  const envelope: DuplicationResult = {
    schemaVersion: 1,
    tool: 'jscpd',
    totalLines: t.lines,
    duplicatedLines: t.duplicatedLines,
    percentage: Math.round(t.percentage * 100) / 100,
    cloneCount: duplicates.length,
    topClones: topClonesFrom(duplicates),
  };
  return { kind: 'success', envelope };
}

/**
 * Capability-shaped provider. Registered in
 * `src/languages/capabilities/global.ts:GLOBAL_CAPABILITIES.duplication`.
 */
export const jscpdProvider: CapabilityProvider<DuplicationResult> = {
  source: 'jscpd',
  async gather(cwd) {
    const outcome = gatherJscpdResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};
