/**
 * `vyuh-dxkit baseline refresh` — the degraded-capture refusal (4.4.8, #388).
 *
 * A capture in which a kind the prior recorded drops out while the scanner did
 * not observe it, on a tree whose diff touched none of that kind's inputs, is a
 * degraded scan, not a fixed repo. The lane refuses to publish it: the prior
 * stays, the tree copy is restored, the run is red with the kind, the counts,
 * what the provenance said and the remedy. The pure decision is unit-tested in
 * `refresh-degraded.test.ts`; this file drives the lane on a real repo.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { runBaselineRefresh } from '../../src/baseline/refresh';
import {
  DEP_SOURCE_UNAVAILABLE,
  baselineFile,
  captureWriting,
  commitChange,
  depVuln,
  depVulnsUnavailable,
  git,
  makeRepoWithOrigin,
  manyDepVulns,
  observedAll,
  readTreeBaseline,
  registerRefreshTmpCleanup,
  writeTreeBaseline,
} from './refresh-harness';

registerRefreshTmpCleanup();

describe('baseline refresh — the degraded-capture refusal', () => {
  it('prior 13 dep-vulns, fresh 0, no manifest change, source unavailable: REFUSED, prior retained', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    const treePath = writeTreeBaseline(repo, baselineFile(repo, priorSha, manyDepVulns(13, 'deg')));
    const treeBefore = fs.readFileSync(treePath, 'utf8');
    commitChange(repo, 'src.js', 'const a = 6;\n');
    const run = () =>
      runBaselineRefresh({ cwd: repo, _capture: captureWriting(repo, [], depVulnsUnavailable) });
    await expect(run()).rejects.toThrow(
      /refusing to refresh: the fresh capture did not observe 1 kind the prior baseline recorded/,
    );
    await expect(run()).rejects.toThrow(
      /dep-vuln 13 -> 0 \(not observed this run \(the dependency scanner could not run\)\)/,
    );
    await expect(run()).rejects.toThrow(/tools list[\s\S]*tools install/);
    // The prior is retained: the tree copy is byte-identical to what the
    // capture overwrote, so the workflow's publish step (which never runs on
    // a red refresh) could not push a degraded anchor either way.
    expect(fs.readFileSync(treePath, 'utf8')).toBe(treeBefore);
  }, 120_000);

  it('negative control: the same drop with a manifest change PUBLISHES, disclosed', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(repo, baselineFile(repo, priorSha, manyDepVulns(13, 'neg')));
    commitChange(repo, 'package.json', JSON.stringify({ name: 'fx', version: '3' }));
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [], depVulnsUnavailable),
    });
    expect(result.note).toContain('dependency manifest changed');
    expect(readTreeBaseline(repo).findings).toEqual([]);
    expect(result.disclosures).toHaveLength(1);
    expect(result.disclosures[0]).toContain('dep-vuln: 13 -> 0 published as a full clear');
    expect(result.disclosures[0]).toContain('touched a dependency manifest');
    expect(result.disclosures[0]).toContain(DEP_SOURCE_UNAVAILABLE);
  }, 120_000);

  it('prior 13, fresh 0, the scanner ran and observed: PUBLISHES as a disclosed full clear', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(repo, baselineFile(repo, priorSha, manyDepVulns(13, 'clr')));
    commitChange(repo, 'src.js', 'const a = 7;\n');
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [], observedAll),
    });
    expect(result.note).toContain('no newly published advisories');
    expect(readTreeBaseline(repo).findings).toEqual([]);
    expect(result.disclosures).toEqual([
      expect.stringContaining(
        'dep-vuln: 13 -> 0 published as a full clear (the fresh capture observed the kind and found none',
      ),
    ]);
  }, 120_000);

  it('a kind the prior recorded that the fresh source could not observe is refused even with findings', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    const prior = manyDepVulns(2, 'prt');
    writeTreeBaseline(repo, baselineFile(repo, priorSha, prior));
    commitChange(repo, 'src.js', 'const a = 8;\n');
    await expect(
      runBaselineRefresh({
        cwd: repo,
        _capture: captureWriting(repo, [prior[0]], depVulnsUnavailable),
      }),
    ).rejects.toThrow(/dep-vuln 2 -> 1 \(not observed this run/);
  }, 120_000);

  it('a capture with NO observation record is refused (absent evidence is not clean)', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    const same = [depVuln('a'.repeat(16), 'axios', 'GHSA-old')];
    const treePath = writeTreeBaseline(repo, baselineFile(repo, priorSha, same));
    const treeBefore = fs.readFileSync(treePath, 'utf8');
    commitChange(repo, 'src.js', 'const a = 9;\n');
    await expect(
      runBaselineRefresh({
        cwd: repo,
        _capture: async () => {
          writeTreeBaseline(repo, baselineFile(repo, git(repo, 'rev-parse', 'HEAD').trim(), same));
        },
      }),
    ).rejects.toThrow(/the capture recorded no observation evidence for this kind/);
    expect(fs.readFileSync(treePath, 'utf8')).toBe(treeBefore);
  }, 120_000);
});
