/**
 * The ONE floor-failure comparator (T2.3): the loop Stop-gate and the
 * diff-scoped CI floor both attribute failures through
 * `attributeFloorFailures`, with the absent-from-base policy a DECLARED
 * argument. These tests pin the attribution lattice, the loop wrapper's
 * unchanged semantics (parity — the Rule 2.30 net for two consumers of one
 * concept), and the two-sided CI outcome end-to-end on a real git repo with
 * injected execution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  attributeFloorFailures,
  checkKey,
  type FloorBaseCheck,
} from '../src/analyzers/correctness/attribution';
import { netNewFloorFailures, type FloorBaseline } from '../src/loop/floor-state';
import {
  runFloorForSurface,
  attributeCiFloorOutcome,
} from '../src/analyzers/correctness/surface-run';
import type {
  CorrectnessFloorResult,
  CorrectnessCheckResult,
  CommandExec,
} from '../src/analyzers/correctness/run';
import type { LanguageSupport } from '../src/languages/types';

function fail(pack: string, label: string): CorrectnessCheckResult {
  return { pack: pack as CorrectnessCheckResult['pack'], label, bin: 'x', status: 'fail' };
}
function pass(pack: string, label: string): CorrectnessCheckResult {
  return { pack: pack as CorrectnessCheckResult['pack'], label, bin: 'x', status: 'pass' };
}
function result(checks: CorrectnessCheckResult[]): CorrectnessFloorResult {
  return { ran: true, checks, blocks: checks.some((c) => c.status === 'fail') };
}

describe('attributeFloorFailures (the lattice)', () => {
  const base: FloorBaseCheck[] = [
    { pack: 'ts', label: 'typecheck', status: 'pass' },
    { pack: 'ts', label: 'affected-tests', status: 'fail' },
    { pack: 'kotlin', label: 'compile', status: 'skipped' },
  ];

  it('base pass → net-new; base fail → pre-existing; base skipped → unattributed', () => {
    const current = result([
      fail('ts', 'typecheck'),
      fail('ts', 'affected-tests'),
      fail('kotlin', 'compile'),
    ]);
    const out = attributeFloorFailures(current, base, { absentMeans: 'unattributed' });
    const byKey = new Map(out.map((a) => [checkKey(a.check.pack, a.check.label), a.attribution]));
    expect(byKey.get('ts:typecheck')).toBe('net-new');
    expect(byKey.get('ts:affected-tests')).toBe('pre-existing');
    expect(byKey.get('kotlin:compile')).toBe('unattributed');
  });

  it('absent from base takes the DECLARED policy — both modes', () => {
    const current = result([fail('go', 'build')]);
    expect(attributeFloorFailures(current, base, { absentMeans: 'net-new' })[0].attribution).toBe(
      'net-new',
    );
    expect(
      attributeFloorFailures(current, base, { absentMeans: 'unattributed' })[0].attribution,
    ).toBe('unattributed');
  });

  it('a null base attributes EVERY failure via absentMeans', () => {
    const current = result([fail('ts', 'typecheck')]);
    expect(attributeFloorFailures(current, null, { absentMeans: 'net-new' })[0].attribution).toBe(
      'net-new',
    );
    expect(
      attributeFloorFailures(current, null, { absentMeans: 'unattributed' })[0].attribution,
    ).toBe('unattributed');
  });

  it('passing/skipped current checks are never attributed (failures only)', () => {
    const current = result([pass('ts', 'typecheck'), fail('ts', 'affected-tests')]);
    const out = attributeFloorFailures(current, base, { absentMeans: 'net-new' });
    expect(out).toHaveLength(1);
    expect(out[0].check.label).toBe('affected-tests');
  });
});

describe('PARITY: the loop wrapper preserves its exact semantics through the one comparator', () => {
  it('netNewFloorFailures ≡ attributeFloorFailures(..., net-new filter) on shared fixtures', () => {
    const snapshot: FloorBaseline = {
      capturedAtCommit: 'abc',
      checks: [
        { pack: 'ts', label: 'typecheck', status: 'pass' },
        { pack: 'ts', label: 'affected-tests', status: 'fail' },
      ],
    };
    const scenarios: CorrectnessFloorResult[] = [
      result([fail('ts', 'typecheck')]), // base pass → net-new
      result([fail('ts', 'affected-tests')]), // base fail → grandfathered
      result([fail('go', 'build')]), // absent → net-new (loop policy)
      result([pass('ts', 'typecheck'), fail('ts', 'affected-tests'), fail('kotlin', 'compile')]),
    ];
    for (const current of scenarios) {
      const viaWrapper = netNewFloorFailures(current, snapshot).map((c) =>
        checkKey(c.pack, c.label),
      );
      const viaComparator = attributeFloorFailures(current, snapshot.checks, {
        absentMeans: 'net-new',
      })
        .filter((a) => a.attribution === 'net-new')
        .map((a) => checkKey(a.check.pack, a.check.label));
      expect(viaWrapper).toEqual(viaComparator);
    }
    // Null snapshot: every failure net-new (fails toward blocking) — both paths.
    const current = result([fail('ts', 'typecheck')]);
    expect(netNewFloorFailures(current, null)).toHaveLength(1);
  });
});

describe('attributeCiFloorOutcome (two-sided CI floor, real git worktree)', () => {
  let repo: string;
  let baseSha: string;

  /** A synthetic pack whose single check's verdict is decided by the tree
   *  content the exec sees — so the base worktree genuinely differs. */
  function syntheticPack(): LanguageSupport {
    return {
      id: 'ts',
      correctness: {
        execution: () => ({
          hosts: ['any' as const],
          toolchains: [],
          needsBuild: false,
          buildTarget: 'none' as const,
          weight: 'cheap' as const,
        }),
        syntaxCheck: () => ({ label: 'typecheck', bin: 'check-marker', args: [] }),
        affectedTests: () => null,
      },
    } as unknown as LanguageSupport;
  }

  /** exec that reads marker.txt in the RUN CWD: 'broken' → fail, else pass.
   *  This is what makes the base worktree (old content) and the current tree
   *  (new content) produce different verdicts through the same command. */
  const contentExec: CommandExec = (_cmd, cwd) => {
    try {
      const marker = readFileSync(join(cwd, 'marker.txt'), 'utf8');
      return marker.includes('broken')
        ? { available: true, code: 1, output: 'marker says broken' }
        : { available: true, code: 0, output: '' };
    } catch {
      return { available: false, code: -1, output: 'marker missing' };
    }
  };

  function git(args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-twosided-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@t.co']);
    git(['config', 'user.name', 't']);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  async function runTwoSided(baseMarker: string, headMarker: string) {
    writeFileSync(join(repo, 'marker.txt'), baseMarker);
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'marker.txt'), headMarker);
    writeFileSync(join(repo, 'feature.txt'), 'the PR change\n'); // head always differs from base
    git(['add', '-A']);
    git(['commit', '-qm', 'head']);

    const outcome = runFloorForSurface({
      surface: 'ci',
      cwd: repo,
      flag: true,
      exec: contentExec,
      packs: [syntheticPack()],
      resolveEnabled: () => ({ enabled: true, reason: 'test' }),
    });
    return attributeCiFloorOutcome(outcome, {
      cwd: repo,
      base: baseSha,
      exec: contentExec,
      packs: [syntheticPack()],
    });
  }

  it('PRE-EXISTING: base red + head red → warns by name, does NOT block (the onboarding-PR class)', async () => {
    const out = await runTwoSided('broken\n', 'broken\n');
    expect(out.blocks).toBe(false);
    expect(out.attributed?.[0].attribution).toBe('pre-existing');
    expect(out.summary).toContain('pre-existing');
    expect(out.summary).toContain('not blocked');
  }, 60_000);

  it('NET-NEW: base green + head red → still BLOCKS (a bundled breakage cannot ride in)', async () => {
    const out = await runTwoSided('fine\n', 'broken\n');
    expect(out.blocks).toBe(true);
    expect(out.attributed?.[0].attribution).toBe('net-new');
    expect(out.summary).toContain('NET-NEW');
  }, 60_000);

  it('UNATTRIBUTED: base side could not run the check → disclosed, not blocked (Rule 19)', async () => {
    // Base commit has NO marker file → the exec reports unavailable on the
    // base side → skipped there → the head failure cannot be attributed.
    writeFileSync(join(repo, 'other.txt'), 'seed\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'base without marker']);
    baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'marker.txt'), 'broken\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'head adds broken marker']);

    const outcome = runFloorForSurface({
      surface: 'ci',
      cwd: repo,
      flag: true,
      exec: contentExec,
      packs: [syntheticPack()],
      resolveEnabled: () => ({ enabled: true, reason: 'test' }),
    });
    const out = await attributeCiFloorOutcome(outcome, {
      cwd: repo,
      base: baseSha,
      exec: contentExec,
      packs: [syntheticPack()],
    });
    expect(out.blocks).toBe(false);
    expect(out.attributed?.[0].attribution).toBe('unattributed');
    expect(out.summary).toContain('could not be attributed');
  }, 60_000);

  it('a non-blocking outcome returns unchanged (a green PR never pays the base run)', async () => {
    writeFileSync(join(repo, 'marker.txt'), 'fine\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'green']);
    const outcome = runFloorForSurface({
      surface: 'ci',
      cwd: repo,
      flag: true,
      exec: contentExec,
      packs: [syntheticPack()],
      resolveEnabled: () => ({ enabled: true, reason: 'test' }),
    });
    expect(outcome.blocks).toBe(false);
    const out = await attributeCiFloorOutcome(outcome, { cwd: repo, exec: contentExec });
    expect(out).toBe(outcome);
  }, 60_000);
});
