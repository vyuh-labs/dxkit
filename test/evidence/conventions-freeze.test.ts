import { describe, it, expect } from 'vitest';
import {
  EPISTEMIC_LABELS,
  EVIDENCE_SCHEMA_IDS,
  evidenceEnvelope,
} from '../../src/evidence/conventions';

/**
 * Freeze net for the shared evidence vocabulary (mirror of the SDK
 * wire-schema pin): schema ids are append-only and the epistemic-label set
 * has exactly one definition. A failing assertion here means a shipped
 * contract changed — add a new id / label alongside, never remove or
 * rename one.
 */
describe('evidence conventions freeze', () => {
  it('pins the evidence schema-id registry (append-only)', () => {
    const frozen = ['dxkit.evaluate-evidence.v1'];
    // Every previously shipped id must still be present, in order.
    expect(EVIDENCE_SCHEMA_IDS.slice(0, frozen.length)).toEqual(frozen);
  });

  it('pins the epistemic-label set exactly', () => {
    expect([...EPISTEMIC_LABELS]).toEqual(['observed', 'derived', 'inferred', 'unknown']);
  });

  it('stamps a well-formed envelope', () => {
    const env = evidenceEnvelope('dxkit.evaluate-evidence.v1');
    expect(env.schema).toBe('dxkit.evaluate-evidence.v1');
    expect(new Date(env.generatedAt).toString()).not.toBe('Invalid Date');
    expect(env.dxkitVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
