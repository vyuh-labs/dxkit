import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recommendRemediate } from '../../src/discovery/advisor';

/**
 * The remediate recommend probe must be grounded in DEBT, not in the mere
 * presence of a floor envelope: an all-green recorded floor is not a broken
 * floor (the walkthrough caught the probe counting every recorded check —
 * the canonical `failingFloorDebt` filter is the fix, pinned here in both
 * directions), a configured repo never hears about the lane again, and the
 * dep-vuln arm fires only when the BUMP lane is already on (what remains
 * then needs code changes, which is this lane's job).
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-recommend-'));
  mkdirSync(join(repo, '.dxkit', 'baselines'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeBaseline(content: Record<string, unknown>): void {
  writeFileSync(join(repo, '.dxkit', 'baselines', 'main.json'), JSON.stringify(content), 'utf8');
}

function writePolicy(content: Record<string, unknown>): void {
  writeFileSync(join(repo, '.dxkit', 'policy.json'), JSON.stringify(content), 'utf8');
}

describe('recommendRemediate', () => {
  it('fires on a FAILING floor-debt envelope, naming remediate plan', () => {
    writeBaseline({
      findings: [],
      floorDebt: { checks: [{ status: 'fail' }, { status: 'pass' }] },
    });
    const rec = recommendRemediate({ cwd: repo });
    expect(rec).not.toBeNull();
    expect(rec!.reason).toContain('1 failing check');
    expect(rec!.command).toBe('vyuh-dxkit remediate plan');
  });

  it('stays silent on an ALL-GREEN recorded floor (recorded is not broken)', () => {
    writeBaseline({
      findings: [],
      floorDebt: { checks: [{ status: 'pass' }, { status: 'pass' }] },
    });
    expect(recommendRemediate({ cwd: repo })).toBeNull();
  });

  it('fires on remaining dep vulns only when the bump lane is ALREADY enabled', () => {
    writeBaseline({ findings: [{ kind: 'dep-vuln' }, { kind: 'dep-vuln' }] });
    // bump lane off → the bump lane is the right first recommendation, not this
    expect(recommendRemediate({ cwd: repo })).toBeNull();
    writePolicy({ depBump: { enabled: true } });
    const rec = recommendRemediate({ cwd: repo });
    expect(rec).not.toBeNull();
    expect(rec!.reason).toContain('bump lane cannot version-solve');
  });

  it('goes silent the moment remediate is configured', () => {
    writeBaseline({ findings: [], floorDebt: { checks: [{ status: 'fail' }] } });
    writePolicy({ remediate: { enabled: false } });
    expect(recommendRemediate({ cwd: repo })).toBeNull();
  });
});
