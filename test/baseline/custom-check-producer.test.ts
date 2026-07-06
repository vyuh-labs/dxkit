import { describe, it, expect } from 'vitest';

import { customCheckFindingsToBaselineEntries } from '../../src/baseline/producers/custom-checks';
import { identityFor } from '../../src/baseline/finding-identity';
import { gatherCustomCheckFindings } from '../../src/analyzers/custom-checks/gather';
import { DEFAULT_BROWNFIELD_POLICY } from '../../src/baseline/policy';
import type { CommandExec } from '../../src/analyzers/tools/bounded-exec';
import type { CustomCheckFinding } from '../../src/analyzers/custom-checks/types';

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
});

describe('gatherCustomCheckFindings', () => {
  it('no-ops (returns []) when nothing is configured', () => {
    const findings = gatherCustomCheckFindings({
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
