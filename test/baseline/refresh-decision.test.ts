/**
 * `vyuh-dxkit baseline refresh` — the D4 advisory decision lane (4.1.4).
 *
 * The class both ways:
 *   - ABSORPTION (the failure this closes): the old refresh (`create --force`)
 *     silently grandfathered advisories the feed published after the previous
 *     capture — no decision, no expiry pressure, defer-forever.
 *   - FALSE HOLD-OUT (the over-trigger): a diff that DID change a dependency
 *     manifest may legitimately bring new advisories with it — those absorb as
 *     ordinary pre-existing debt, the standard refresh contract.
 *
 * The discriminator is the ONE `changedFilesTouchDependencyManifest` (Rule
 * 2.30 — the same helper the classifier and the ref-based skip consume). The
 * capture itself is injected (`_capture`) — these tests exercise the decision
 * lane, not the analyzers. The decision branch is verified on a real bare
 * origin: entries, expiry carry-over across re-raises, and zero working-tree /
 * HEAD impact. The degraded-capture refusal (#388) lives in
 * `refresh-refusal.test.ts`; the shared fixtures in `refresh-harness.ts`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ADVISORY_DECISION_BRANCH,
  decisionPrBody,
  runBaselineRefresh,
} from '../../src/baseline/refresh';
import { publishFilesToAnchorRef } from '../../src/baseline/anchor-publish';
import type { BaselineFile } from '../../src/baseline/baseline-file';
import { DEFER_ADVISORY_EXPIRY_DAYS } from '../../src/allowlist/categories';
import type { OsvVuln } from '../../src/analyzers/tools/osv';
import {
  baselineFile,
  captureWriting,
  commitChange,
  decisionAllowlist,
  depVuln,
  git,
  makeRepoWithOrigin,
  readTreeBaseline,
  registerRefreshTmpCleanup,
  writeTreeBaseline,
} from './refresh-harness';

registerRefreshTmpCleanup();

describe('baseline refresh — the advisory decision lane', () => {
  it('holds newly published advisories OUT of the baseline and raises the decision branch', async () => {
    const { repo, bare } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(
      repo,
      baselineFile(repo, priorSha, [depVuln('a'.repeat(16), 'axios', 'GHSA-old')]),
    );
    // A NON-manifest change since the prior anchor — the feed, not the diff.
    commitChange(repo, 'src.js', 'const a = 2;\n');

    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [
        depVuln('a'.repeat(16), 'axios', 'GHSA-old'),
        depVuln('b'.repeat(16), 'fast-uri', 'GHSA-new-1'),
        depVuln('c'.repeat(16), 'svgo', 'GHSA-new-2'),
      ]),
    });

    // Held out of the written baseline — never absorbed.
    expect(result.heldOut.map((a) => a.advisoryId).sort()).toEqual(['GHSA-new-1', 'GHSA-new-2']);
    const written = JSON.parse(
      fs.readFileSync(path.join(repo, '.dxkit', 'baselines', 'main.json'), 'utf8'),
    ) as BaselineFile;
    expect(written.findings.map((f) => f.id)).toEqual(['a'.repeat(16)]);

    // The decision branch landed on the origin, parented on HEAD (mergeable),
    // carrying deferred entries with the short expiry.
    const allow = decisionAllowlist(bare);
    const fps = allow.entries.map((e) => e.fingerprint).sort();
    expect(fps).toEqual(['b'.repeat(16), 'c'.repeat(16)]);
    for (const e of allow.entries) {
      expect(e).toMatchObject({ kind: 'dep-vuln', category: 'deferred', addedBy: 'dxkit-refresh' });
      const days = Math.round(
        (new Date(`${e.expiresAt}T00:00:00Z`).getTime() - Date.now()) / 86_400_000,
      );
      expect(days).toBeGreaterThanOrEqual(DEFER_ADVISORY_EXPIRY_DAYS - 1);
      expect(days).toBeLessThanOrEqual(DEFER_ADVISORY_EXPIRY_DAYS);
    }
    const parent = execFileSync('git', ['rev-parse', `${ADVISORY_DECISION_BRANCH}^`], {
      cwd: bare,
      encoding: 'utf8',
    }).trim();
    expect(parent).toBe(git(repo, 'rev-parse', 'HEAD').trim());

    // Zero working-tree / HEAD impact: no allowlist file appeared in the tree,
    // HEAD did not move, the tree is clean apart from the baseline rewrite.
    expect(fs.existsSync(path.join(repo, '.dxkit', 'allowlist.json'))).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  }, 120_000);

  it('a manifest-touching diff ABSORBS new advisories (the standard refresh contract)', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    commitChange(repo, 'package.json', JSON.stringify({ name: 'fx', version: '2' }));

    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [depVuln('d'.repeat(16), 'newdep', 'GHSA-x')]),
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('dependency manifest changed');
    const written = JSON.parse(
      fs.readFileSync(path.join(repo, '.dxkit', 'baselines', 'main.json'), 'utf8'),
    ) as BaselineFile;
    expect(written.findings).toHaveLength(1);
  }, 120_000);

  it('re-raise preserves the ORIGINAL expiry (no rolling defer-forever)', async () => {
    const { repo, bare } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    commitChange(repo, 'src.js', 'const a = 3;\n');

    const firstNow = new Date();
    await runBaselineRefresh({
      cwd: repo,
      now: firstNow,
      _capture: captureWriting(repo, [depVuln('e'.repeat(16), 'immutable', 'GHSA-y')]),
    });
    const firstExpiry = decisionAllowlist(bare).entries[0].expiresAt;

    // Three days later the refresh runs again; the advisory is still undecided
    // (prior baseline unchanged on the tree — the decision PR is unmerged).
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    const laterNow = new Date(firstNow.getTime() + 3 * 86_400_000);
    const second = await runBaselineRefresh({
      cwd: repo,
      now: laterNow,
      _capture: captureWriting(repo, [depVuln('e'.repeat(16), 'immutable', 'GHSA-y')]),
    });
    expect(decisionAllowlist(bare).entries[0].expiresAt).toBe(firstExpiry);
    // #389: still held out (pending), but never counted or announced as new
    // again. "Known before the prior capture" includes the decision branch's
    // carried hold-outs, so the predicate is idempotent day over day.
    const firstDay = firstNow.toISOString().slice(0, 10);
    expect(second.heldOut).toHaveLength(1);
    expect(second.heldOut[0].pendingSince).toBe(firstDay);
    expect(second.note).toContain('no newly published advisories since the prior capture');
    expect(second.note).toContain(`1 still pending a decision (first raised ${firstDay})`);
    expect(readTreeBaseline(repo).findings).toEqual([]);

    // Day N+4: the feed moves again. ONE new advisory is announced as new; the
    // pending one rides along, still pending, its expiry still the original.
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    const third = await runBaselineRefresh({
      cwd: repo,
      now: new Date(laterNow.getTime() + 86_400_000),
      _capture: captureWriting(repo, [
        depVuln('e'.repeat(16), 'immutable', 'GHSA-y'),
        depVuln('1'.repeat(16), 'lodash', 'GHSA-z'),
      ]),
    });
    expect(third.heldOut.map((a) => [a.advisoryId, a.pendingSince ?? 'new'])).toEqual([
      ['GHSA-z', 'new'],
      ['GHSA-y', firstDay],
    ]);
    expect(third.note).toMatch(/^1 newly published advisory held out/);
    expect(third.note).toContain(`plus 1 still pending a decision (first raised ${firstDay})`);
    const entries = decisionAllowlist(bare).entries;
    expect(entries.find((e) => e.fingerprint === 'e'.repeat(16))?.expiresAt).toBe(firstExpiry);
    expect(entries.map((e) => e.fingerprint).sort()).toEqual(['1'.repeat(16), 'e'.repeat(16)]);
  }, 120_000);

  // #389: an advisory absent from the prior anchor but OLDER than the prior
  // capture by publication date is recorded debt that DISAPPEARED (a degraded
  // capture published before the refusal existed). It is absorbed as
  // pre-existing debt with the anomaly disclosed, never held out.
  it('an advisory older than the prior capture is absorbed as debt with the anomaly disclosed, never held out', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    // The prior's `createdAt` is 2026-07-20 (see `baselineFile`).
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    commitChange(repo, 'src.js', 'const a = 5;\n');
    const fetched: string[] = [];
    const osvFetcher = async (id: string): Promise<OsvVuln | null> => {
      fetched.push(id);
      if (id === 'GHSA-l12-old') return { id, published: '2026-01-05T00:00:00Z' };
      if (id === 'GHSA-l12-new') return { id, published: '2026-08-01T00:00:00Z' };
      return null;
    };
    const result = await runBaselineRefresh({
      cwd: repo,
      osvFetcher,
      _capture: captureWriting(repo, [
        depVuln('2'.repeat(16), 'old-dep', 'GHSA-l12-old'),
        depVuln('3'.repeat(16), 'new-dep', 'GHSA-l12-new'),
        depVuln('4'.repeat(16), 'undated-dep', 'GHSA-l12-undated'),
      ]),
    });
    // Only the candidate set is resolved (never the whole baseline).
    expect(fetched.sort()).toEqual(['GHSA-l12-new', 'GHSA-l12-old', 'GHSA-l12-undated']);
    // The new one and the undated one (unknown date reads as new, never as
    // old) are held out; the old one stays in the baseline as debt.
    expect(result.heldOut.map((a) => a.advisoryId).sort()).toEqual([
      'GHSA-l12-new',
      'GHSA-l12-undated',
    ]);
    expect(readTreeBaseline(repo).findings.map((f) => f.id)).toEqual(['2'.repeat(16)]);
    expect(result.disclosures).toHaveLength(1);
    expect(result.disclosures[0]).toContain('recorded debt disappeared from the prior anchor');
    expect(result.disclosures[0]).toContain('GHSA-l12-old');
    expect(result.disclosures[0]).toContain('degraded capture');
    expect(result.note).toMatch(/^2 newly published advisories held out/);
  }, 120_000);

  it('no prior baseline → plain capture, disclosed', async () => {
    const { repo } = makeRepoWithOrigin();
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [depVuln('f'.repeat(16), 'axios', 'GHSA-z')]),
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('first capture');
  }, 120_000);

  // #388: a prior that EXISTS but cannot be parsed is not "first capture".
  // Treating it so would publish a fresh baseline with every advisory pending
  // a decision absorbed as ordinary debt. The lane refuses, names the remedy,
  // captures nothing and publishes nothing.
  it('a corrupt ANCHOR refuses the refresh: nothing captured, remedy named', async () => {
    const { repo } = makeRepoWithOrigin();
    fs.mkdirSync(path.join(repo, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'committed-full', anchor: 'branch' } }),
    );
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: 'dxkit-baselines',
      files: [{ path: '.dxkit/baselines/main.json', content: '{ this is not json' }],
      message: 'corrupt anchor',
      baseParent: false,
    });
    // A readable tree copy must NOT rescue the run: the anchor is the prior
    // the gate reads, and its corruption is the evidence problem.
    const treePath = writeTreeBaseline(repo, baselineFile(repo, 'base', []));
    const treeBefore = fs.readFileSync(treePath, 'utf8');
    let captured = false;
    await expect(
      runBaselineRefresh({
        cwd: repo,
        _capture: async () => {
          captured = true;
        },
      }),
    ).rejects.toThrow(/refusing to refresh: a prior baseline exists but could not be read/);
    await expect(
      runBaselineRefresh({
        cwd: repo,
        _capture: async () => {
          captured = true;
        },
      }),
    ).rejects.toThrow(/'dxkit-baselines' anchor branch copy[\s\S]*baseline create --force/);
    expect(captured).toBe(false);
    expect(fs.readFileSync(treePath, 'utf8')).toBe(treeBefore);
  }, 120_000);

  it('a corrupt TREE copy (no anchor) refuses the same way', async () => {
    const { repo } = makeRepoWithOrigin();
    const treePath = path.join(repo, '.dxkit', 'baselines', 'main.json');
    fs.mkdirSync(path.dirname(treePath), { recursive: true });
    fs.writeFileSync(treePath, '{ this is not json');
    let captured = false;
    await expect(
      runBaselineRefresh({
        cwd: repo,
        _capture: async () => {
          captured = true;
        },
      }),
    ).rejects.toThrow(/refusing to refresh[\s\S]*committed tree copy/);
    expect(captured).toBe(false);
    expect(fs.readFileSync(treePath, 'utf8')).toBe('{ this is not json');
  }, 60_000);

  it('ref-based mode is a graceful, explained no-op (the class cannot arise there)', async () => {
    const { repo } = makeRepoWithOrigin();
    fs.mkdirSync(path.join(repo, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'ref-based', ref: 'origin/main' } }),
    );
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: async () => {
        throw new Error('capture must not run in ref-based mode');
      },
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('ref-based');
    expect(result.note).toContain('Nothing to do');
  }, 60_000);

  it('a quiet feed refreshes normally with a note', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    const same = [depVuln('a'.repeat(16), 'axios', 'GHSA-old')];
    writeTreeBaseline(repo, baselineFile(repo, priorSha, same));
    commitChange(repo, 'src.js', 'const a = 4;\n');
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, same),
    });
    expect(result.heldOut).toEqual([]);
    expect(result.disclosures).toEqual([]);
    expect(result.note).toContain('no newly published advisories');
  }, 120_000);
});

describe('decisionPrBody', () => {
  it('names both lanes and every advisory', () => {
    const body = decisionPrBody(
      [
        {
          fingerprint: 'b'.repeat(16),
          package: 'fast-uri',
          installedVersion: '3.1.2',
          advisoryId: 'GHSA-new-1',
        },
      ],
      [
        {
          fingerprint: 'b'.repeat(16),
          kind: 'dep-vuln',
          category: 'deferred',
          reason: 'r',
          addedBy: 'dxkit-refresh',
          addedAt: '2026-07-22',
          expiresAt: '2026-07-29',
        },
      ],
    );
    expect(body).toContain('fast-uri@3.1.2');
    expect(body).toContain('GHSA-new-1');
    expect(body).toContain('2026-07-29');
    expect(body).toContain('Lane 1 — fix');
    expect(body).toContain('Lane 2 — defer');
    expect(body).toContain('held out of the refreshed baseline');
    expect(body).toContain('## 1 newly published advisory needs a decision');
    expect(body).toContain('New this refresh (1)');
    expect(body).toContain('| new this refresh |');
  });

  // #389: the body tells "still pending (N, first raised <date>)" apart from
  // "new this refresh (M)"; a pending advisory is never presented as new.
  it('distinguishes still-pending advisories from ones new this refresh', () => {
    const pending = {
      fingerprint: 'b'.repeat(16),
      package: 'fast-uri',
      advisoryId: 'GHSA-pend',
      pendingSince: '2026-07-22',
    };
    const fresh = { fingerprint: 'c'.repeat(16), package: 'svgo', advisoryId: 'GHSA-fresh' };
    const entries = [
      {
        fingerprint: 'b'.repeat(16),
        kind: 'dep-vuln' as const,
        category: 'deferred' as const,
        reason: 'r',
        addedBy: 'dxkit-refresh',
        addedAt: '2026-07-22',
        expiresAt: '2026-07-29',
      },
      {
        fingerprint: 'c'.repeat(16),
        kind: 'dep-vuln' as const,
        category: 'deferred' as const,
        reason: 'r',
        addedBy: 'dxkit-refresh',
        addedAt: '2026-07-25',
        expiresAt: '2026-08-01',
      },
    ];
    const both = decisionPrBody([pending, fresh], entries);
    expect(both).toContain('## 1 newly published advisory needs a decision (1 still pending)');
    expect(both).toContain('New this refresh (1)');
    expect(both).toContain('Still pending (1, first raised 2026-07-22)');
    expect(both).toContain('| GHSA-pend | `' + 'b'.repeat(16) + '` | pending since 2026-07-22 |');
    expect(both).toContain('| GHSA-fresh | `' + 'c'.repeat(16) + '` | new this refresh |');

    const onlyPending = decisionPrBody([pending], entries.slice(0, 1));
    expect(onlyPending).toContain('## 1 advisory still pending a decision');
    expect(onlyPending).toContain('New this refresh: none.');
    expect(onlyPending).not.toContain('newly published advisory needs');
  });
});
