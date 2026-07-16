import { describe, it, expect } from 'vitest';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import { classify, classifyAll } from '../../src/baseline/classify';
import { verdictWordFrom } from '../../src/baseline/check-renderers';
import type { BrownfieldPolicy } from '../../src/baseline/policy';
import type { ClassifyContext } from '../../src/baseline/classify';
import type { MatchPair } from '../../src/baseline/types';

function pair(
  status: MatchPair['status'],
  confidence = 1.0,
  reasons: MatchPair['reasons'] = [{ code: 'exact-id', detail: 'unit-test stub' }],
): MatchPair {
  return {
    priorId: status === 'added' ? undefined : 'prior-id-0000',
    currentId: status === 'removed' ? undefined : 'current-id-0000',
    status,
    confidence,
    reasons,
  };
}

describe('classify — direct pass-through for matcher statuses', () => {
  it('passes persisted through with no policy escalation', () => {
    const result = classify(pair('persisted'));
    expect(result.status).toBe('persisted');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(false);
  });

  it('passes relocated through similarly', () => {
    const result = classify(pair('relocated', 0.95));
    expect(result.status).toBe('relocated');
    expect(result.blocks).toBe(false);
  });

  it('passes removed through; default policy neither blocks nor warns', () => {
    const result = classify(pair('removed'));
    expect(result.status).toBe('removed');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(false);
  });

  it('blocks added by default per the brownfield policy', () => {
    const result = classify(pair('added'));
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(true);
    expect(result.warns).toBe(false);
  });
});

describe('classify — drift context reclassifies added', () => {
  it('reclassifies added → tooling_drift when scanner version differs', () => {
    const ctx: ClassifyContext = { recallDrifted: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('tooling_drift');
    expect(result.blocks).toBe(false); // tooling_drift is in warn, not block
    expect(result.warns).toBe(true);
    expect(result.reasons.some((r) => r.code === 'tooling-drift')).toBe(true);
  });

  it('reclassifies added → config_drift when only the config differs', () => {
    const ctx: ClassifyContext = { configDiffers: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('config_drift');
    expect(result.warns).toBe(true);
    expect(result.reasons.some((r) => r.code === 'config-drift')).toBe(true);
  });

  it('scanner-version drift wins over config drift when both are present', () => {
    const ctx: ClassifyContext = { recallDrifted: true, configDiffers: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('tooling_drift');
  });

  it('a finding on a diff-changed file stays added, not config_drift (#19 misattribution)', () => {
    // The developer edited policy.json AND added a new file with a finding on it.
    // config drift explains findings that appear WITHOUT a code change; a finding
    // on the file the diff itself added is developer-introduced → `added`.
    const ctx: ClassifyContext = { configDiffers: true, fileChangedInDiff: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('added');
    expect(result.reasons.some((r) => r.code === 'config-drift')).toBe(false);
  });

  it('config_drift still applies to a finding NOT on a diff-changed file', () => {
    // A path the policy newly un-ignored surfaces a finding with no code change.
    const ctx: ClassifyContext = { configDiffers: true, fileChangedInDiff: false };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('config_drift');
  });

  it('names the gate-just-enabled cause over generic config_drift (gh #157)', () => {
    // The kind had no baseline entries → a gate/dimension was newly enabled, so
    // its whole pre-existing backlog reads as net-new. That is a truer reason
    // than "policy config changed" — but the VERDICT must be unchanged.
    const ctx: ClassifyContext = { configDiffers: true, kindAbsentFromBaseline: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('config_drift'); // verdict-bearing status unchanged
    expect(result.warns).toBe(true);
    expect(result.reasons.some((r) => r.code === 'dimension-newly-measured')).toBe(true);
    // The misleading generic reason is NOT emitted for this case.
    expect(result.reasons.some((r) => r.code === 'config-drift')).toBe(false);
  });

  it('generic config_drift reason no longer over-claims a specific cause (gh #157)', () => {
    const ctx: ClassifyContext = { configDiffers: true, kindAbsentFromBaseline: false };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.reasons.some((r) => r.code === 'config-drift')).toBe(true);
    const drift = result.reasons.find((r) => r.code === 'config-drift');
    // No longer asserts "suppression or policy config changed" as THE cause.
    expect(drift?.detail).not.toContain('suppression or policy config changed');
    expect(drift?.detail).toContain('envelope change');
  });

  it('gate-just-enabled does NOT weaken a net-new secret block (verdict preserved, gh #157)', () => {
    // A secret whose kind was absent from the baseline + config drift: the reason
    // is refined, but the block-rule must still fire (config_drift is block-rule
    // eligible), so the net-new secret still blocks.
    const ctx: ClassifyContext = {
      configDiffers: true,
      kindAbsentFromBaseline: true,
      kind: 'secret',
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.blocks).toBe(true);
  });

  it('does not reclassify persisted on drift signals', () => {
    const ctx: ClassifyContext = { recallDrifted: true };
    const result = classify(pair('persisted'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('persisted');
  });
});

describe('classify — confidence demotion', () => {
  it('demotes relocated → uncertain when confidence is below the severity threshold', () => {
    const ctx: ClassifyContext = { severity: 'critical' };
    // critical threshold is 0.75; confidence 0.60 is below.
    const result = classify(pair('relocated', 0.6), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('uncertain');
    expect(result.warns).toBe(true);
    expect(result.reasons.some((r) => r.code === 'low-confidence')).toBe(true);
  });

  it('keeps relocated when confidence meets the threshold', () => {
    const ctx: ClassifyContext = { severity: 'critical' };
    const result = classify(pair('relocated', 0.95), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('relocated');
  });

  it('uses the strictest threshold when severity is unspecified', () => {
    // confidence 0.85 would pass for critical (0.75) but fail for low (0.90).
    // No severity → strictest (lowest threshold value win? actually our impl
    // uses Math.min of values = strictest demotion behavior. 0.85 < 0.90 = uncertain.
    const result = classify(pair('relocated', 0.85));
    // policy.confidence has critical=0.75, high=0.80, medium=0.85, low=0.90.
    // Math.min picks 0.75 (the lowest threshold). 0.85 >= 0.75 → no demotion.
    // Wait, that's the opposite of "strictest." Re-read the policy.
    // Threshold means "confidence must be >= threshold to count as persisted/relocated."
    // Lower threshold means more lenient, higher threshold more strict.
    // Math.min(thresholds) = most lenient. So no severity → most lenient.
    // 0.85 >= 0.75 → kept as relocated.
    expect(result.status).toBe('relocated');
  });
});

describe('classify — block-rule overrides', () => {
  it('blocks a newly-introduced secret unconditionally per the default rule', () => {
    const ctx: ClassifyContext = { kind: 'secret' };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(true);
    expect(result.reasons.some((r) => r.detail.includes('newSecret'))).toBe(true);
  });

  it('does not block when scanner-version drift reclassifies a secret away from added — but records the disarmed rule', () => {
    const ctx: ClassifyContext = { kind: 'secret', recallDrifted: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('tooling_drift');
    expect(result.blocks).toBe(false); // drift never blocks (Rule 19) …
    // … but it never silently passes either: the disarmed rule is recorded, and
    // the verdict layer refuses to print PASSED while this value exists.
    expect(result.unattributableBlockRule).toBe('newSecret');
  });

  it('tooling drift does NOT weaken a net-new secret block into a silent pass (BLOCKER-1, the #20 bypass one status over)', () => {
    // The exact shape that shipped: recall=ABSENT on every pre-Rule-19 baseline
    // drifts `secret` → tooling_drift → classify's block-rule step used to skip
    // it entirely → all 8 block rules disarmed → three live credentials exited 0
    // under a PASSED banner. The classification can neither block (drift is real
    // evidence of another cause) nor pass — it must surface the third answer.
    const ctx: ClassifyContext = {
      recallDrifted: true,
      kindAbsentFromBaseline: true,
      kind: 'secret',
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.unattributableBlockRule).toBe('newSecret');
    expect(result.reasons.some((r) => r.code === 'unattributable-block-rule')).toBe(true);
    // And the verdict derivation refuses to pass over it:
    const word = verdictWordFrom({ blocks: false, warns: true, unattributable: 1 });
    expect(word.verdict).toBe('CANNOT GATE');
    expect(word.exitCode).toBe(1);
  });

  it('a drifted kind with NO armed block rule stays a plain warning (the false-block prevention survives)', () => {
    // The verified-desirable half of Rule 19: a one-byte lint-config change
    // demoted the lint findings to warn — that must keep working. custom-check
    // carries no block rule, so no refusal fires.
    const ctx: ClassifyContext = { kind: 'custom-check', recallDrifted: true };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('tooling_drift');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(true);
    expect(result.unattributableBlockRule).toBeUndefined();
  });

  it('a DISARMED block rule produces no refusal (the policy owner opted out)', () => {
    const noSecretRule: BrownfieldPolicy = {
      ...DEFAULT_BROWNFIELD_POLICY,
      blockRules: { ...DEFAULT_BROWNFIELD_POLICY.blockRules, newSecret: false },
    };
    const ctx: ClassifyContext = { kind: 'secret', recallDrifted: true };
    const result = classify(pair('added'), noSecretRule, ctx);
    expect(result.status).toBe('tooling_drift');
    expect(result.unattributableBlockRule).toBeUndefined();
  });

  it('a drifted code finding refuses only at the severities its block rules cover', () => {
    const critical: ClassifyContext = { kind: 'code', severity: 'critical', recallDrifted: true };
    const medium: ClassifyContext = { kind: 'code', severity: 'medium', recallDrifted: true };
    expect(
      classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, critical).unattributableBlockRule,
    ).toBe('newCriticalSecurity');
    expect(
      classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, medium).unattributableBlockRule,
    ).toBeUndefined();
  });

  it('a config-drift-demoted secret STILL blocks — config drift never disables a security block-rule (#20)', () => {
    // A net-new secret on an UNCHANGED file surfaced alongside a policy.json edit
    // (configDiffers, not a diff-changed file so #86 doesn't already keep it
    // `added`). config drift creates no phantom secrets, so the block-rule must
    // still fire — only the reason string reflects the drift, never the verdict.
    const ctx: ClassifyContext = { kind: 'secret', configDiffers: true, fileChangedInDiff: false };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('config_drift'); // reason still reflects the drift
    expect(result.blocks).toBe(true); // ...but it BLOCKS — the #20 bypass is closed
    expect(result.reasons.some((r) => r.detail.includes('newSecret'))).toBe(true);
  });

  it('blocks a new high-reachable dep-vuln but not a non-reachable one', () => {
    const reachable: ClassifyContext = {
      kind: 'dep-vuln',
      severity: 'high',
      reachable: true,
    };
    const nonReachable: ClassifyContext = {
      kind: 'dep-vuln',
      severity: 'high',
      reachable: false,
    };
    const result1 = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, reachable);
    const result2 = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, nonReachable);
    // Reachable triggers newHighReachableDependencyVulnerability; non-reachable
    // still triggers the generic 'added' block from the default policy.
    expect(result1.blocks).toBe(true);
    expect(
      result1.reasons.some((r) => r.detail.includes('newHighReachableDependencyVulnerability')),
    ).toBe(true);
    // The non-reachable case is still blocked by the generic 'added' policy
    // (which is intentional — Phase 3 may relax this once unreachable dep-vuln
    // policy is configurable), but no rule fires.
    expect(result2.blocks).toBe(true);
    expect(result2.reasons.some((r) => r.code === 'block-rule')).toBe(false);
  });

  it('blocks a new malicious dependency at ANY severity (the supply-chain rule)', () => {
    // The July 2025 eslint-config-prettier compromise shipped as severity
    // HIGH — below the critical rule, unreachable by the reachability rule
    // (never populated on the check path). The malicious rule fires on the
    // advisory class alone.
    for (const severity of ['high', 'medium', 'low'] as const) {
      const ctx: ClassifyContext = { kind: 'dep-vuln', severity, malicious: true };
      const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
      expect(result.blocks).toBe(true);
      expect(result.reasons.some((r) => r.detail.includes('newMaliciousDependency'))).toBe(true);
    }
  });

  it('the malicious rule never fires for non-malicious dep-vulns or persisted pairs', () => {
    const nonMalicious: ClassifyContext = { kind: 'dep-vuln', severity: 'high' };
    const r1 = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, nonMalicious);
    expect(r1.reasons.some((r) => r.detail.includes('newMaliciousDependency'))).toBe(false);

    // Baseline-relative: a grandfathered malicious advisory (already in the
    // baseline) is debt to pay down, not a net-new block.
    const persisted: ClassifyContext = { kind: 'dep-vuln', severity: 'high', malicious: true };
    const r2 = classify(pair('persisted'), DEFAULT_BROWNFIELD_POLICY, persisted);
    expect(r2.blocks).toBe(false);
  });

  it('blocks a new untested file overlapping changed lines', () => {
    const ctx: ClassifyContext = {
      kind: 'test-gap',
      overlapsChangedLines: true,
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.blocks).toBe(true);
    expect(result.reasons.some((r) => r.detail.includes('newUntestedChangedSource'))).toBe(true);
  });

  it('block-rule does not fire for the same kind outside changed lines', () => {
    const ctx: ClassifyContext = {
      kind: 'test-gap',
      overlapsChangedLines: false,
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.reasons.some((r) => r.code === 'block-rule')).toBe(false);
  });
});

describe('classify — wobble demotion via addedRequiresChangedLines', () => {
  it('demotes an added code finding to uncertain when outside changed lines', () => {
    // Semgrep on a large codebase occasionally finds different
    // subsets each run. An added finding the diff didn't touch is
    // a baseline gap, not a developer-introduced regression — demote
    // to uncertain (warn) so guardrail stays trustworthy.
    const ctx: ClassifyContext = {
      kind: 'code',
      severity: 'medium',
      overlapsChangedLines: false,
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('uncertain');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(true);
    expect(result.reasons.some((r) => r.code === 'unchanged-lines')).toBe(true);
  });

  it('still blocks added code findings that DO overlap changed lines', () => {
    // The developer actually wrote code on these lines — block.
    const ctx: ClassifyContext = {
      kind: 'code',
      severity: 'medium',
      overlapsChangedLines: true,
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(true);
  });

  it('does not demote when overlapsChangedLines is undefined (no diff context)', () => {
    // Local hook context without a base-ref to diff against — fall
    // back to blocking (status quo).
    const ctx: ClassifyContext = {
      kind: 'code',
      severity: 'medium',
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(true);
  });

  it('does not demote kinds outside addedRequiresChangedLines', () => {
    // Secrets stay block-on-add regardless of diff overlap — even
    // a pre-existing secret that wasn't in the baseline should
    // block (rotate the credential, then unblock).
    const ctx: ClassifyContext = {
      kind: 'secret',
      severity: 'high',
      overlapsChangedLines: false,
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(true);
  });

  it('respects a custom addedRequiresChangedLines list', () => {
    // Customer who wants stricter behavior can clear the list and
    // block on every added finding regardless of diff overlap.
    const strict: BrownfieldPolicy = {
      ...DEFAULT_BROWNFIELD_POLICY,
      addedRequiresChangedLines: [],
    };
    const ctx: ClassifyContext = {
      kind: 'code',
      severity: 'medium',
      overlapsChangedLines: false,
    };
    const result = classify(pair('added'), strict, ctx);
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(true);
  });

  it('scanner-version drift wins over wobble demotion', () => {
    // Tooling drift is the more specific signal — when both apply,
    // classify as tooling_drift not uncertain.
    const ctx: ClassifyContext = {
      kind: 'code',
      severity: 'medium',
      overlapsChangedLines: false,
      recallDrifted: true,
    };
    const result = classify(pair('added'), DEFAULT_BROWNFIELD_POLICY, ctx);
    expect(result.status).toBe('tooling_drift');
  });
});

describe('classify — custom policy', () => {
  it('respects a permissive policy that blocks nothing', () => {
    const permissive: BrownfieldPolicy = {
      mode: 'brownfield',
      block: [],
      warn: ['added', 'tooling_drift', 'config_drift'],
      confidence: { critical: 0.5, high: 0.5, medium: 0.5, low: 0.5 },
      blockRules: {},
      addedRequiresChangedLines: [],
    };
    const result = classify(pair('added'), permissive);
    expect(result.status).toBe('added');
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(true);
  });
});

describe('classifyAll — bulk classification preserves order', () => {
  it('returns one ClassifyResult per input pair, aligned by index', () => {
    const pairs: MatchPair[] = [
      pair('persisted'),
      pair('added'),
      pair('removed'),
      pair('relocated', 0.9),
    ];
    const results = classifyAll(pairs);
    expect(results).toHaveLength(4);
    expect(results[0].status).toBe('persisted');
    expect(results[1].status).toBe('added');
    expect(results[1].blocks).toBe(true);
    expect(results[2].status).toBe('removed');
    expect(results[3].status).toBe('relocated');
  });

  it('threads per-pair context via the callback', () => {
    const pairs: MatchPair[] = [pair('added'), pair('added')];
    const results = classifyAll(pairs, DEFAULT_BROWNFIELD_POLICY, (_p) => ({
      recallDrifted: true,
    }));
    expect(results.every((r) => r.status === 'tooling_drift')).toBe(true);
  });
});
