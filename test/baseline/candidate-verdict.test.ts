/**
 * The ONE candidate-verdict predicate (4.4.8, #371): the remediation
 * recipes' pre-checks ask "would the guardrail block this dep-vuln as
 * `added`?" through the guardrail's own classifier, never a severity table.
 * Pinned here: the verdict follows the policy's generic block list AND its
 * armed block rules (both directions), `newAdvisories.blockSeverities` is
 * a different knob that cannot disarm it, and the reason chain a ledger
 * renders names the rule that fired.
 */
import { describe, it, expect } from 'vitest';
import { addedDepVulnVerdict, wouldBlockAddedDepVuln } from '../../src/baseline/candidate-verdict';
import { classify } from '../../src/baseline/classify';
import { DEFAULT_BROWNFIELD_POLICY, type BrownfieldPolicy } from '../../src/baseline/policy';
import { policyForPreset } from '../../src/baseline/presets';

const SECURITY_ONLY: BrownfieldPolicy = policyForPreset(
  'security-only',
  DEFAULT_BROWNFIELD_POLICY,
).policy;
const FULL_DEBT: BrownfieldPolicy = policyForPreset('full-debt', DEFAULT_BROWNFIELD_POLICY).policy;

describe('addedDepVulnVerdict (the guardrail block predicate for a candidate dep-vuln)', () => {
  it('default policy: every added dep-vuln blocks, whatever its severity (including unknown)', () => {
    for (const severity of ['critical', 'high', 'medium', 'low', undefined] as const) {
      const verdict = addedDepVulnVerdict(DEFAULT_BROWNFIELD_POLICY, { severity });
      expect(verdict.status).toBe('added');
      expect(verdict.blocks).toBe(true);
    }
  });

  it('security-only: only the armed rules block; the rest warn, never silently pass', () => {
    // Critical: the newCriticalDependencyVulnerability rule.
    const critical = addedDepVulnVerdict(SECURITY_ONLY, { severity: 'critical' });
    expect(critical.blocks).toBe(true);
    expect(critical.reasons.map((r) => r.detail).join(' ')).toContain(
      'newCriticalDependencyVulnerability',
    );
    // High needs reachability for its rule.
    expect(wouldBlockAddedDepVuln(SECURITY_ONLY, { severity: 'high' })).toBe(false);
    expect(wouldBlockAddedDepVuln(SECURITY_ONLY, { severity: 'high', reachable: true })).toBe(true);
    // Medium / low: warn only (the preset adds `added` to warn).
    for (const severity of ['medium', 'low'] as const) {
      const v = addedDepVulnVerdict(SECURITY_ONLY, { severity });
      expect(v.blocks).toBe(false);
      expect(v.warns).toBe(true);
    }
    // Malicious blocks at any severity, tier-exempt.
    expect(wouldBlockAddedDepVuln(SECURITY_ONLY, { severity: 'low', malicious: true })).toBe(true);
  });

  it('full-debt: the generic added block covers every candidate', () => {
    expect(wouldBlockAddedDepVuln(FULL_DEBT, { severity: 'low' })).toBe(true);
  });

  it('newAdvisories.blockSeverities is a DIFFERENT knob: [] cannot disarm the added verdict', () => {
    const disarmedTier: BrownfieldPolicy = {
      ...DEFAULT_BROWNFIELD_POLICY,
      newAdvisories: { blockSeverities: [] },
    };
    expect(wouldBlockAddedDepVuln(disarmedTier, { severity: 'high' })).toBe(true);
    // And the inverse: widening the tier does not arm what the policy leaves unarmed.
    const widenedTier: BrownfieldPolicy = {
      ...SECURITY_ONLY,
      newAdvisories: { blockSeverities: ['critical', 'high', 'medium', 'low'] },
    };
    expect(wouldBlockAddedDepVuln(widenedTier, { severity: 'medium' })).toBe(false);
  });

  it('is the classifier itself, not a projection: a policy edit reaches it with no table to update', () => {
    // Disarm the one rule that would fire; the verdict follows.
    const noCriticalRule: BrownfieldPolicy = {
      ...SECURITY_ONLY,
      blockRules: { ...SECURITY_ONLY.blockRules, newCriticalDependencyVulnerability: false },
    };
    expect(wouldBlockAddedDepVuln(noCriticalRule, { severity: 'critical' })).toBe(false);
    // Reference parity with a direct classify call over the same synthetic pair.
    const direct = classify({ status: 'added', confidence: 1, reasons: [] }, noCriticalRule, {
      kind: 'dep-vuln',
      severity: 'critical',
      fileChangedInDiff: true,
    });
    expect(addedDepVulnVerdict(noCriticalRule, { severity: 'critical' })).toEqual(direct);
  });
});
