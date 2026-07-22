/**
 * D4 phase 1 — the `newly_published_advisory` classification (4.1.3).
 *
 * The incident class: a committed-mode repo's PR that touches NO dependency
 * manifest gets hard-blocked as "N new regressions" the day an advisory batch
 * lands on any unchanged dependency (web-client #375, then #376 48h later).
 * Recall is genuinely clean (same scanner, same version), so Rule 19 rightly
 * stays silent — the one input that moved is the advisory FEED. The fix is
 * attribution honesty with gate semantics UNCHANGED: the finding still blocks
 * exactly as `added` does (a live high/critical advisory must not ride in),
 * but the status stops blaming the PR and the output names both lanes.
 *
 * Parity discipline (Rule 2.30): the classifier's discriminator and the
 * ref-based incremental dep-audit skip consume the ONE pack-declared
 * `changedFilesTouchDependencyManifest` — pinned here behaviorally (the
 * helper's verdict drives the relabel decision on shared fixtures) and at the
 * source level (check.ts holds no second manifest matcher).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { classify } from '../../src/baseline/classify';
import type { ClassifyContext } from '../../src/baseline/classify';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import type { BrownfieldPolicy } from '../../src/baseline/policy';
import type { MatchPair } from '../../src/baseline/types';
import { changedFilesTouchDependencyManifest, getLanguage } from '../../src/languages';
import {
  markdownNewlyPublishedAdvisoryNote,
  newlyPublishedAdvisoryNote,
} from '../../src/baseline/check-renderers';
import type { ClassifiedPair } from '../../src/baseline/check';

const addedPair: MatchPair = {
  currentId: 'dep0000000000000a',
  status: 'added',
  confidence: 1,
  reasons: [{ code: 'no-prior-match', detail: 'not in baseline' }],
};

function ctx(extra: Partial<ClassifyContext>): ClassifyContext {
  return { kind: 'dep-vuln', severity: 'high', ...extra };
}

describe('classify — newly_published_advisory (D4 phase 1)', () => {
  it('relabels an added dep-vuln on a manifest-untouched diff, with the honest reason', () => {
    const out = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, ctx({ manifestUntouched: true }));
    expect(out.status).toBe('newly_published_advisory');
    const reason = out.reasons.find((r) => r.code === 'newly-published-advisory');
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain('not introduced by this PR');
    expect(reason!.detail).toContain('allowlist defer');
  });

  it('gate semantics are UNCHANGED: it blocks exactly as added does (policy membership)', () => {
    // Default policy blocks 'added' by membership; the relabel must not open
    // a bypass for severities no block rule covers.
    const medium = classify(
      addedPair,
      DEFAULT_BROWNFIELD_POLICY,
      ctx({ severity: 'medium', manifestUntouched: true }),
    );
    const asAdded = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, ctx({ severity: 'medium' }));
    expect(medium.status).toBe('newly_published_advisory');
    expect(medium.blocks).toBe(asAdded.blocks);
    expect(medium.warns).toBe(asAdded.warns);
  });

  it('armed block rules still fire through the relabel (critical, high+reachable, malicious)', () => {
    const critical = classify(
      addedPair,
      DEFAULT_BROWNFIELD_POLICY,
      ctx({ severity: 'critical', manifestUntouched: true }),
    );
    expect(critical.blocks).toBe(true);
    expect(
      critical.reasons.some((r) => r.detail.includes('newCriticalDependencyVulnerability')),
    ).toBe(true);

    const reachable = classify(
      addedPair,
      DEFAULT_BROWNFIELD_POLICY,
      ctx({ severity: 'high', reachable: true, manifestUntouched: true }),
    );
    expect(reachable.blocks).toBe(true);
    expect(
      reachable.reasons.some((r) => r.detail.includes('newHighReachableDependencyVulnerability')),
    ).toBe(true);

    const malicious = classify(
      addedPair,
      DEFAULT_BROWNFIELD_POLICY,
      ctx({ severity: 'low', malicious: true, manifestUntouched: true }),
    );
    expect(malicious.blocks).toBe(true);
    expect(malicious.reasons.some((r) => r.detail.includes('newMaliciousDependency'))).toBe(true);
  });

  it('a warn-only policy keeps warning (relabel never escalates)', () => {
    const warnOnly: BrownfieldPolicy = {
      ...DEFAULT_BROWNFIELD_POLICY,
      block: [],
      warn: ['added'],
      blockRules: {
        ...DEFAULT_BROWNFIELD_POLICY.blockRules,
        newCriticalDependencyVulnerability: false,
        newHighReachableDependencyVulnerability: false,
        newMaliciousDependency: false,
      },
    };
    const out = classify(addedPair, warnOnly, ctx({ severity: 'medium', manifestUntouched: true }));
    expect(out.status).toBe('newly_published_advisory');
    expect(out.blocks).toBe(false);
    expect(out.warns).toBe(true);
  });

  it('absent evidence means NO relabel — an added dep-vuln stays added', () => {
    // `manifestUntouched` absent = changed files unknowable; the classifier
    // must not claim an attribution it has no evidence for (Rule 19).
    const out = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, ctx({}));
    expect(out.status).toBe('added');
  });

  it('a manifest-TOUCHING diff keeps full added semantics', () => {
    const out = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, ctx({ manifestUntouched: false }));
    expect(out.status).toBe('added');
  });

  it('only dep-vulns relabel — other kinds ignore the flag', () => {
    const out = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, {
      kind: 'secret',
      severity: 'critical',
      manifestUntouched: true,
    });
    expect(out.status).toBe('added');
  });

  it('recall drift outranks the relabel (D4b stays a disclosed drift, not an advisory claim)', () => {
    // When the scanner itself moved (sandbox npm 10.8.2 vs baseline 10.9.8),
    // the data-vintage claim is not clean — Rule 19's tooling_drift branch
    // keeps priority, including its unattributable-block-rule refusal tier.
    const out = classify(
      addedPair,
      DEFAULT_BROWNFIELD_POLICY,
      ctx({ severity: 'critical', recallDrifted: true, manifestUntouched: true }),
    );
    expect(out.status).toBe('tooling_drift');
    expect(out.unattributableBlockRule).toBe('newCriticalDependencyVulnerability');
  });
});

describe('renderers — the honest attribution note (both surfaces)', () => {
  function blockingPair(status: string, kind = 'dep-vuln'): ClassifiedPair {
    return {
      kind,
      locator: 'axios@1.16.1 · GHSA-h67p-54hq-rp68',
      classification: { status, blocks: true, warns: false, reasons: [] },
      pair: addedPair,
      severity: 'high',
    } as unknown as ClassifiedPair;
  }

  it('console: names the two lanes and states the PR did not cause the findings', () => {
    const lines = newlyPublishedAdvisoryNote(
      [blockingPair('newly_published_advisory'), blockingPair('added', 'secret')],
      '  ',
    );
    expect(lines.join('\n')).toContain('not introduced by this PR');
    expect(lines.join('\n')).toContain('allowlist defer --from-last-check');
    expect(lines.join('\n')).toContain('fix lane');
  });

  it('markdown: the blockquote above the blocking table, with both lanes', () => {
    const md = markdownNewlyPublishedAdvisoryNote([
      blockingPair('newly_published_advisory'),
      blockingPair('newly_published_advisory'),
    ]).join('\n');
    expect(md).toContain('All 2 blocking findings are newly published advisories');
    expect(md).toContain('not introduced by this PR');
    expect(md).toContain('allowlist defer --from-last-check');
  });

  it('silent when no blocking pair carries the status', () => {
    expect(newlyPublishedAdvisoryNote([blockingPair('added')], '  ')).toEqual([]);
    expect(markdownNewlyPublishedAdvisoryNote([blockingPair('added')])).toEqual([]);
  });
});

describe('discriminator parity with the ref-based dep-audit skip (Rule 2.30)', () => {
  const ts = getLanguage('typescript')!;

  // Shared fixtures: the SAME changed-file sets, judged by the ONE helper.
  const fixtures: ReadonlyArray<{ files: string[]; touches: boolean }> = [
    { files: ['src/app.ts', 'README.md'], touches: false },
    { files: ['package.json'], touches: true },
    { files: ['package-lock.json'], touches: true },
    { files: ['services/api/pnpm-lock.yaml'], touches: true },
    { files: ['docs/guide.md'], touches: false },
  ];

  it('the helper verdict drives BOTH consumers identically on shared fixtures', () => {
    for (const f of fixtures) {
      const touches = changedFilesTouchDependencyManifest(f.files, [ts]);
      expect(touches).toBe(f.touches);

      // Consumer 1 — the ref-based incremental skip: audits are skipped
      // exactly when the diff touches no manifest.
      const skipFires = !touches;

      // Consumer 2 — the classifier discriminator: an added dep-vuln relabels
      // exactly when the diff touches no manifest.
      const out = classify(
        addedPair,
        DEFAULT_BROWNFIELD_POLICY,
        ctx({ manifestUntouched: !touches }),
      );
      const relabels = out.status === 'newly_published_advisory';

      // Parity: the two consumers may never disagree about the diff's
      // dependency-relevance. (If the skip fires, the audit never runs and no
      // added dep-vuln can exist ref-based — so a finding that DOES appear, in
      // committed mode, must carry the honest relabel.)
      expect(relabels).toBe(skipFires);
    }
  });

  it('check.ts consumes the ONE helper for both the skip and the discriminator (source pin)', () => {
    // Strip comments first (the languages-contract lesson: a grep that
    // matches a comment reports coverage that does not exist).
    const src = fs
      .readFileSync(path.join(__dirname, '..', '..', 'src', 'baseline', 'check.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const calls = src.match(/changedFilesTouchDependencyManifest\(/g) ?? [];
    // Exactly two consumers: the ref-based skip and the D4 discriminator.
    expect(calls.length).toBe(2);
    // And no second manifest-pattern matcher smuggled in beside the helper.
    expect(src).not.toMatch(/matchesManifestPattern\(/);
    expect(src).not.toMatch(/allDependencyManifestPatterns\(/);
  });
});
