/**
 * The ONE proof that a commit is the lane's OWN bookkeeping (Rule 2.30):
 * exactly one commit atop an expected head, touching only declared paths.
 * Two consumers hold this question in different shapes and both route
 * here: the deferred land step's retry (did a failed push leave HEAD one
 * ledger commit past the recorded head?) and the pending-ref re-land
 * (is the ref's tip the record commit the task step built over the
 * verified head, and nothing else?). Moved verbatim out of `land-cli.ts`
 * when the second consumer arrived (#375).
 */
import { execFileSync } from 'child_process';

const HEX_SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Is `observed` exactly ONE commit atop `expected`, touching ONLY the
 * lander's own bookkeeping paths (the delivery + order ledgers)? Pure git
 * reads, biased toward false: any doubt (unreadable parent, a merge, an
 * empty or out-of-scope diff) answers no, and the retry then refuses as
 * stale, which is the honest outcome for a head this step cannot prove it
 * authored itself.
 */
export function isOwnBookkeepingCommit(
  cwd: string,
  observed: string,
  expected: string,
  allowedPaths: readonly string[],
): boolean {
  if (allowedPaths.length === 0) return false;
  if (!HEX_SHA_RE.test(observed) || !HEX_SHA_RE.test(expected)) return false;
  const read = (args: readonly string[]): string =>
    execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    if (read(['rev-parse', `${observed}^`]) !== read(['rev-parse', expected])) return false;
    const files = read(['diff-tree', '--no-commit-id', '--name-only', '-r', observed])
      .split('\n')
      .filter(Boolean);
    return files.length > 0 && files.every((f) => allowedPaths.includes(f));
  } catch {
    return false;
  }
}
