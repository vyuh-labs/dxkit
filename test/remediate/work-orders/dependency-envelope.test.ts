/**
 * Dependency envelopes carry every file a dependency fix edits: the ONE
 * manifest + lockfile union derived from the pack declarations. bun.lock
 * was declared only as a root-marker lockfile (`lockfilePatterns`), so it
 * fell outside every dependency envelope and the recipe runner discarded
 * the lockfile change, committing package.json alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { allDependencyManifestPatterns, getLanguage } from '../../../src/languages';
import { manifestRoots } from '../../../src/remediate/work-orders/gather';
import { planWorkOrders } from '../../../src/remediate/work-orders/planner';
import { partitionByEnvelope } from '../../../src/remediate/recipes/envelope';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';
import type { RichBaselineEntry } from '../../../src/baseline/types';

const TS = getLanguage('typescript')!;
const NODE_LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-dep-envelope-'));
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function advisoryDebt(): RichBaselineEntry {
  return {
    id: 'd1',
    kind: 'dep-vuln',
    package: 'left-pad',
    installedVersion: '1.0.0',
    advisoryId: 'GHSA-1',
    severity: 'high',
  } as RichBaselineEntry;
}

describe('dependency envelope: the manifest + lockfile union', () => {
  it('the pattern union is ONE union of manifests AND lockfiles', () => {
    const patterns = allDependencyManifestPatterns([TS]);
    for (const lock of NODE_LOCKFILES) expect(patterns).toContain(lock);
    expect(patterns).toContain('package.json');
  });

  it.each(NODE_LOCKFILES)('%s lands inside a dependency order envelope', (lockfile) => {
    writeFileSync(join(repo, lockfile), '');
    const manifests = manifestRoots(repo, [TS], []);
    expect(manifests[0].files).toContain(lockfile);
    const plan = planWorkOrders({
      floorFailures: [],
      blocking: [],
      deferred: [],
      debt: [advisoryDebt()],
      manifests,
      installFor: () => ({ bin: 'npm', args: ['ci'] }),
      policy: { maxSliceSize: 25, budgetFor: () => DEFAULT_REMEDIATE_BUDGET },
    });
    const order = plan.orders.find((o) => o.findings.some((f) => f.id === 'd1'))!;
    expect(order.envelope.paths).toContain(lockfile);
    // the recipe runner's split: the lockfile change is committed, never discarded
    const { inside, outside } = partitionByEnvelope(['package.json', lockfile], order.envelope);
    expect(inside).toEqual(['package.json', lockfile]);
    expect(outside).toEqual([]);
  });
});
