import { describe, it, expect } from 'vitest';
import { buildEvidenceDoc, type EvaluateRunEvidence } from '../../src/evaluate/evidence';
import { redactEvidence } from '../../src/evaluate/redact';
import { headline, renderEvaluateText } from '../../src/evaluate/render';
import { fakePayload, fakeRun } from './evidence.test';

function docWith(runs: EvaluateRunEvidence[], ref = 'HEAD') {
  return buildEvidenceDoc({
    branch: 'main',
    ref,
    preset: 'security-only',
    presetSource: 'default',
    policyBase: 'defaults',
    incremental: true,
    untrusted: false,
    runs,
  });
}

describe('renderEvaluateText — the clean replay is a first-class result', () => {
  it('carries the trust framing, the watched summary, the costs, and the demo handoff', () => {
    const doc = docWith([fakeRun(), fakeRun({ label: '#2' })]);
    const text = renderEvaluateText(doc);
    expect(text).toContain('None of your last 2 landings would have been blocked.');
    // Grandfathered framing from the base-side findings count (fakePayload: 3).
    expect(text).toContain('3 pre-existing findings');
    expect(text).toContain('grandfathered');
    // Watched honesty.
    expect(text).toContain('scanners ran: gitleaks');
    // Costs are measured, present, and reversibility is stated.
    expect(text).toContain('What enabling dxkit costs');
    expect(text).toContain('interruptions: none across the 2 evaluated landings');
    expect(text).toContain('uninstall');
    // The clean path hands off to the seeded demo, then init.
    expect(text).toContain('demo loop-guardrail');
    expect(text).toContain('npm init @vyuhlabs/dxkit');
    // The zero-write line closes every report.
    expect(text.trim().endsWith('Nothing was written to your repo.')).toBe(true);
  });

  it('renders blocked landings with their net-new kinds and skips the demo handoff', () => {
    const doc = docWith([
      fakeRun({
        label: '#7',
        subject: 'feat: add auth',
        verdict: { blocks: true, warns: false },
        blocking: [
          { kind: 'secret', severity: 'high' },
          { kind: 'secret', severity: 'high' },
          { kind: 'dep-vuln', severity: 'critical' },
        ],
      }),
      fakeRun({ label: '#8' }),
    ]);
    const text = renderEvaluateText(doc);
    expect(text).toContain('dxkit would have blocked 1 of your last 2 landings.');
    expect(text).toContain('BLOCKED  #7');
    expect(text).toContain('net-new: secret high ×2, dep-vuln critical');
    expect(text).not.toContain('demo loop-guardrail');
    expect(text).toContain('Nothing was written to your repo.');
  });

  it('reports missing scanners as unwatched classes, not silently', () => {
    const doc = docWith([
      fakeRun({
        coverage: {
          scanners: [
            { tool: 'gitleaks', available: false, source: 'missing' },
            { tool: 'semgrep', available: true, source: 'path' },
          ],
        },
      }),
    ]);
    expect(renderEvaluateText(doc)).toContain('scanners missing on this machine');
  });

  it('headline handles the explicit-range mode', () => {
    const doc = docWith([fakeRun()], 'origin/main~5..origin/main');
    expect(headline(doc)).toBe('dxkit would not have blocked this range.');
  });
});

describe('redactEvidence', () => {
  it('strips file/line from blocking entries and the embedded payload, and says so', () => {
    const payload = fakePayload(1);
    const run = fakeRun({
      verdict: { blocks: true, warns: false },
      blocking: [{ kind: 'secret', file: 'src/config.ts', line: 12 }],
      guardrail: {
        ...payload,
        pairs: [
          {
            status: 'added',
            blocks: true,
            warns: false,
            confidence: 1,
            kind: 'secret',
            file: 'src/config.ts',
            line: 12,
            reasons: [],
          },
        ],
      } as typeof payload,
    });
    const redacted = redactEvidence(docWith([run]));
    const r = redacted.runs[0];
    expect(r.blocking[0]).toEqual({ kind: 'secret', severity: undefined });
    expect(r.guardrail?.pairs[0].file).toBeUndefined();
    expect(r.guardrail?.pairs[0].line).toBeUndefined();
    expect(r.guardrail?.pairs[0].kind).toBe('secret'); // signal preserved
    expect(redacted.notes.some((n) => n.includes('Redacted for sharing'))).toBe(true);
  });
});
