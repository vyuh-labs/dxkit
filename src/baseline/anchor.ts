/**
 * Anchor hydration for the `anchor: 'branch'` transport.
 *
 * With that transport the committed baseline is NOT stored in the default
 * branch's working tree — it lives on a separate unprotected branch
 * (`anchorRef`, default `dxkit-baselines`) that the after-merge refresh
 * direct-pushes to (branch protection covers the default branch, not this one).
 * So a committed-mode `guardrail check` — which reads the anchor from
 * `.dxkit/baselines/<name>.json` — finds nothing in the tree. This module reads
 * the anchor back from the side branch and writes it into place, so the normal
 * committed-mode load then proceeds unchanged. It works in CI and locally
 * (`git show origin/<anchorRef>:<path>`).
 *
 * Fail-open throughout: a git error returns `false` and the caller falls back
 * to whatever is (or isn't) on disk. This is a transport detail, never a place
 * to hard-fail a check.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ANCHOR_REF } from './modes';
import type { BaselineSection } from './policy';

function gitShow(cwd: string, ref: string, relPath: string): string {
  return execSync(`git show ${JSON.stringify(`${ref}:${relPath}`)}`, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
}

/**
 * When `section.anchor === 'branch'`, hydrate `baselinePath` from the anchor
 * branch. Returns `true` if the file was written, `false` otherwise (wrong
 * transport, or the branch/file is unreachable).
 */
export function hydrateAnchorFromBranch(
  cwd: string,
  baselinePath: string,
  section: BaselineSection | undefined,
): boolean {
  if (section?.anchor !== 'branch') return false;
  const anchorRef = section.anchorRef ?? DEFAULT_ANCHOR_REF;
  const relPath = path.relative(cwd, baselinePath).split(path.sep).join('/');

  // Best-effort fetch so the `origin/<anchorRef>` mirror exists (no-op in CI
  // where checkout already fetched, or when offline).
  try {
    execSync(`git fetch --depth=1 origin ${JSON.stringify(anchorRef)}`, { cwd, stdio: 'ignore' });
  } catch {
    /* offline / already present — fall through to the reads below */
  }

  for (const ref of [`origin/${anchorRef}`, anchorRef]) {
    try {
      const content = gitShow(cwd, ref, relPath);
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.writeFileSync(baselinePath, content, 'utf8');
      return true;
    } catch {
      /* try the next ref form */
    }
  }
  return false;
}
