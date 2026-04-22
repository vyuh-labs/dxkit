/**
 * jscpd integration — duplicate-code detection.
 *
 * The `jscpdProvider` is registered in `GLOBAL_CAPABILITIES.duplication`
 * (src/languages/capabilities/global.ts). jscpd runs once per repo with
 * a fixed source-file pattern and respects the project's `.gitignore`
 * via the `--gitignore` flag — crucial on large repos, jscpd without
 * it walks into `node_modules` and OOMs.
 *
 * The source-file pattern is cross-language (all five packs' extensions
 * in one glob). jscpd's tokenizer is language-aware so this is safe;
 * keeping the pattern declared here rather than per-pack avoids five
 * separate jscpd invocations on mixed-stack repos.
 */

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
 * Union of source extensions across all language packs. A union pattern
 * rather than per-pack invocation so mixed-stack repos (Node + Python)
 * pay for one jscpd run, not N. Adding a language's extensions here is
 * the one cross-cutting edit needed when registering a new pack.
 */
const JSCPD_PATTERN = '**/*.{ts,tsx,js,jsx,py,go,rs,cs}';

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
  run(
    `${status.path} --reporters json --output '${reportDir}' --gitignore --pattern '${JSCPD_PATTERN}' --min-lines 5 --min-tokens 50 '${cwd}' > /dev/null 2>&1`,
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
