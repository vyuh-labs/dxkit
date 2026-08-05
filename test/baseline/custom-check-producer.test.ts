import { describe, it, expect } from 'vitest';

import { customCheckFindingsToBaselineEntries } from '../../src/baseline/producers/custom-checks';
import { identityFor } from '../../src/baseline/finding-identity';
import { gatherCustomCheckFindings } from '../../src/analyzers/custom-checks/gather';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import type { CommandExec } from '../../src/analyzers/tools/bounded-exec';
import type { CustomCheckFinding } from '../../src/analyzers/custom-checks/types';
import { trustedLocalContext } from '../../src/analysis-trust';

describe('customCheckFindingsToBaselineEntries (Rule 10 producer)', () => {
  it('maps a located finding to an entry with the canonical identity', () => {
    const finding: CustomCheckFinding = {
      check: 'lint:typescript',
      blocking: true,
      file: 'src/a.ts',
      line: 42,
      rule: 'no-unused-vars',
      message: "'x' unused",
    };
    const [entry] = customCheckFindingsToBaselineEntries([finding]);
    expect(entry.kind).toBe('custom-check');
    expect(entry.id).toBe(
      identityFor({
        kind: 'custom-check',
        check: 'lint:typescript',
        file: 'src/a.ts',
        line: 42,
        rule: 'no-unused-vars',
      }),
    );
    expect(entry).toMatchObject({ check: 'lint:typescript', blocking: true, file: 'src/a.ts' });
  });

  it('maps a binary finding (no file) to a file-less entry', () => {
    const [entry] = customCheckFindingsToBaselineEntries([
      { check: 'check:seam', blocking: false, message: 'boom' },
    ]);
    expect(entry.id).toBe(identityFor({ kind: 'custom-check', check: 'check:seam' }));
    expect(entry).toMatchObject({ check: 'check:seam', blocking: false });
    if (entry.kind === 'custom-check') expect(entry.file).toBeUndefined();
  });

  it('empty in → empty out', () => {
    expect(customCheckFindingsToBaselineEntries([])).toEqual([]);
  });

  it('ONE entry per identity: adjacent-line occurrences of one rule collapse (the inflated-headline class)', () => {
    // Located identity buckets lines into the shared 3-line window, so a
    // linter reporting the same rule on adjacent lines mints the SAME
    // fingerprint N times. The multiset previously survived into the
    // verdict: a real PR read "206 new regressions" over 137 unique
    // fingerprints. The fingerprint is the gate's unit (the allowlist
    // waives by fingerprint) — so it is the count's unit too.
    const base = {
      check: 'lint:typescript',
      blocking: true,
      file: 'src/a.ts',
      rule: 'quotes',
    };
    const entries = customCheckFindingsToBaselineEntries([
      { ...base, line: 9, message: 'use single quotes' },
      { ...base, line: 10, message: 'use single quotes' }, // same 3-line window (9-11)
      { ...base, line: 11, message: 'use single quotes' }, // same window
      { ...base, line: 40, message: 'use single quotes' }, // different window
    ]);
    expect(entries).toHaveLength(2);
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(2);
    const collapsed = entries.find((e) => 'line' in e && e.line === 9)!;
    if (collapsed.kind === 'custom-check') {
      expect(collapsed.message).toContain('3 occurrences in this line window');
    }
  });

  it('distinct rules in one window stay distinct findings', () => {
    const entries = customCheckFindingsToBaselineEntries([
      { check: 'lint:x', blocking: true, file: 'a.ts', line: 10, rule: 'quotes', message: 'q' },
      { check: 'lint:x', blocking: true, file: 'a.ts', line: 10, rule: 'curly', message: 'c' },
    ]);
    expect(entries).toHaveLength(2);
  });
});

describe('gatherCustomCheckFindings', () => {
  it('no-ops (returns []) when nothing is configured', () => {
    const findings = gatherCustomCheckFindings({
      trust: trustedLocalContext(),
      cwd: '/repo',
      policy: DEFAULT_BROWNFIELD_POLICY,
      packs: [],
      exec: () => {
        throw new Error('exec should never run when unconfigured');
      },
    });
    expect(findings).toEqual([]);
  });

  it('runs configured user checks through the one runner', () => {
    const exec: CommandExec = () => ({ available: true, code: 1, output: 'seam violated' });
    const findings = gatherCustomCheckFindings({
      trust: trustedLocalContext(),
      cwd: '/repo',
      policy: {
        ...DEFAULT_BROWNFIELD_POLICY,
        checks: [{ name: 'check:seam', command: 'npm run check:seam' }],
      },
      packs: [],
      exec,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'check:seam', blocking: true });
  });
});
