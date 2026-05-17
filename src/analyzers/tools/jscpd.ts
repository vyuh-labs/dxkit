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

import * as fs from 'fs';
import * as path from 'path';
import { LANGUAGES, allAutogenSourcePatterns } from '../../languages';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { DuplicationClone, DuplicationResult } from '../../languages/capabilities/types';
import { getJscpdIgnorePatterns } from './exclusions';
import { runDetached } from './runner';
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
 *
 * Failure-mode honesty: when jscpd doesn't produce a parseable
 * report, the returned `reason` distinguishes timeout, non-zero
 * exit (with first stderr line), or the rare true "no output"
 * case. Same shape as the semgrep gather — switched from execSync
 * to spawn-with-process-group so jscpd's worker pool (it splits
 * the scan across multiple Node workers internally) isn't killed
 * mid-run when execSync's wall-clock timer fires.
 */
export async function gatherJscpdResult(cwd: string): Promise<DuplicationGatherOutcome> {
  const status = findTool(TOOL_DEFS.jscpd, cwd);
  if (!status.available || !status.path) return { kind: 'unavailable', reason: 'not installed' };

  const reportDir = `/tmp/dxkit-jscpd-${Date.now()}`;
  const pattern = buildJscpdPattern();
  // jscpd's `--ignore` receives the union of:
  //
  //   1. dxkit's centralized exclusion set (`getJscpdIgnorePatterns`) —
  //      the same dirs / sourcePaths / filePatterns the in-process
  //      walkers (cloc, grep, semgrep, graphify's Python filter)
  //      honor. Without this, committed-vendored trees that aren't
  //      listed in the project's `.gitignore` (the `--gitignore` flag's
  //      only input) — minified bundles, hash-versioned webpack
  //      chunks, vendored library copies under `public/` — would
  //      force jscpd to tokenize them, exhaust heap, and OOM-kill
  //      before flushing its JSON report. The report would then read
  //      "Duplication unavailable" on the densest repos.
  //
  //   2. Pack-declared autogen patterns (`*.Designer.cs`, WCF
  //      `Reference.cs`, MSBuild `*.AssemblyInfo.cs`, etc.) so
  //      duplication detection skips the same files generic.ts +
  //      test-gaps' source walk already skip. Autogen scaffolding
  //      duplicates verbatim by its nature; including it inflates
  //      the duplication percentage and points "extract this" advice
  //      at code the developer never authored.
  //
  // Patterns get a `**/` prefix so they match at any directory depth.
  const exclusionIgnore = getJscpdIgnorePatterns(cwd);
  const autogenIgnore = allAutogenSourcePatterns().map((p) => `**/${p}`);
  const ignorePatterns = [...exclusionIgnore, ...autogenIgnore];
  const args = ['--reporters', 'json', '--output', reportDir, '--gitignore', '--pattern', pattern];
  if (ignorePatterns.length > 0) {
    args.push('--ignore', ignorePatterns.join(','));
  }
  args.push('--min-lines', '5', '--min-tokens', '50', cwd);

  const outcome = await runDetached(status.path, args, { cwd, timeoutMs: 600000 });

  // Read the report file directly. Pre-D-fix this used
  // `run('cat <path>')` which routed through execSync with the default
  // 1MB maxBuffer — jscpd reports on enterprise codebases routinely
  // exceed that (dpl-studio's was 25MB / 395k lines), causing execSync
  // to truncate the output to empty and the gather to misreport
  // jscpd as "unavailable" even after a fully-successful run.
  // Direct file read sidesteps the buffer entirely.
  const reportPath = path.join(reportDir, 'jscpd-report.json');
  let reportRaw: string;
  try {
    reportRaw = fs.readFileSync(reportPath, 'utf-8');
  } catch {
    reportRaw = '';
  }
  try {
    fs.rmSync(reportDir, { recursive: true, force: true });
  } catch {
    /* dir already gone or never written — fine */
  }

  if (!reportRaw) {
    if (outcome.timedOut) {
      return {
        kind: 'unavailable',
        reason: 'timed out at 600s (try narrowing scan scope via .dxkit-ignore)',
      };
    }
    const stderrFirstLine = outcome.stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (outcome.code !== 0 && outcome.code !== null) {
      const ctx = stderrFirstLine ? ` (stderr: ${stderrFirstLine})` : '';
      return { kind: 'unavailable', reason: `exit code ${outcome.code}${ctx}` };
    }
    if (stderrFirstLine) {
      return { kind: 'unavailable', reason: `no output (stderr: ${stderrFirstLine})` };
    }
    return { kind: 'unavailable', reason: 'no output' };
  }

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
// Implements the optional `gatherOutcome` channel the dispatcher reads
// to populate `DispatchOutcome.skipReasons`. Without it, a failed jscpd
// run collapses to `null` at the gather boundary and the actual failure
// reason ("not installed" / "timed out at 600s" / "exit code 137" /
// "no output" / "parse error") is dropped — `availabilityFromOutcome`
// in health.ts then synthesizes generic prose that conflates
// install-missing with attempted-but-failed. Exposing the real outcome
// here lets the report show why jscpd didn't contribute, in jscpd's
// own words.
export const jscpdProvider: CapabilityProvider<DuplicationResult> & {
  gatherOutcome(cwd: string): Promise<DuplicationGatherOutcome>;
} = {
  source: 'jscpd',
  async gather(cwd) {
    const outcome = await gatherJscpdResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherJscpdResult(cwd);
  },
};
