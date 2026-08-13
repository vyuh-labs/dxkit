import { describe, it, expect } from 'vitest';
import {
  describeDeliveryProbe,
  probeBranchDelivery,
  probeDeliveryPreconditions,
  standingLaneBranches,
  type ApiProbe,
} from '../../src/lanes/delivery-preconditions';
import { DEP_BUMP_BRANCH, remediateBranchFor } from '../../src/lanes/branches';
import { REMEDIATE_TASKS } from '../../src/remediate/tasks';

/**
 * #286/#287 — the ONE delivery-preconditions prober. The contract under
 * test: only POSITIVE refusal evidence (an active `creation` rule) reads
 * as blocked; every unanswerable probe is `unknown` and never invents a
 * refusal; the probed branch set derives from the same constants the
 * landers push.
 */

const rules =
  (byBranch: Record<string, unknown>): ApiProbe =>
  (path) => {
    const branch = decodeURIComponent(path.split('/rules/branches/')[1] ?? '');
    const answer = byBranch[branch];
    return answer === undefined ? null : JSON.stringify(answer);
  };

describe('standingLaneBranches', () => {
  it('derives from the landers’ own constants — never a second list', () => {
    const branches = standingLaneBranches();
    expect(branches).toContain(DEP_BUMP_BRANCH);
    for (const t of REMEDIATE_TASKS) expect(branches).toContain(remediateBranchFor(t.id));
  });
});

describe('probeBranchDelivery', () => {
  it('an active creation rule is POSITIVE refusal evidence, with the exact remedy (the live class)', () => {
    const p = probeBranchDelivery(
      rules({ 'dxkit/dep-bump': [{ type: 'creation' }, { type: 'non_fast_forward' }] }),
      'acme/repo',
      'dxkit/dep-bump',
    );
    expect(p.verdict).toBe('blocked');
    expect(p.evidence).toContain('creation');
    expect(p.remedy).toContain('refs/heads/dxkit/**');
  });

  it('a file-path restriction is disclosed, not blocked (the diff may not touch it)', () => {
    const p = probeBranchDelivery(
      rules({ b: [{ type: 'file_path_restriction' }] }),
      'acme/repo',
      'b',
    );
    expect(p.verdict).toBe('restricted-paths');
    expect(p.remedy).toBeTruthy();
  });

  it('benign rules read as ok, named', () => {
    const p = probeBranchDelivery(rules({ b: [{ type: 'non_fast_forward' }] }), 'acme/repo', 'b');
    expect(p.verdict).toBe('ok');
    expect(p.evidence).toContain('non_fast_forward');
  });

  it('an unreachable API is UNKNOWN — the probe never invents a refusal', () => {
    const p = probeBranchDelivery(() => null, 'acme/repo', 'b');
    expect(p.verdict).toBe('unknown');
    expect(p.evidence).toContain('could not verify');
  });

  it('an unparseable payload is UNKNOWN', () => {
    const p = probeBranchDelivery(() => '<html>', 'acme/repo', 'b');
    expect(p.verdict).toBe('unknown');
  });
});

describe('describeDeliveryProbe', () => {
  it('one phrasing for every consumer, remedy included when present', () => {
    const line = describeDeliveryProbe({
      branch: 'dxkit/dep-bump',
      verdict: 'blocked',
      evidence: 'a ruleset covers it',
      remedy: 'add the exclusion',
    });
    expect(line).toContain('dxkit/dep-bump: BLOCKED');
    expect(line).toContain('Remedy: add the exclusion');
  });
});

describe('probeDeliveryPreconditions', () => {
  it('aggregates: anyBlocked on one refusal; unverifiable only when NOTHING answered', () => {
    const out = probeDeliveryPreconditions(process.cwd(), {
      branches: ['a', 'b'],
      slug: 'acme/repo',
      probe: rules({ a: [{ type: 'creation' }], b: [] }),
    });
    expect(out.anyBlocked).toBe(true);
    expect(out.unverifiable).toBe(false);
  });
});
