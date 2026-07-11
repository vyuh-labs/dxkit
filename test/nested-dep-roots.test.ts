/**
 * Nested dependency-audit roots — the fix for the nested-lockfile gap
 * (a vuln added to a nested sub-project's lockfile read CLEAN because the
 * dep audit ran at the repo root only).
 *
 * Three layers: discovery (canonical walker, exclusion-aware, capped with
 * disclosure), outcome merging (identity dedup + per-package recount,
 * root-only behavior byte-identical when nothing nested exists), and the
 * dispatch composite driven by a FAKE pack — proving per-root auditing is
 * declaration-driven (`lockfilePatterns`), not hardcoded per ecosystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverNestedDepRoots,
  mergeDepVulnOutcomes,
  MAX_NESTED_DEP_ROOTS,
} from '../src/analyzers/security/nested-dep-roots';
import { gatherPackDepVulnsAcrossRoots } from '../src/analyzers/security/gather';
import { clearWalkPathsCache } from '../src/analyzers/tools/walk-paths';
import type {
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
} from '../src/languages/capabilities/types';
import type { LanguageSupport } from '../src/languages/types';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-nested-dep-'));
  clearWalkPathsCache();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  clearWalkPathsCache();
});

function file(rel: string, content = '{}'): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function finding(pkg: string, id: string, severity: DepVulnFinding['severity']): DepVulnFinding {
  return { id, package: pkg, installedVersion: '1.0.0', tool: 't', severity };
}

function success(tool: string, findings: DepVulnFinding[]): DepVulnGatherOutcome {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool,
    enrichment: 'osv.dev',
    counts,
    findings,
  };
  return { kind: 'success', envelope };
}

describe('discoverNestedDepRoots', () => {
  it('finds nested lockfile dirs, never the root, exclusion-aware', () => {
    file('package-lock.json');
    file('website-react/server/package-lock.json');
    file('services/api/pnpm-lock.yaml');
    file('node_modules/dep/package-lock.json'); // excluded dir
    const { roots, dropped } = discoverNestedDepRoots(tmp, ['package-lock.json', 'pnpm-lock.yaml']);
    expect(roots).toEqual(['services/api', 'website-react/server']);
    expect(dropped).toEqual([]);
  });

  it('caps at the ceiling and DISCLOSES what was dropped', () => {
    for (let i = 0; i < MAX_NESTED_DEP_ROOTS + 3; i++) {
      file(`pkg-${String(i).padStart(2, '0')}/package-lock.json`);
    }
    const { roots, dropped } = discoverNestedDepRoots(tmp, ['package-lock.json']);
    expect(roots).toHaveLength(MAX_NESTED_DEP_ROOTS);
    expect(dropped).toHaveLength(3);
  });

  it('empty patterns → no discovery (root-only packs unchanged)', () => {
    file('sub/package-lock.json');
    expect(discoverNestedDepRoots(tmp, [])).toEqual({ roots: [], dropped: [] });
  });
});

describe('mergeDepVulnOutcomes', () => {
  it('single root success with no nested successes passes through untouched', () => {
    const root = success('npm-audit', [finding('lodash', 'GHSA-1', 'high')]);
    expect(mergeDepVulnOutcomes(root, [{ kind: 'no-manifest', reason: 'x' }], false)).toBe(root);
  });

  it('root failure passes through when nothing nested succeeded (availability story intact)', () => {
    const root: DepVulnGatherOutcome = { kind: 'unavailable', reason: 'scanner missing' };
    expect(mergeDepVulnOutcomes(root, [{ kind: 'no-manifest', reason: 'x' }], false)).toBe(root);
  });

  it('a nested success rescues a root no-manifest (the sub-project-only repo)', () => {
    const nested = success('npm-audit', [finding('node-serialize', 'GHSA-crit', 'critical')]);
    const merged = mergeDepVulnOutcomes({ kind: 'no-manifest', reason: 'x' }, [nested], false);
    expect(merged.kind).toBe('success');
    if (merged.kind === 'success') {
      expect((merged.envelope.findings ?? []).map((f) => f.package)).toEqual(['node-serialize']);
    }
  });

  it('dedupes identical findings across roots, recounts per package, unions tools', () => {
    const root = success('npm-audit', [
      finding('lodash', 'GHSA-1', 'high'),
      finding('lodash', 'GHSA-2', 'medium'), // same pkg, 2nd advisory
    ]);
    const nested = success('osv-scanner', [
      finding('lodash', 'GHSA-1', 'high'), // duplicate across roots → dropped
      finding('node-serialize', 'GHSA-9', 'critical'),
    ]);
    const merged = mergeDepVulnOutcomes(root, [nested], false);
    expect(merged.kind).toBe('success');
    if (merged.kind !== 'success') return;
    // Findings: per-advisory, deduped on (package, version, id).
    expect((merged.envelope.findings ?? []).map((f) => f.id).sort()).toEqual([
      'GHSA-1',
      'GHSA-2',
      'GHSA-9',
    ]);
    // Counts: per PACKAGE at worst severity (the documented count model).
    expect(merged.envelope.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });
    expect(merged.envelope.tool).toBe('npm-audit+osv-scanner');
  });

  it('a capped discovery is marked on the tool string, never silent', () => {
    const root = success('npm-audit', [finding('a', 'G-1', 'low')]);
    const nested = success('npm-audit', [finding('b', 'G-2', 'low')]);
    const merged = mergeDepVulnOutcomes(root, [nested], true);
    expect(merged.kind === 'success' && merged.envelope.tool).toBe('npm-audit+capped');
  });
});

describe('gatherPackDepVulnsAcrossRoots — declaration-driven dispatch', () => {
  function fakePack(lockfilePatterns: string[] | undefined, calls: string[]): LanguageSupport {
    return {
      id: 'typescript',
      capabilities: {
        depVulns: {
          source: 'fake',
          manifestPatterns: ['fake.lock'],
          ...(lockfilePatterns !== undefined ? { lockfilePatterns } : {}),
          async gather() {
            return null;
          },
          async gatherOutcome(dir: string) {
            calls.push(path.relative(tmp, dir) || '.');
            const rel = path.relative(tmp, dir);
            return success(`tool@${rel || 'root'}`, [
              finding(`pkg-${rel || 'root'}`, `G-${rel || 'root'}`, 'high'),
            ]);
          },
        },
      },
    } as unknown as LanguageSupport;
  }

  it('audits the root plus every discovered nested root and merges', async () => {
    file('fake.lock');
    file('apps/server/fake.lock');
    file('apps/web/fake.lock');
    const calls: string[] = [];
    const outcome = await gatherPackDepVulnsAcrossRoots(
      fakePack(['fake.lock'], calls),
      tmp,
      undefined,
    );
    expect(calls.sort()).toEqual(['.', 'apps/server', 'apps/web']);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect((outcome.envelope.findings ?? []).map((f) => f.package).sort()).toEqual([
        'pkg-apps/server',
        'pkg-apps/web',
        'pkg-root',
      ]);
    }
  });

  it('a pack without lockfilePatterns keeps byte-identical root-only behavior', async () => {
    file('fake.lock');
    file('apps/server/fake.lock');
    const calls: string[] = [];
    const outcome = await gatherPackDepVulnsAcrossRoots(fakePack(undefined, calls), tmp, undefined);
    expect(calls).toEqual(['.']);
    expect(outcome.kind).toBe('success');
  });
});
