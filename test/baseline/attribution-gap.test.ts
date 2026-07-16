/**
 * The attribution-gap contract (the won't-recur net for BLOCKER-1, 3.8).
 *
 * The class this pins: recall drift demotes `added` → `tooling_drift` (Rule 19,
 * correct), and the block-rule evaluator skips `tooling_drift` (also correct —
 * drift must never false-block) — so on any baseline with ABSENT recall (every
 * pre-Rule-19 baseline) all eight block rules were disarmed at once and a
 * net-new secret exited 0 under a PASSED banner. Proven on a real repo: 3.7.5
 * BLOCKED three live credentials that 3.8.0-rc.1 waved through. It is the
 * closed #20 config-drift bypass one status over.
 *
 * The fix is the third verdict dxkit already uses for the identity-scheme
 * mismatch: refuse. A drifted finding an armed block rule covers is recorded as
 * UNATTRIBUTABLE (`ClassifyResult.unattributableBlockRule`), aggregated into
 * `GuardrailCheckResult.attributionGaps` (a required field), and the one
 * verdict derivation (`verdictCounts` / `verdictWordFrom`) turns any gap into
 * `CANNOT GATE` + exit 1. PASSED is unconstructible over a gap.
 *
 * Both directions are pinned, because over-refusal is the failure that trains
 * users to ignore the signal: a clean tree under absent recall still PASSES
 * (nothing unanswerable was asked), and a drifted kind with no armed block rule
 * still demotes to a warning (the verified false-block prevention).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  collectAttributionGaps,
  describeAttributionGap,
  ATTRIBUTION_GAP_REMEDY,
} from '../../src/baseline/attribution-gap';
import type { RecallDrift } from '../../src/baseline/recall';
import { verdictWordFrom, verdictCounts } from '../../src/baseline/check-renderers';
import { renderConsole, renderJson, renderMarkdown } from '../../src/baseline/check-renderers';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck } from '../../src/baseline/check';
import { findTool, TOOL_DEFS } from '../../src/analyzers/tools/tool-registry';

// The two end-to-end tests below drive a REAL secret scan of a fixture repo, so
// they need a secret scanner present. dxkit's grep fallback only emits its
// branded (AWS-shaped) rules when gitleaks is absent, and those do not flow into
// the security aggregate the guardrail reads — so without the gitleaks binary
// the fixture secret is never seen and the test would false-fail. The unit-
// coverage CI job has no scanner installed; the self-guardrail job (which runs
// `tools install`) and local dev do. Skip when gitleaks is unavailable rather
// than assert against an environment that cannot produce the finding — the
// refusal LOGIC is proven binary-free by `policy.test.ts` and the
// `collectAttributionGaps` / `verdictWordFrom` unit tests above.
const gitleaksAvailable = findTool(TOOL_DEFS.gitleaks, process.cwd()).available;

// ─── The pure collector ─────────────────────────────────────────────────────

const SECRET_DRIFT: RecallDrift = {
  kind: 'secret',
  reason: 'absent-from-baseline',
  changed: [],
};

function gapPair(kind: string, rule?: string, suppressed = false) {
  return {
    kind,
    classification: rule !== undefined ? { unattributableBlockRule: rule } : {},
    ...(suppressed ? { suppressedByAllowlist: { fingerprint: 'x', category: 'reviewed' } } : {}),
  };
}

describe('collectAttributionGaps', () => {
  it('groups unattributable pairs per kind with sorted, deduped rules and drift evidence', () => {
    const gaps = collectAttributionGaps(
      [
        gapPair('secret', 'newSecret'),
        gapPair('secret', 'newSecret'),
        gapPair('code', 'newHighSecurity'),
        gapPair('code', 'newCriticalSecurity'),
        gapPair('custom-check'), // demoted but no block rule → not a gap
      ],
      [SECRET_DRIFT],
    );
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({
      kind: 'code',
      rules: ['newCriticalSecurity', 'newHighSecurity'],
      findingCount: 2,
    });
    expect(gaps[1]).toMatchObject({ kind: 'secret', rules: ['newSecret'], findingCount: 2 });
    expect(gaps[1].drift).toEqual(SECRET_DRIFT);
  });

  it('an allowlist-suppressed finding never contributes a gap (reviewed = answered)', () => {
    const gaps = collectAttributionGaps([gapPair('secret', 'newSecret', true)], [SECRET_DRIFT]);
    expect(gaps).toEqual([]);
  });

  it('describeAttributionGap names the count, the rule, and the evidence', () => {
    const [gap] = collectAttributionGaps([gapPair('secret', 'newSecret')], [SECRET_DRIFT]);
    const prose = describeAttributionGap(gap);
    expect(prose).toContain('newSecret');
    expect(prose).toContain('secret');
    expect(prose).toContain('cannot');
  });
});

// ─── The one verdict derivation ─────────────────────────────────────────────

describe('verdictWordFrom — PASSED is unconstructible over a gap', () => {
  it('any unattributable finding forces CANNOT GATE + exit 1', () => {
    expect(verdictWordFrom({ blocks: false, warns: false, unattributable: 1 })).toEqual({
      verdict: 'CANNOT GATE',
      exitCode: 1,
    });
    expect(verdictWordFrom({ blocks: false, warns: true, unattributable: 3 })).toEqual({
      verdict: 'CANNOT GATE',
      exitCode: 1,
    });
  });

  it('a definite regression outranks a refusal (both exit 1)', () => {
    expect(verdictWordFrom({ blocks: true, warns: false, unattributable: 5 })).toEqual({
      verdict: 'BLOCKED',
      exitCode: 1,
    });
  });

  it('no gap → the familiar tiers', () => {
    expect(verdictWordFrom({ blocks: false, warns: false, unattributable: 0 }).verdict).toBe(
      'PASSED',
    );
    expect(verdictWordFrom({ blocks: false, warns: true, unattributable: 0 }).verdict).toBe(
      'PASSED (with warnings)',
    );
    expect(verdictWordFrom({ blocks: false, warns: false, unattributable: 0 }).exitCode).toBe(0);
  });
});

// ─── End-to-end: the BLOCKER-1 A/B, in-suite ────────────────────────────────

/** A synthetic AWS-shaped access key gitleaks flags deterministically (its
 *  `aws-access-token` rule; the placeholder filter does not suppress it). Not a
 *  real credential. The two tests that write it are gated on `gitleaksAvailable`
 *  above — dxkit's grep fallback recognizes the shape but its branded findings
 *  do not reach the security aggregate the guardrail reads. */
const FAKE_AWS_KEY = 'AKIAQ3EGRIJ7MZ4KX2B6';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-attrgap-'));
  tmps.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

/** Rewrite the committed baseline WITHOUT its `recall` field — exactly what
 *  every baseline written before Rule 19 looks like on upgrade day. */
function stripRecall(dir: string): void {
  const p = join(dir, '.dxkit', 'baselines', 'main.json');
  const file = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  delete file.recall;
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n');
}

function addSecret(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'config.js'),
    `const key = '${FAKE_AWS_KEY}';\nmodule.exports = key;\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add config'], { cwd: dir });
  // No ad-hoc memo clears needed: every fresh analysis resets the
  // process-lifetime per-cwd memos itself (resetAnalysisMemos at
  // gatherAnalysisResultBody), so an in-process re-scan of a changed
  // tree sees the new state. This test relying on that IS the coverage.
}

describe('runGuardrailCheck — a net-new secret under absent recall CANNOT pass (BLOCKER-1)', () => {
  it.skipIf(!gitleaksAvailable)(
    'recall present: the net-new secret BLOCKS (the 3.7.5 behavior, preserved)',
    async () => {
      const dir = makeRepo();
      await createBaseline({ cwd: dir });
      addSecret(dir);
      const result = await runGuardrailCheck({ cwd: dir });
      const secretPairs = result.pairs.filter(
        (p) => p.kind === 'secret' && p.classification.status === 'added',
      );
      expect(secretPairs.length).toBeGreaterThan(0);
      expect(secretPairs.some((p) => p.classification.blocks)).toBe(true);
      expect(verdictCounts(result).verdict).toBe('BLOCKED');
      expect(verdictCounts(result).exitCode).toBe(1);
    },
    120_000,
  );

  it.skipIf(!gitleaksAvailable)(
    'recall ABSENT (pre-Rule-19 baseline): the same secret yields CANNOT GATE, exit 1 — never PASSED',
    async () => {
      const dir = makeRepo();
      await createBaseline({ cwd: dir });
      stripRecall(dir);
      addSecret(dir);
      const result = await runGuardrailCheck({ cwd: dir });

      // The demotion happened (drift is real — blocking would misattribute) …
      const secretPairs = result.pairs.filter((p) => p.kind === 'secret');
      expect(secretPairs.some((p) => p.classification.status === 'tooling_drift')).toBe(true);
      expect(result.blocks).toBe(false);
      // … but the disarmed rule is recorded and the verdict refuses.
      expect(
        secretPairs.some((p) => p.classification.unattributableBlockRule === 'newSecret'),
      ).toBe(true);
      expect(result.attributionGaps.some((g) => g.kind === 'secret')).toBe(true);
      const counts = verdictCounts(result);
      expect(counts.verdict).toBe('CANNOT GATE');
      expect(counts.exitCode).toBe(1);

      // Every surface says so — nothing prints PASSED over the gap.
      const consoleOut = renderConsole(result);
      expect(consoleOut).toContain('CANNOT GATE');
      expect(consoleOut).toContain('Cannot attribute');
      expect(consoleOut).toContain(ATTRIBUTION_GAP_REMEDY.slice(0, 30));
      const json = renderJson(result);
      expect(json.verdict.refused).toBe(true);
      expect(json.verdict.exitCode).toBe(1);
      expect(json.attributionGaps.length).toBeGreaterThan(0);
      const md = renderMarkdown(result);
      expect(md).toContain('## Guardrail: CANNOT GATE');
      expect(md).not.toContain('## Guardrail: PASSED');
    },
    120_000,
  );

  it('recall ABSENT but the tree is CLEAN: still PASSES (no unanswerable question was asked)', async () => {
    // The other half of the design: refusal fires only when a block-rule-class
    // finding actually needs attribution. A clean repo upgrading to 3.8 must
    // not be hard-stopped — its drift is disclosed as warnings, not a refusal.
    const dir = makeRepo();
    await createBaseline({ cwd: dir });
    stripRecall(dir);
    const result = await runGuardrailCheck({ cwd: dir });
    expect(result.attributionGaps).toEqual([]);
    const counts = verdictCounts(result);
    expect(counts.exitCode).toBe(0);
    expect(counts.verdict).not.toBe('CANNOT GATE');
  }, 120_000);
});
