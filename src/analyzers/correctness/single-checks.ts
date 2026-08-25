/**
 * Single-check entry points for the recipe tier (4.4.5). A pack's floor
 * builders may only be invoked inside `src/analyzers/correctness/` (the
 * arch-check's correctness-floor rule), so a recipe that needs ONE check's
 * verdict ("is the lockfile in sync now?", "does the specifier resolve
 * now?") asks through these helpers instead of paying a whole
 * `runCorrectnessFloor` pass or re-implementing the builders' policy.
 *
 * Both reuse the exact executors the floor runner uses (`runLockfileCheck`,
 * `runResolutionCheck`), so a recipe's verify and the floor's verdict can
 * never diverge (Rule 2.30: one concept, one code path). `null` means the
 * pack declares no such check, or declined for this repo (no lockfile);
 * the CALLER decides what an unverifiable state means (the recipes refuse:
 * they never claim what they cannot confirm).
 */
import { getLanguage } from '../../languages';
import type { LanguageId } from '../../languages/types';
import type { CommandExec } from '../tools/bounded-exec';
import { runLockfileCheck } from './lockfile-check';
import { runResolutionCheck } from './pure-checks';
import type { CorrectnessCheckResult } from './run';

const FULL_CTX = { changedFiles: [] as const, scope: 'full' as const };

/** Run ONE pack's lockfile-sync check (the frozen dry-run) for `cwd`. */
export function runSingleLockfileCheck(
  cwd: string,
  packId: string,
  exec: CommandExec,
): CorrectnessCheckResult | null {
  const provider = getLanguage(packId as LanguageId)?.correctness;
  if (!provider?.lockfileCheck) return null;
  return runLockfileCheck(packId as LanguageId, provider, { cwd, ...FULL_CTX }, exec);
}

/** Run ONE pack's import-resolution check for `cwd` (pure computation). */
export function runSingleResolutionCheck(
  cwd: string,
  packId: string,
): CorrectnessCheckResult | null {
  const provider = getLanguage(packId as LanguageId)?.correctness;
  if (!provider?.resolutionCheck) return null;
  return runResolutionCheck(packId as LanguageId, provider, { cwd, ...FULL_CTX });
}
