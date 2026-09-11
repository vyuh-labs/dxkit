/**
 * The GitHub Actions step summary, for lane surfaces: append a markdown
 * block to `$GITHUB_STEP_SUMMARY` when running under Actions, a no-op
 * elsewhere. Best-effort decoration, never a failure. Shared by the
 * remediate task surface (the ledger) and the land step (a blocked
 * landing's disclosure, #375) so both write the same way.
 */
import * as fs from 'fs';

export function appendStepSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, markdown + '\n\n', 'utf8');
  } catch {
    // summary is best-effort decoration, never a failure
  }
}
