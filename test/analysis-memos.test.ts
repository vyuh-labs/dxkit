/**
 * The fresh-analysis memo reset (`resetAnalysisMemos`).
 *
 * The walk/exclusion/gitleaks/dispatcher memos are process-lifetime and
 * keyed by cwd, which is correct WITHIN one analysis and wrong across
 * two: a process that scans the same cwd twice with the tree changed in
 * between must not read the first scan's snapshot (the latent class: a
 * baseline create followed by a current scan in one process saw an
 * empty tree — no source, no secrets, no test-gap). The root fix scopes
 * the memos to one analysis by resetting them at the ONE entry seam
 * (`gatherAnalysisResultBody`); this test pins the reset itself, and
 * `test/baseline/attribution-gap.test.ts` (which re-scans a changed cwd
 * in-process with NO ad-hoc clears) pins that the seam actually runs it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { resetAnalysisMemos } from '../src/analyzers/analysis-memos';
import { walkSourceFiles } from '../src/analyzers/tools/walk-source-files';
import { walkPaths } from '../src/analyzers/tools/walk-paths';

describe('resetAnalysisMemos', () => {
  it('a changed tree is re-walked after reset (and NOT before — the memo is real)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-memos-'));
    try {
      execSync('git init -q', { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;\n');

      // Warm BOTH memos on the 1-file tree.
      expect(walkSourceFiles(tmp, { extensions: ['.ts'] })).toHaveLength(1);
      expect(walkPaths(tmp, { extensions: ['.ts'] })).toHaveLength(1);

      fs.writeFileSync(path.join(tmp, 'b.ts'), 'export const b = 2;\n');

      // Without a reset the memo replays the stale walk — this assertion is
      // what makes the reset non-optional (if the cache disappeared, the
      // reset would be dead code and this would fail).
      expect(walkSourceFiles(tmp, { extensions: ['.ts'] })).toHaveLength(1);
      expect(walkPaths(tmp, { extensions: ['.ts'] })).toHaveLength(1);

      resetAnalysisMemos();

      expect(walkSourceFiles(tmp, { extensions: ['.ts'] })).toHaveLength(2);
      expect(walkPaths(tmp, { extensions: ['.ts'] })).toHaveLength(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
