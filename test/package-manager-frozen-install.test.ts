import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  frozenInstallFor,
  isPeerConflictOnly,
  lockfileSyncCheck,
  renderInstallDependenciesShell,
  type PackageManager,
} from '../src/package-manager';

/**
 * The ONE frozen-install definition (4.4.5): what the CI templates render and
 * what the lane's verification runs come from the same table. These pin the
 * table's two projections against each other and the peer-conflict
 * classifier both directions.
 */

function repoWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-frozen-'));
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

describe('frozenInstallFor', () => {
  const cases: Array<{ files: string[]; pm: PackageManager; argv: string; fallback?: string }> = [
    {
      files: ['package.json', 'pnpm-lock.yaml'],
      pm: 'pnpm',
      argv: 'pnpm install --frozen-lockfile',
    },
    {
      files: ['package.json', 'yarn.lock'],
      pm: 'yarn',
      argv: 'yarn install --immutable',
      fallback: 'yarn install --frozen-lockfile',
    },
    { files: ['package.json', 'bun.lock'], pm: 'bun', argv: 'bun install --frozen-lockfile' },
    {
      files: ['package.json', 'package-lock.json'],
      pm: 'npm',
      argv: 'npm ci',
      fallback: 'npm ci --legacy-peer-deps',
    },
    {
      files: ['package.json'],
      pm: 'npm',
      argv: 'npm install',
      fallback: 'npm install --legacy-peer-deps',
    },
  ];

  for (const c of cases) {
    it(`${c.files.join('+')} → ${c.argv}`, () => {
      const dir = repoWith(c.files);
      try {
        const plan = frozenInstallFor(dir)!;
        expect(plan.pm).toBe(c.pm);
        expect(plan.argv.join(' ')).toBe(c.argv);
        expect(plan.fallback?.argv.join(' ')).toBe(c.fallback);
        if (plan.fallback) expect(plan.fallback.reason.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('no package.json → nothing to install', () => {
    const dir = repoWith([]);
    try {
      expect(frozenInstallFor(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The parity pin: every programmatic install the lane can run is a line of
  // the rendered CI block, primary and fallback alike. If the table ever grows
  // a branch the renderer does not emit (or vice versa) this fails.
  it('every install argv the lane runs appears verbatim in the rendered CI shell', () => {
    const shell = renderInstallDependenciesShell('');
    for (const c of cases) {
      const dir = repoWith(c.files);
      try {
        const plan = frozenInstallFor(dir)!;
        const line = plan.fallback
          ? `${plan.argv.join(' ')}${plan.pm === 'yarn' ? ' 2>/dev/null' : ''} || ${plan.fallback.argv.join(' ')}`
          : plan.argv.join(' ');
        expect(shell.split('\n').map((l) => l.trim())).toContain(line);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('renderInstallDependenciesShell', () => {
  it('renders the lockfile-priority chain at the given indent', () => {
    const shell = renderInstallDependenciesShell('    ');
    expect(shell.startsWith('    corepack enable')).toBe(true);
    const order = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json', 'package.json'];
    const positions = order.map((f) => shell.indexOf(`-f ${f}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(shell.trimEnd().endsWith('    fi')).toBe(true);
    expect(shell).toContain('npm install -g @vyuhlabs/dxkit');
  });
});

describe('isPeerConflictOnly', () => {
  it('a peer conflict (ERESOLVE) is the one --legacy-peer-deps answers', () => {
    expect(isPeerConflictOnly('npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve')).toBe(
      true,
    );
    expect(isPeerConflictOnly('npm ERR! peer dep missing: react@^18')).toBe(true);
  });
  it('an out-of-sync lockfile (EUSAGE) is NOT, even when ERESOLVE text is around', () => {
    expect(
      isPeerConflictOnly(
        'npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync.\nnpm ERR! Missing: left-pad@1.3.0 from lock file',
      ),
    ).toBe(false);
    expect(isPeerConflictOnly('code EUSAGE ... ERESOLVE')).toBe(false);
  });
  it('an unrelated failure is neither', () => {
    expect(isPeerConflictOnly('npm ERR! code ENOTFOUND')).toBe(false);
    expect(isPeerConflictOnly('')).toBe(false);
  });
});

describe('lockfileSyncCheck', () => {
  it('npm: a non-installing dry-run that tolerates a peer conflict only', () => {
    const c = lockfileSyncCheck('npm');
    expect(c.kind).toBe('command');
    if (c.kind !== 'command') return;
    expect(c.argv).toEqual([
      'npm',
      'ci',
      '--dry-run',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    expect(c.tolerated?.matches('npm ERR! code ERESOLVE')).toBe(true);
    expect(c.tolerated?.matches('npm ERR! code EUSAGE not in sync')).toBe(false);
    expect(c.tolerated?.disclosure).toContain('--legacy-peer-deps');
  });
  it('pnpm and bun: frozen dry-runs with no tolerated failure', () => {
    for (const pm of ['pnpm', 'bun'] as const) {
      const c = lockfileSyncCheck(pm);
      expect(c.kind).toBe('command');
      if (c.kind !== 'command') return;
      expect(c.argv[0]).toBe(pm);
      expect(c.argv).toContain('--frozen-lockfile');
      expect(c.tolerated).toBeUndefined();
    }
  });
  it('yarn: a DISCLOSED skip, never a silent one', () => {
    const c = lockfileSyncCheck('yarn');
    expect(c.kind).toBe('skipped');
    if (c.kind === 'skipped') expect(c.reason).toContain('immutable');
  });
});
