/**
 * The ONE "a fresh analysis is starting" reset for process-lifetime,
 * per-cwd memo caches.
 *
 * `walkSourceFiles`, `walkPaths`, `exclusions`, the gitleaks-outcome
 * cache, and the capability dispatcher all memoize per cwd for the
 * lifetime of the process, to dedupe work WITHIN one analysis. Their
 * clear seams existed but were called nowhere in `src/` — so when one
 * process scanned the SAME cwd twice with the tree changed in between
 * (a baseline create followed by a current scan in one process), the
 * second scan reused the first's stale walk and read an EMPTY tree: no
 * source, so no secrets, no test-gap, nothing. Latent in the CLI (each
 * command is its own process) but live in integration tests and any
 * future daemon / watch / in-process re-scan.
 *
 * The root fix is scoping, not more call sites: every analysis entry
 * point funnels through `gatherAnalysisResultBody`, which calls this
 * ONCE at the top — dedup still works within a build, a changed tree
 * re-walks across builds, and no caller has to remember to clear.
 * (Concurrent builds of different cwds clearing each other's memos
 * would only cost a redundant re-walk, never a wrong result — and all
 * multi-cwd flows today are sequential awaits.)
 */
import { clearWalkCache } from './tools/walk-source-files';
import { clearWalkPathsCache } from './tools/walk-paths';
import { clearExclusionsCache } from './tools/exclusions';
import { clearGitleaksOutcomeCache } from './tools/gitleaks';
import { defaultDispatcher } from './dispatcher';

/** Reset every process-lifetime analysis memo. Called at the start of
 *  each fresh analysis build; safe (only costs a re-walk) anywhere else. */
export function resetAnalysisMemos(): void {
  clearWalkCache();
  clearWalkPathsCache();
  clearExclusionsCache();
  clearGitleaksOutcomeCache();
  defaultDispatcher.clearCache();
}
