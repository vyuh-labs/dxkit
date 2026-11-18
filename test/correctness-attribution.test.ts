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
  attributeNoTests,
  checkKey,
  floorBaseStatus,
  toFloorBaseCheck,
  type FloorBaseCheck,
} from '../src/analyzers/correctness/attribution';
import { floorDebtToBaseChecks } from '../src/baseline/floor-debt';
import { toFloorBaseChecks } from '../src/lanes/verify';
import {
  netNewFloorFailures,
  readFloorBaseline,
  writeFloorBaseline,
  type FloorBaseline,
} from '../src/loop/floor-state';
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

  describe('finding-level attribution (import-resolution granularity)', () => {
    const failWith = (findings: string[]): CorrectnessCheckResult => ({
      ...fail('ts', 'import-resolution'),
      findings,
    });

    it('an already-red check still yields NET-NEW on a new finding (the grandfather hole)', () => {
      // Base: 'old-debt' unresolved. Current: 'old-debt' AND 'form-data'.
      // Check-level comparison would say pre-existing and wave it through —
      // exactly how a repo with debt would grandfather every future break.
      const out = attributeFloorFailures(
        result([failWith(['old-debt', 'form-data'])]),
        [{ pack: 'ts', label: 'import-resolution', status: 'fail', findings: ['old-debt'] }],
        { absentMeans: 'unattributed' },
      );
      expect(out).toHaveLength(1);
      expect(out[0].attribution).toBe('net-new');
      expect(out[0].netNewFindings).toEqual(['form-data']);
    });

    it('the identical finding set stays pre-existing (no false block on unchanged debt)', () => {
      const out = attributeFloorFailures(
        result([failWith(['old-debt'])]),
        [{ pack: 'ts', label: 'import-resolution', status: 'fail', findings: ['old-debt'] }],
        { absentMeans: 'unattributed' },
      );
      expect(out[0].attribution).toBe('pre-existing');
      expect(out[0].netNewFindings).toBeUndefined();
    });

    it('a base failure with NO recorded findings stays check-level (never fabricate precision)', () => {
      const out = attributeFloorFailures(
        result([failWith(['form-data'])]),
        [{ pack: 'ts', label: 'import-resolution', status: 'fail' }],
        { absentMeans: 'unattributed' },
      );
      expect(out[0].attribution).toBe('pre-existing');
      expect(out[0].netNewFindings).toBeUndefined();
    });

    it('a base PASS with a current findings-failure is plain net-new (check-level path)', () => {
      const out = attributeFloorFailures(
        result([failWith(['form-data'])]),
        [{ pack: 'ts', label: 'import-resolution', status: 'pass' }],
        { absentMeans: 'unattributed' },
      );
      expect(out[0].attribution).toBe('net-new');
    });

    it('marks fail-vs-fail PRECISION: finding when both sides carried identities, check when not (4.2)', () => {
      // 'check' precision is the disclosure obligation: an already-red check
      // without per-failure identities can hide net-new failures inside the
      // red, and renderers must say so (Rule 19), never let "pre-existing"
      // read as "fully attributed".
      const findingLevel = attributeFloorFailures(
        result([failWith(['a'])]),
        [{ pack: 'ts', label: 'import-resolution', status: 'fail', findings: ['a'] }],
        { absentMeans: 'unattributed' },
      );
      expect(findingLevel[0].precision).toBe('finding');
      const checkLevel = attributeFloorFailures(
        result([fail('ts', 'affected-tests')]),
        [{ pack: 'ts', label: 'affected-tests', status: 'fail' }],
        { absentMeans: 'unattributed' },
      );
      expect(checkLevel[0].attribution).toBe('pre-existing');
      expect(checkLevel[0].precision).toBe('check');
      // The question does not arise on a base pass — no precision claimed.
      const basePass = attributeFloorFailures(
        result([fail('ts', 'typecheck')]),
        [{ pack: 'ts', label: 'typecheck', status: 'pass' }],
        { absentMeans: 'unattributed' },
      );
      expect(basePass[0].precision).toBeUndefined();
    });
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

/**
 * The zero-tests transitions (4.5.0), decided once and pinned both ways.
 * Bases always run at FULL scope (loop snapshot, CI merge-base, entry
 * floors, floor-debt capture).
 *
 *   base       current    → answer
 *   no-tests   fail       → net-new (BLOCKS): the base found zero tests, so
 *                            every failing test arrived with the change
 *   pass       no-tests   → tests-vanished (full scope only; disclosed,
 *                            never a block, never a pass)
 *   fail       no-tests   → tests-vanished (deleting failing tests is not a
 *                            fix of them)
 *   no-tests   no-tests   → none-at-base (still disclosed as no tests ran)
 *   skipped /  no-tests   → base-unobserved
 *   absent
 *   pass       no-tests   → base-unobserved at AFFECTED scope: a selection
 *   (affected)              that matched no test for this change is "no
 *                            tests ran for this change", not a vanished suite
 */
describe('zero-tests transitions (4.5.0)', () => {
  const noTests = (pack: string, label: string): CorrectnessCheckResult => ({
    pack: pack as CorrectnessCheckResult['pack'],
    label,
    bin: 'x',
    status: 'no-tests',
  });

  it('base no-tests → current fail is NET-NEW in both loop and CI policies', () => {
    for (const absentMeans of ['net-new', 'unattributed'] as const) {
      const out = attributeFloorFailures(
        result([fail('ts', 'affected-tests')]),
        [{ pack: 'ts', label: 'affected-tests', status: 'no-tests' }],
        { absentMeans },
      );
      expect(out.map((a) => a.attribution)).toEqual(['net-new']);
    }
  });

  it('a current no-tests check is never a failure to attribute', () => {
    const out = attributeFloorFailures(
      { ran: false, checks: [noTests('ts', 'affected-tests')], blocks: false },
      [{ pack: 'ts', label: 'affected-tests', status: 'pass' }],
      { absentMeans: 'net-new' },
    );
    expect(out).toEqual([]);
  });

  it('pins every base status against a FULL-scope current no-tests', () => {
    const current: CorrectnessFloorResult = {
      ran: false,
      blocks: false,
      scope: 'full',
      checks: [
        noTests('a', 'affected-tests'),
        noTests('b', 'affected-tests'),
        noTests('c', 'affected-tests'),
        noTests('d', 'affected-tests'),
        noTests('e', 'affected-tests'),
      ],
    };
    const out = attributeNoTests(current, [
      { pack: 'a', label: 'affected-tests', status: 'pass' },
      { pack: 'b', label: 'affected-tests', status: 'fail' },
      { pack: 'c', label: 'affected-tests', status: 'no-tests' },
      { pack: 'd', label: 'affected-tests', status: 'skipped' },
    ]);
    const by = new Map(out.map((a) => [a.check.pack as string, a]));
    expect(by.get('a')).toMatchObject({ transition: 'tests-vanished', baseStatus: 'pass' });
    expect(by.get('b')).toMatchObject({ transition: 'tests-vanished', baseStatus: 'fail' });
    expect(by.get('c')?.transition).toBe('none-at-base');
    expect(by.get('d')?.transition).toBe('base-unobserved');
    expect(by.get('e')?.transition).toBe('base-unobserved'); // absent
    expect(attributeNoTests(current, null).every((a) => a.transition === 'base-unobserved')).toBe(
      true,
    );
  });

  it('an AFFECTED-scope zero never claims a vanished suite', () => {
    const out = attributeNoTests(
      { ran: false, blocks: false, scope: 'affected', checks: [noTests('a', 'affected-tests')] },
      [{ pack: 'a', label: 'affected-tests', status: 'pass' }],
    );
    expect(out[0].transition).toBe('base-unobserved');
  });

  it('PARITY: every base-side projection keeps no-tests (never collapses it to skipped)', () => {
    expect(floorBaseStatus('no-tests')).toBe('no-tests');
    expect(floorBaseStatus('skipped-timeout')).toBe('skipped');
    const floor: CorrectnessFloorResult = {
      ran: true,
      blocks: false,
      checks: [pass('ts', 'typecheck'), noTests('ts', 'affected-tests')],
    };
    const expected = ['pass', 'no-tests'];
    // the lanes' entry floor
    expect(toFloorBaseChecks(floor).map((c) => c.status)).toEqual(expected);
    // the committed floor-debt envelope
    expect(
      floorDebtToBaseChecks({
        capturedAtCommit: null,
        capturedAt: 'x',
        checks: floor.checks.map((c) => ({
          pack: c.pack,
          label: c.label,
          status: c.status,
          command: 'x',
        })),
      }).map((c) => c.status),
    ).toEqual(expected);
    // the CI merge-base run + the tree gate (both map through this)
    expect(floor.checks.map(toFloorBaseCheck).map((c) => c.status)).toEqual(expected);
    // the loop entry snapshot
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-notests-snap-'));
    try {
      writeFloorBaseline(dir, floor, null);
      expect(readFloorBaseline(dir)!.checks.map((c) => c.status)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('narrows a finding-level net-new to the NEW findings in the repair payload', () => {
    // The loop's entry snapshot recorded pre-existing unresolved-import debt;
    // a later Stop adds a new one. The wrapper must (a) block, (b) hand the
    // model the NEW finding, not the grandfathered backlog.
    const snapshot: FloorBaseline = {
      capturedAtCommit: 'abc',
      checks: [{ pack: 'ts', label: 'import-resolution', status: 'fail', findings: ['old-debt'] }],
    };
    const current = result([
      {
        ...fail('ts', 'import-resolution'),
        findings: ['old-debt', 'form-data'],
        output: 'both listed here',
      },
    ]);
    const netNew = netNewFloorFailures(current, snapshot);
    expect(netNew).toHaveLength(1);
    expect(netNew[0].findings).toEqual(['form-data']);
    expect(netNew[0].output).toContain('net-new (this change): form-data');
    // And the unchanged set stays grandfathered — no block.
    const unchanged = result([{ ...fail('ts', 'import-resolution'), findings: ['old-debt'] }]);
    expect(netNewFloorFailures(unchanged, snapshot)).toHaveLength(0);
  });

  it('the entry snapshot PERSISTS finding identities (write→read roundtrip)', () => {
    // Without this the finding-level comparator silently degrades to
    // check-level on every real loop — the snapshot is the base side.
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-floorstate-'));
    try {
      const run = result([
        { ...fail('ts', 'import-resolution'), findings: ['old-debt'] },
        pass('ts', 'typecheck'),
      ]);
      writeFloorBaseline(dir, run, 'deadbeef');
      const read = readFloorBaseline(dir);
      expect(read?.checks).toEqual([
        { pack: 'ts', label: 'import-resolution', status: 'fail', findings: ['old-debt'] },
        { pack: 'ts', label: 'typecheck', status: 'pass' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        syntaxCheck: () => ({
          label: 'typecheck',
          bin: 'check-marker',
          args: [],
          ranNoTests: ({ code, output }: { code: number; output: string }) =>
            code === 0 && output.includes('ZERO TESTS'),
        }),
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
      if (marker.includes('empty')) return { available: true, code: 0, output: 'ZERO TESTS' };
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

  it('NET-NEW: base ran ZERO tests + head red → BLOCKS (4.5.0: the failing tests arrived with the change)', async () => {
    const out = await runTwoSided('empty\n', 'broken\n');
    expect(out.blocks).toBe(true);
    expect(out.attributed?.[0].attribution).toBe('net-new');
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
