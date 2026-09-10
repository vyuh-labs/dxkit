/**
 * Per-package advisory attribution (4.4.8 L8, #382).
 *
 * The incident class: a scheduled fix-vulns run applied override pins for
 * fifteen packages and ended guardrail-red with three `added` dep-vulns on a
 * package it never touched. The package resolved to the same version on the
 * base branch before and after the change; the advisories were published
 * after the baseline capture. But the diff DID touch the manifest and the
 * re-serialized lockfile lines DID mention the package (the #283 per-finding
 * tier is deliberately conservative about mentions), so the "published after
 * capture" relabel never applied and the untouched package was blamed.
 *
 * Rule 19: a delta attributes to the developer only when every other cause is
 * ruled out. Here the cause is visible PER PACKAGE: the resolved version on
 * the prior side equals the current one, so the change cannot have introduced
 * the advisory. This net drives the real classify stage (`classifyPairs`) on a
 * git fixture whose diff touches the manifest AND names the package, so the
 * per-package tier is the one that decides.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyPairs } from '../../src/gate/classify-pairs';
import type { ClassifyPairsInput } from '../../src/gate/classify-pairs';
import type { EnvelopeDrift } from '../../src/gate/result';
import type { BaselineFile } from '../../src/baseline/baseline-file';
import type { CurrentScan } from '../../src/baseline/create';
import type { ResolvedMode } from '../../src/baseline/modes';
import type { BaselineEntry, MatchPair, MatchResult } from '../../src/baseline/types';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import { FULL_SCOPE } from '../../src/baseline/gather-scope';
import { deriveImpact, formatImpactExclusions } from '../../src/baseline/impact';
import { newlyPublishedAdvisoryNote } from '../../src/baseline/check-renderers';
import { buildPriorResolvedVersionIndex, priorResolutionUnchanged } from '../../src/gate/context';

const OLD_ID = 'dep00000000old01';
const NEW_ID = 'dep00000000new01';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The base tree: `alpha` (the advisory package) and `beta` (the package the
 *  change will pin), where beta's lockfile entry names alpha in a dependency
 *  line so a beta pin re-serializes a line that MENTIONS alpha. */
function writeTree(dir: string, opts: { alpha: string; beta: string; alphaSpec: string }): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        version: '1.0.0',
        dependencies: { alpha: `^${opts.alpha}`, beta: `^${opts.beta}` },
        ...(opts.beta !== '1.0.0' ? { overrides: { beta: opts.beta } } : {}),
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'fixture',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { alpha: `^${opts.alpha}`, beta: `^${opts.beta}` } },
          'node_modules/alpha': { version: opts.alpha },
          'node_modules/beta': { version: opts.beta, dependencies: { alpha: opts.alphaSpec } },
        },
      },
      null,
      2,
    ) + '\n',
  );
}

let repo: string;
let baseSha: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-per-package-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'module.exports = 1;\n');
  writeTree(repo, { alpha: '1.0.0', beta: '1.0.0', alphaSpec: '^1.0.0' });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  baseSha = git(repo, ['rev-parse', 'HEAD']);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function depEntry(id: string, pkg: string, version: string, advisoryId: string): BaselineEntry {
  return {
    id,
    kind: 'dep-vuln',
    package: pkg,
    advisoryId,
    installedVersion: version,
    severity: 'medium',
  } as BaselineEntry;
}

const NO_DRIFT: EnvelopeDrift = {
  toolchainHashChanged: false,
  policyHashChanged: false,
  ignoreHashChanged: false,
  configHashChanged: false,
  dxkitVersionChanged: false,
  toolVersionDiffs: [],
  recallDrift: [],
  coverageDrift: [],
};

/** Build the stage input: a prior side (the baseline entries) and a current
 *  side holding the same prior entries plus one `added` advisory. */
function stageInput(opts: {
  prior: BaselineEntry[];
  current: BaselineEntry[];
  added: BaselineEntry;
}): ClassifyPairsInput {
  const pairs: MatchPair[] = [
    ...opts.prior.map(
      (e): MatchPair => ({
        priorId: e.id,
        currentId: e.id,
        status: 'persisted',
        confidence: 1,
        reasons: [{ code: 'exact-id', detail: 'same fingerprint' }],
      }),
    ),
    {
      currentId: opts.added.id,
      status: 'added',
      confidence: 1,
      reasons: [{ code: 'no-prior-match', detail: 'not in baseline' }],
    },
  ];
  const matchResult: MatchResult = {
    pairs,
    persisted: opts.prior.map((e) => e.id),
    added: [opts.added.id],
    removed: [],
    gitAware: false,
  };
  const currentFindings = [...opts.current, opts.added];
  const baseline = {
    findings: opts.prior,
    repo: { commitSha: baseSha },
  } as unknown as BaselineFile;
  const current = {
    findings: currentFindings,
    aggregate: {
      findingsByCategory: {
        secret: [],
        code: [],
        config: [],
        dependency: currentFindings.map((e) => ({
          fingerprint: e.id,
          severity: 'medium',
          package: (e as { package: string }).package,
          installedVersion: (e as { installedVersion?: string }).installedVersion,
          id: (e as { advisoryId: string }).advisoryId,
          tool: 'npm-audit',
        })),
      },
      provenance: {},
    },
    customChecksUnobserved: { gathered: true, checks: [] },
  } as unknown as CurrentScan;
  return {
    cwd: repo,
    policy: DEFAULT_BROWNFIELD_POLICY,
    mode: { mode: 'committed-full', source: 'cli', explanation: 'test' } as ResolvedMode,
    scope: FULL_SCOPE,
    baseline,
    current,
    matchResult,
    envelopeDrift: NO_DRIFT,
    allowlist: null,
    now: new Date('2026-09-10T00:00:00Z'),
  };
}

function addedPairOf(out: ReturnType<typeof classifyPairs>) {
  const p = out.pairs.find((x) => x.pair.status === 'added');
  expect(p).toBeDefined();
  return p!;
}

describe('classifyPairs: after-capture attribution is per package (#382)', () => {
  const priorAlpha = depEntry(OLD_ID, 'alpha', '1.0.0', 'GHSA-old0-0000-0001');

  it('a manifest change for ANOTHER package never blames an advisory on a package whose resolution did not move', () => {
    // Head pins beta 1.0.0 -> 2.0.0. The beta lockfile entry's dependency line
    // on alpha is rewritten too (a re-serialization the #283 mention test
    // reads as "alpha possibly changed"), while alpha still resolves 1.0.0.
    writeTree(repo, { alpha: '1.0.0', beta: '2.0.0', alphaSpec: '1.0.0' });
    const changedLock = fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8');
    expect(changedLock).toContain('"alpha": "1.0.0"');

    const out = classifyPairs(
      stageInput({
        prior: [priorAlpha],
        current: [priorAlpha],
        added: depEntry(NEW_ID, 'alpha', '1.0.0', 'GHSA-new0-0000-0001'),
      }),
    );
    const added = addedPairOf(out);
    expect(added.classification.status).toBe('newly_published_advisory');
    const reason = added.classification.reasons.find((r) => r.code === 'newly-published-advisory');
    expect(reason).toBeDefined();
    // The per-package tier decided (tiers 1 and 2 declined: the manifest is
    // touched and a changed line mentions the package).
    expect(reason!.detail).toContain('resolves to the same version as on the prior side');
    // Medium under the default tier: warn, the decision lane, never a block.
    expect(added.classification.blocks).toBe(false);
    expect(added.classification.warns).toBe(true);
    expect(out.blocks).toBe(false);

    // Rendered as the after-capture line on the impact surface.
    const impact = deriveImpact({ pairs: out.pairs, baseline: { findings: [priorAlpha] } });
    expect(formatImpactExclusions(impact)).toBe(
      'Not counted (cannot attribute to this change): 1 from advisories published after baseline capture.',
    );
    // And the blocking-list note stays tier-agnostic when it renders.
    const note = newlyPublishedAdvisoryNote(
      [{ ...added, classification: { ...added.classification, blocks: true } }],
      '',
    ).join('\n');
    expect(note).toContain('not introduced by this PR');
    expect(note).not.toContain('no dependency manifest changed');
  });

  it('negative control: head bumps the package to a version the new advisory covers -> added', () => {
    writeTree(repo, { alpha: '2.0.0', beta: '1.0.0', alphaSpec: '^2.0.0' });
    const out = classifyPairs(
      stageInput({
        prior: [priorAlpha],
        current: [{ ...priorAlpha, installedVersion: '2.0.0' } as BaselineEntry],
        added: depEntry(NEW_ID, 'alpha', '2.0.0', 'GHSA-new0-0000-0001'),
      }),
    );
    const added = addedPairOf(out);
    expect(added.classification.status).toBe('added');
    expect(added.classification.blocks).toBe(true);
    const reason = added.classification.reasons.find((r) => r.code === 'resolution-changed');
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain('different version than on the prior side');
  });

  it('no prior record of the package is "cannot prove unchanged": stays added, disclosed', () => {
    // Same manifest change as the first case, but the prior side never
    // recorded alpha (it was clean at capture), so there is no resolved
    // version to compare against. Absent evidence never demotes (Rule 19).
    writeTree(repo, { alpha: '1.0.0', beta: '2.0.0', alphaSpec: '1.0.0' });
    const priorBeta = depEntry('dep00000000beta1', 'beta', '1.0.0', 'GHSA-beta-0000-0001');
    const out = classifyPairs(
      stageInput({
        prior: [priorBeta],
        current: [{ ...priorBeta, installedVersion: '2.0.0' } as BaselineEntry],
        added: depEntry(NEW_ID, 'alpha', '1.0.0', 'GHSA-new0-0000-0001'),
      }),
    );
    const added = addedPairOf(out);
    expect(added.classification.status).toBe('added');
    const reason = added.classification.reasons.find((r) => r.code === 'resolution-unknown');
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain('no prior record of this package');
  });

  it('the per-finding tier (#283) still answers first when no changed line names the package', () => {
    // Bump beta without rewriting its alpha dependency line: the diff touches
    // the manifest but never mentions alpha, so the cheaper #283 tier decides
    // and the per-package tier is never consulted.
    writeTree(repo, { alpha: '1.0.0', beta: '2.0.0', alphaSpec: '^1.0.0' });
    const out = classifyPairs(
      stageInput({
        prior: [priorAlpha],
        current: [priorAlpha],
        added: depEntry(NEW_ID, 'alpha', '1.0.0', 'GHSA-new0-0000-0001'),
      }),
    );
    const added = addedPairOf(out);
    expect(added.classification.status).toBe('newly_published_advisory');
    const reason = added.classification.reasons.find((r) => r.code === 'newly-published-advisory');
    expect(reason!.detail).toContain('no manifest line mentioning this package');
  });
});

describe('the ONE prior-side resolution source (Rule 2.30)', () => {
  it('indexes every version the prior side recorded per package, from dep-vuln entries only', () => {
    const index = buildPriorResolvedVersionIndex([
      depEntry('a', 'alpha', '1.0.0', 'GHSA-1'),
      depEntry('b', 'alpha', '1.2.0', 'GHSA-2'), // a nested second copy
      depEntry('c', 'beta', '3.0.0', 'GHSA-3'),
      { id: 'd', kind: 'dep-vuln', package: 'gamma', advisoryId: 'GHSA-4' } as BaselineEntry, // no version
      { id: 'e', kind: 'secret', file: 'x.ts', line: 1 } as unknown as BaselineEntry,
    ]);
    expect([...index.get('alpha')!].sort()).toEqual(['1.0.0', '1.2.0']);
    expect([...index.get('beta')!]).toEqual(['3.0.0']);
    expect(index.has('gamma')).toBe(false);
    expect(index.size).toBe(2);
  });

  it('answers the tri-state: unchanged / changed / unknown', () => {
    const index = buildPriorResolvedVersionIndex([
      depEntry('a', 'alpha', '1.0.0', 'GHSA-1'),
      depEntry('b', 'alpha', '1.2.0', 'GHSA-2'),
    ]);
    expect(priorResolutionUnchanged(index, 'alpha', '1.2.0')).toBe(true);
    expect(priorResolutionUnchanged(index, 'alpha', '2.0.0')).toBe(false);
    expect(priorResolutionUnchanged(index, 'alpha', undefined)).toBeUndefined();
    expect(priorResolutionUnchanged(index, 'beta', '1.0.0')).toBeUndefined();
  });
});
