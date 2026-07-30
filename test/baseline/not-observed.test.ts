/**
 * Removal attribution (Rule 19's REMOVED direction, 4.3.2).
 *
 * The shipped class: a PR guardrail ran `--untrusted`, the custom-check
 * runner correctly skipped every repo-declared command (Rule 17's trust
 * boundary), and the diff then compared a baseline holding the repo's
 * 18,406-finding lint backlog against a current side holding zero — minting
 * every entry `removed` and rendering "Resolved (18406)" on a PR that fixed
 * none of it, with zero disclosure. "You fixed N findings" is an attribution
 * claim, and its actual cause was Rule 19's cause #2: dxkit did not observe
 * the current side. Every link in that chain was individually correct; the
 * lie lived between the runner's skip statuses and the renderers.
 *
 * Pinned here, both directions:
 *   - an unobserved check's baseline findings classify `not_observed` (never
 *     `removed`, never counted as resolved, never blocking), and ALL THREE
 *     renderers disclose the aggregate — one line per unobserved check, never
 *     a per-finding table;
 *   - a trusted run keeps full behavior (persisted pairs, empty disclosures,
 *     silent renderers) — over-disclosure trains readers to skip the section;
 *   - the markdown Resolved table is row-capped regardless (the same incident
 *     brushed GitHub's 65,536-byte comment limit at 60,143 bytes).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createBaseline } from '../../src/baseline/create';
import {
  runGuardrailCheck,
  collectNotObservedDisclosures,
  type ClassifiedPair,
  type GuardrailCheckResult,
} from '../../src/baseline/check';
import {
  renderConsole,
  renderJson,
  renderMarkdown,
  verdictCounts,
} from '../../src/baseline/check-renderers';
import { classify } from '../../src/baseline/classify';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import type { BaselineEntry, FindingStatus, MatchPair } from '../../src/baseline/types';
import { trustedLocalContext, untrustedContentContext } from '../../src/analysis-trust';

// ─── classify: the reclassification is fixed-verdict ───────────────────────

function removedPair(): MatchPair {
  return { priorId: 'aaaa111122223333', status: 'removed', confidence: 1, reasons: [] };
}

describe('classify — removed + notObserved', () => {
  it('reclassifies a removed pair to not_observed with the reason on the chain', () => {
    const result = classify(removedPair(), DEFAULT_BROWNFIELD_POLICY, {
      kind: 'custom-check',
      notObserved: 'check "web-lint" skipped (untrusted tree)',
    });
    expect(result.status).toBe('not_observed');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(false);
    const reason = result.reasons.find((r) => r.code === 'not-observed');
    expect(reason?.detail).toContain('web-lint');
    expect(reason?.detail).toContain('not observed is not resolved');
  });

  it('can never block or warn, even under a policy that lists the status', () => {
    const hostile = {
      ...DEFAULT_BROWNFIELD_POLICY,
      block: ['added', 'not_observed'] as ReadonlyArray<FindingStatus>,
      warn: ['not_observed'] as ReadonlyArray<FindingStatus>,
    };
    const result = classify(removedPair(), hostile, {
      kind: 'custom-check',
      notObserved: 'check "web-lint" skipped (untrusted tree)',
    });
    expect(result.status).toBe('not_observed');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(false);
  });

  it('leaves a removed pair without the context untouched (a real resolution stays resolved)', () => {
    const result = classify(removedPair(), DEFAULT_BROWNFIELD_POLICY, { kind: 'custom-check' });
    expect(result.status).toBe('removed');
  });

  it('never fires for non-removed statuses', () => {
    const persisted: MatchPair = {
      priorId: 'a',
      currentId: 'a',
      status: 'persisted',
      confidence: 1,
      reasons: [],
    };
    const result = classify(persisted, DEFAULT_BROWNFIELD_POLICY, {
      kind: 'custom-check',
      notObserved: 'check "web-lint" skipped (untrusted tree)',
    });
    expect(result.status).toBe('persisted');
  });
});

// ─── the disclosure collector ──────────────────────────────────────────────

describe('collectNotObservedDisclosures', () => {
  function ccPair(priorId: string, status: FindingStatus): ClassifiedPair {
    return {
      pair: { priorId, status: 'removed', confidence: 1, reasons: [] },
      classification: { status, blocks: false, warns: false, reasons: [] },
      kind: 'custom-check',
    };
  }

  it('groups by reason with counts, sorted largest first', () => {
    const entries = new Map<string, BaselineEntry>([
      ['p1', { id: 'p1', kind: 'custom-check', check: 'web-lint', blocking: false }],
      ['p2', { id: 'p2', kind: 'custom-check', check: 'web-lint', blocking: false }],
      ['p3', { id: 'p3', kind: 'custom-check', check: 'seam', blocking: true }],
      ['p4', { id: 'p4', kind: 'custom-check', check: 'observed-one', blocking: true }],
    ]);
    const reasons = new Map<string, string>([
      ['web-lint', 'check "web-lint" skipped (untrusted tree)'],
      ['seam', 'check "seam" skipped (timed out)'],
    ]);
    const disclosures = collectNotObservedDisclosures(
      [
        ccPair('p1', 'not_observed'),
        ccPair('p2', 'not_observed'),
        ccPair('p3', 'not_observed'),
        ccPair('p4', 'removed'), // observed check, really resolved — excluded
      ],
      entries,
      (e) => (e.kind === 'custom-check' && 'check' in e ? reasons.get(e.check) : undefined),
    );
    expect(disclosures).toEqual([
      { kind: 'custom-check', reason: 'check "web-lint" skipped (untrusted tree)', count: 2 },
      { kind: 'custom-check', reason: 'check "seam" skipped (timed out)', count: 1 },
    ]);
  });

  it('is empty when nothing was unobserved', () => {
    expect(collectNotObservedDisclosures([], new Map(), () => undefined)).toEqual([]);
  });
});

// ─── end-to-end: the shipped incident, in miniature ────────────────────────

describe('an untrusted check over a custom-check baseline (integration)', () => {
  let dir: string;
  let trusted: GuardrailCheckResult;
  let untrusted: GuardrailCheckResult;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-not-observed-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    // A miniature lint backlog: a check whose command always reports the same
    // two located findings, parsed by regex — the web-client shape at 1/9203
    // scale.
    writeFileSync(
      join(dir, 'lint.cjs'),
      // Fixture CONTENT, not test logging: the fake linter's stdout IS the
      // console.log output the regex parse extracts findings from.
      'console.log("src/a.js:1: no-unused-vars broken");\n' + // slop-ok
        'console.log("src/b.js:2: eqeqeq broken");\n' + // slop-ok
        'process.exit(1);\n',
    );
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit', 'policy.json'),
      JSON.stringify({
        checks: [
          {
            name: 'fake-lint',
            command: ['node', 'lint.cjs'],
            blocking: false,
            parse: { regex: '^(?<file>[^:]+):(?<line>\\d+): (?<rule>\\S+) (?<message>.*)$' },
          },
        ],
      }),
    );
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });

    // Trusted capture: the check RUNS, its two findings land in the baseline.
    await createBaseline({ cwd: dir });
    trusted = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });
    untrusted = await runGuardrailCheck({ trust: untrustedContentContext(), cwd: dir });
  }, 240_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the trusted control: pairs persist, nothing is unobserved, renderers stay silent', () => {
    const cc = trusted.pairs.filter((p) => p.kind === 'custom-check');
    expect(cc.length).toBe(2);
    for (const p of cc) expect(p.classification.status).toBe('persisted');
    expect(trusted.notObserved).toEqual([]);
    expect(renderConsole(trusted)).not.toContain('Not re-verified');
    expect(renderMarkdown(trusted)).not.toContain('not re-verified');
    expect(renderJson(trusted).summary.notObserved).toBe(0);
  });

  it('untrusted: zero removed custom-check pairs — the backlog is not_observed, not "resolved"', () => {
    const cc = untrusted.pairs.filter((p) => p.kind === 'custom-check');
    expect(cc.length).toBe(2);
    for (const p of cc) {
      expect(p.classification.status).toBe('not_observed');
      expect(p.classification.blocks).toBe(false);
      expect(p.classification.warns).toBe(false);
    }
    expect(cc.filter((p) => p.classification.status === ('removed' as FindingStatus))).toEqual([]);
  });

  it('the aggregate disclosure names the check, the cause, and the count', () => {
    expect(untrusted.notObserved.length).toBe(1);
    const d = untrusted.notObserved[0];
    expect(d.kind).toBe('custom-check');
    expect(d.count).toBe(2);
    expect(d.reason).toContain('fake-lint');
    expect(d.reason).toContain('untrusted');
  });

  it('the verdict is unchanged: an unobserved backlog neither blocks nor resolves', () => {
    const counts = verdictCounts(untrusted);
    expect(counts.exitCode).toBe(0);
    expect(counts.resolved).toBe(0);
  });

  it('console disclosure: one aggregate line, no per-finding table, no Resolved section', () => {
    const out = renderConsole(untrusted);
    expect(out).toContain('Not re-verified this run (2)');
    expect(out).toContain('fake-lint');
    expect(out).toContain('not observed, never as resolved');
    expect(out).not.toContain('Resolved (2)');
  });

  it('JSON disclosure: always-present field + summary counts', () => {
    const json = renderJson(untrusted);
    expect(json.summary.resolved).toBe(0);
    expect(json.summary.notObserved).toBe(2);
    expect(json.notObserved.length).toBe(1);
    expect(json.notObserved[0].count).toBe(2);
    // The pairs keep their per-finding statuses for machine consumers.
    expect(json.pairs.filter((p) => p.status === 'not_observed').length).toBe(2);
  });

  it('markdown disclosure: the PR comment says what was not looked at', () => {
    const md = renderMarkdown(untrusted);
    expect(md).toContain('not re-verified this run');
    expect(md).toContain('fake-lint');
    expect(md).not.toContain('Resolved (2)');
  });
});

// ─── the markdown Resolved row cap ─────────────────────────────────────────

describe('markdown Resolved table row cap', () => {
  it('caps rows and points at the full list (the 65,536-byte comment class)', async () => {
    // A synthetic result with a large genuinely-resolved set. Base fields come
    // from a minimal real run so the renderer sees a well-formed result.
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-resolved-cap-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
      writeFileSync(join(dir, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
      await createBaseline({ cwd: dir });
      const base = await runGuardrailCheck({ trust: trustedLocalContext(), cwd: dir });

      const resolvedPairs: ClassifiedPair[] = Array.from({ length: 150 }, (_, i) => ({
        pair: { priorId: `prior-${i}`, status: 'removed', confidence: 1, reasons: [] },
        classification: { status: 'removed', blocks: false, warns: false, reasons: [] },
        kind: 'custom-check',
        file: `src/file-${i}.js`,
        line: 1,
        locator: `src/file-${i}.js:1`,
      }));
      const md = renderMarkdown({ ...base, pairs: [...base.pairs, ...resolvedPairs] });
      expect(md).toContain('Resolved (150)');
      // 100 sample rows plus the pointer to the rest — never all 150.
      expect(md).toContain('src/file-99.js:1');
      expect(md).not.toContain('src/file-100.js:1');
      expect(md).toContain('50 more — full list in the job log or `--json`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
