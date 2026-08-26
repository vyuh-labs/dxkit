import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCorrectnessFloor, describeFloorCapturePlan } from '../src/analyzers/correctness/run';
import { LOCKFILE_SYNC_LABEL } from '../src/languages/capabilities/correctness';
import { getLanguage } from '../src/languages';
import { clearWalkPathsCache } from '../src/analyzers/tools/walk-paths';

const TS = getLanguage('typescript')!;

/**
 * The lockfile-sync floor check on the REAL TypeScript pack (4.4.5): the
 * runner schedules it at full scope, the pack builds the npm dry-run from
 * `package-manager.ts`, and the three outcomes are told apart at the runner:
 *   - stale lockfile (EUSAGE)       → FAIL (the class CI died on)
 *   - peer conflict only (ERESOLVE) → PASS with the --legacy-peer-deps disclosure
 *   - in sync (exit 0)              → PASS
 * Exec is injected: no package manager runs.
 */

const EUSAGE =
  'npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json and ' +
  'package-lock.json are in sync.\nnpm ERR! Missing: left-pad@1.3.0 from lock file';
const ERESOLVE = 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve peer react@^18';

function tsRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-locksync-'));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

function floorOn(dir: string, code: number, output: string, scope: 'full' | 'affected' = 'full') {
  return runCorrectnessFloor({
    cwd: dir,
    changedFiles: scope === 'full' ? [] : ['src/index.ts'],
    scope,
    packs: [TS],
    exec: (cmd) =>
      cmd.bin === 'npm' && cmd.args[0] === 'ci' && cmd.args.includes('--dry-run')
        ? { available: true, code, output }
        : { available: true, code: 0, output: '' },
  });
}

describe('lockfile-sync floor check (typescript pack, npm)', () => {
  const files = { 'package.json': '{"name":"x"}', 'package-lock.json': '{}' };

  it('a stale lockfile FAILS the floor with the remedy named', () => {
    const dir = tsRepo(files);
    try {
      const r = floorOn(dir, 1, EUSAGE);
      const lock = r.checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
      expect(lock.status).toBe('fail');
      expect(lock.bin).toBe('npm');
      expect(lock.args).toEqual(['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
      expect(lock.output).toContain('EUSAGE');
      expect(lock.output).toContain('frozen install');
      expect(r.blocks).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs at every nested dependency root the audit reads and names the stale ones as findings', () => {
    const dir = tsRepo(files);
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'server', 'package.json'), '{"name":"server"}');
    writeFileSync(join(dir, 'server', 'package-lock.json'), '{}');
    clearWalkPathsCache();
    try {
      const seen: string[] = [];
      // root in sync, the nested sub-project stale: root-only checking
      // read this tree as in sync
      const r = runCorrectnessFloor({
        cwd: dir,
        changedFiles: [],
        scope: 'full',
        packs: [TS],
        exec: (cmd, cwd) => {
          if (!(cmd.bin === 'npm' && cmd.args.includes('--dry-run'))) {
            return { available: true, code: 0, output: '' };
          }
          seen.push(cwd);
          return cwd === join(dir, 'server')
            ? { available: true, code: 1, output: EUSAGE }
            : { available: true, code: 0, output: '' };
        },
      });
      expect(seen.sort()).toEqual([dir, join(dir, 'server')].sort());
      const lock = r.checks.filter((c) => c.label === LOCKFILE_SYNC_LABEL);
      expect(lock).toHaveLength(1);
      expect(lock[0].status).toBe('fail');
      expect(lock[0].findings).toEqual(['server']);
      expect(lock[0].output).toContain('[server]');
      expect(lock[0].output).toContain('EUSAGE');
      expect(r.blocks).toBe(true);
    } finally {
      clearWalkPathsCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a peer-conflict-only failure PASSES with the --legacy-peer-deps disclosure', () => {
    const dir = tsRepo(files);
    try {
      const r = floorOn(dir, 1, ERESOLVE);
      const lock = r.checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
      expect(lock.status).toBe('pass');
      expect(lock.note).toContain('--legacy-peer-deps');
      expect(r.blocks).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an in-sync lockfile PASSES with no note', () => {
    const dir = tsRepo(files);
    try {
      const lock = floorOn(dir, 0, '').checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
      expect(lock.status).toBe('pass');
      expect(lock.note).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a source-only affected run never pays the dry-run', () => {
    const dir = tsRepo(files);
    try {
      const r = floorOn(dir, 1, EUSAGE, 'affected');
      expect(r.checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)).toBeUndefined();
      // The result carries the EFFECTIVE scope, so renderers report what ran.
      expect(r.scope).toBe('affected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An affected run with an EMPTY changed set is an UNDETERMINABLE diff — the
  // pack contract reads it as full, so the lockfile check must run there too
  // (a silent skip would re-open the class on any surface that cannot compute
  // its diff: the change that drifted the lockfile may simply be invisible).
  it('an affected run with an EMPTY changed set (undeterminable diff) still runs the check', () => {
    const dir = tsRepo(files);
    try {
      const r = runCorrectnessFloor({
        cwd: dir,
        changedFiles: [],
        scope: 'affected',
        packs: [TS],
        exec: (cmd) =>
          cmd.bin === 'npm' && cmd.args.includes('--dry-run')
            ? { available: true, code: 1, output: EUSAGE }
            : { available: true, code: 0, output: '' },
      });
      const lock = r.checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
      expect(lock.status).toBe('fail');
      expect(r.blocks).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a full run records its scope on the result', () => {
    const dir = tsRepo(files);
    try {
      expect(floorOn(dir, 0, '').scope).toBe('full');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no lockfile → the pack declines (nothing to keep in sync)', () => {
    const dir = tsRepo({ 'package.json': '{"name":"x"}' });
    try {
      const r = floorOn(dir, 1, EUSAGE);
      expect(r.checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yarn: a disclosed skip, never silent', () => {
    const dir = tsRepo({ 'package.json': '{"name":"x"}', 'yarn.lock': '' });
    try {
      const lock = floorOn(dir, 0, '').checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
      expect(lock.status).toBe('skipped-unavailable');
      expect(lock.output).toContain('immutable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing package manager is fail-open (skipped, disclosed)', () => {
    const dir = tsRepo(files);
    try {
      const r = runCorrectnessFloor({
        cwd: dir,
        changedFiles: [],
        scope: 'full',
        packs: [TS],
        exec: (cmd) =>
          cmd.args.includes('--dry-run')
            ? { available: false, code: -1, output: 'npm: not on PATH' }
            : { available: true, code: 0, output: '' },
      });
      const lock = r.checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
      expect(lock.status).toBe('skipped-unavailable');
      expect(r.blocks).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the capture plan names the dry-run so an operator sees it before the run', () => {
    const dir = tsRepo(files);
    try {
      const plan = describeFloorCapturePlan(dir, [TS]);
      expect(plan.some((l) => l.includes('lockfile-sync') && l.includes('npm ci --dry-run'))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
