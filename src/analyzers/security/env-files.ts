/**
 * Committed env-file detection — the ONE place dxkit decides which `.env` files
 * tracked in git count as a secret-leak risk. Both consumers read from here so
 * they can never diverge again:
 *
 *   - the env-in-git METRIC count (`gatherGenericMetrics` → Security score);
 *   - the per-finding PRODUCER (`gatherFileFindings` → the baseline entry).
 *
 * Before consolidation these were two independent `git ls-files .env .env.*`
 * calls, and the 2.29 fix to exempt `.env.example` reached only the count — so
 * the committed `.env.example` still surfaced as a `git/env-in-git` finding.
 * The class of bug: one concept, two code paths, a fix that lands in one.
 *
 * Example / template env files (`.env.example`, `.env.template`, `.env.sample`)
 * are excluded via the shared benign-conventions module; a real `.env` /
 * `.env.production` still counts.
 */

import { run } from '../tools/runner';
import { isExampleEnvFile } from './benign';

/**
 * Repo-relative paths of the `.env` files tracked in git that represent a real
 * secret-leak risk — i.e. every tracked `.env` / `.env.*` MINUS the example /
 * template conventions. `git ls-files` is the single detection command; it must
 * not be re-issued elsewhere (enforced by the architecture gate).
 */
export function trackedEnvFiles(cwd: string): string[] {
  return (run('git ls-files .env .env.*', cwd) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isExampleEnvFile(l));
}
