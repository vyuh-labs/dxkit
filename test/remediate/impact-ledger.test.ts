/**
 * The remediate ledger's Impact line (impact surface phase 1): the impact
 * summary computed by the lane's guardrail run travels the whole threading
 * (`GuardrailGateResult.impact` -> `verificationDisclosures` ->
 * `RemediateResult.guardrailImpact` -> the ledger's shared verdict
 * composer), and a result without one renders exactly what it always did.
 */

import { describe, it, expect } from 'vitest';
import { renderRemediateLedger } from '../../src/remediate/ledger-render';
import { verificationDisclosures } from '../../src/remediate/verify';
import type { GuardrailGateResult } from '../../src/lanes/verify';
import type { VerifyTreeResult } from '../../src/lanes/verify-tree';
import type { ImpactSummary } from '../../src/baseline/impact';

const IMPACT: ImpactSummary = {
  attributable: true,
  resolved: 2,
  resolvedByKind: [{ kind: 'dep-vuln', count: 2, bySeverity: [{ severity: 'high', count: 2 }] }],
  added: 0,
  net: 2,
  excluded: [],
  capNotes: [],
};

describe('verificationDisclosures forwards the guardrail impact', () => {
  const verified = { verdict: 'verified', changedFiles: ['a.ts'] } as unknown as VerifyTreeResult;

  it('an impact-bearing gate result reaches the disclosure projection', () => {
    const gate: GuardrailGateResult = {
      verdict: 'PASSED',
      ran: true,
      passesGate: true,
      impact: IMPACT,
    };
    const disclosures = verificationDisclosures(verified, gate);
    expect(disclosures.guardrailImpact).toEqual(IMPACT);
    expect(disclosures.guardrailVerdict).toBe('PASSED');
  });

  it('a gate that never ran carries no impact (a delta nobody measured is not claimed)', () => {
    const gate: GuardrailGateResult = {
      verdict: 'unavailable (boom)',
      ran: false,
      passesGate: false,
    };
    expect('guardrailImpact' in verificationDisclosures(verified, gate)).toBe(false);
  });
});

describe('the remediate ledger renders the impact beside the verdict', () => {
  it('with an impact: the headline rides the guardrail line', () => {
    const ledger = renderRemediateLedger({
      outcome: 'verified',
      task: 'fix-vulns',
      guardrailVerdict: 'PASSED',
      guardrailImpact: IMPACT,
    });
    expect(ledger).toContain('Guardrail: **PASSED**');
    expect(ledger).toContain(
      'Impact: -2 findings resolved (dep-vuln: 2 high) · +0 added by this change',
    );
  });

  it('without an impact: the verdict line renders alone (backward compatible)', () => {
    const ledger = renderRemediateLedger({
      outcome: 'verified',
      task: 'fix-vulns',
      guardrailVerdict: 'PASSED',
    });
    expect(ledger).toContain('Guardrail: **PASSED**');
    expect(ledger).not.toContain('Impact:');
  });
});
