/**
 * `vyuh-dxkit learn` — the self-contained capability + repo-status page
 * (issue #244). Zero-context first: in an empty directory this renders the
 * full education surface from the compiled-in bundle; in a repo it ADDS the
 * live status + read-only setup panel. `--serve` (the assistant) builds on
 * top of this module in the next increment.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildLearnBundle } from './bundle';
import { gatherLearnRepoStatus } from './repo-status';
import { renderLearnHtml } from './render';

export interface LearnRunResult {
  outputPath: string;
  /** Did the page include a repo-status section? */
  repoMode: boolean;
}

export async function runLearn(cwd: string, opts: { out?: string } = {}): Promise<LearnRunResult> {
  const bundle = buildLearnBundle();
  const status = await gatherLearnRepoStatus(cwd);
  const html = renderLearnHtml(bundle, status, { generatedAt: new Date().toISOString() });

  // Repo mode drops the page next to the other reports; zero-context mode
  // (an empty dir) writes into cwd — there is no .dxkit to nest under.
  const outputPath = opts.out
    ? path.resolve(opts.out)
    : status
      ? path.join(cwd, '.dxkit', 'reports', 'learn.html')
      : path.join(cwd, 'dxkit-learn.html');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html);
  return { outputPath, repoMode: status !== null };
}
