import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectLockfile, LOCKFILES, type PackageManager } from '../../src/package-manager';
import {
  isLockfileDrift,
  isPeerConflictOnly,
  isYarnClassicFlagRejection,
  nodeInstallStrategy,
  nodeProvisionHint,
  NODE_STRATEGY_BY_PM,
  LOCKFILE_DRIFT,
} from '../../src/languages/node-install';
import { lockfileCheckFromStrategy } from '../../src/languages/capabilities/correctness';
import { defaultResolvedTolerances } from '../../src/install/tolerances';

/**
 * The node install strategy (the ONE declaration of how a node root
 * installs, 4.4.6): the per-manager variants, keyed on the same lockfile
 * set detection reads; the frozen / resync modes; the peer-conflict
 * classifier both directions; the derived lockfile-sync check.
 */

function repoWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-node-install-'));
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

describe('nodeInstallStrategy.strategy', () => {
  const cases: Array<{
    files: string[];
    manager: string;
    frozen: string;
    fallback?: string;
    resync?: string;
  }> = [
    {
      files: ['package.json', 'pnpm-lock.yaml'],
      manager: 'pnpm',
      frozen: 'pnpm install --frozen-lockfile',
      resync: 'pnpm install --no-frozen-lockfile',
    },
    {
      files: ['package.json', 'yarn.lock'],
      manager: 'yarn',
      frozen: 'yarn install --immutable',
      fallback: 'yarn install --frozen-lockfile',
      resync: 'yarn install --no-immutable',
    },
    {
      files: ['package.json', 'bun.lock'],
      manager: 'bun',
      frozen: 'bun install --frozen-lockfile',
      resync: 'bun install',
    },
    {
      files: ['package.json', 'package-lock.json'],
      manager: 'npm',
      frozen: 'npm ci',
      fallback: 'npm ci --legacy-peer-deps',
      resync: 'npm install --no-audit --no-fund',
    },
    {
      files: ['package.json'],
      manager: 'npm',
      frozen: 'npm install',
      fallback: 'npm install --legacy-peer-deps',
      resync: 'npm install --no-audit --no-fund',
    },
  ];

  for (const c of cases) {
    it(`${c.files.join('+')} → ${c.frozen}`, () => {
      const dir = repoWith(c.files);
      try {
        const s = nodeInstallStrategy.strategy(dir)!;
        expect(s.manager).toBe(c.manager);
        const text = (cmd: { bin: string; args: readonly string[] }) =>
          [cmd.bin, ...cmd.args].join(' ');
        expect(text(s.modes.frozen.primary)).toBe(c.frozen);
        expect(s.modes.frozen.fallbacks.map((f) => text(f.command))).toEqual(
          c.fallback ? [c.fallback] : [],
        );
        for (const f of s.modes.frozen.fallbacks) expect(f.disclosure.length).toBeGreaterThan(0);
        expect(s.modes.resync ? text(s.modes.resync.primary) : undefined).toBe(c.resync);
        expect(nodeProvisionHint(dir)).toBe(c.frozen);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // Rule 2.30 parity (the shrinkwrap class): the variants and detectLockfile
  // must read ONE lockfile-set definition. For every lockfile either
  // projection recognizes, both must agree on the manager.
  it('every lockfile detectLockfile knows selects the SAME manager', () => {
    for (const [pm, files] of Object.entries(LOCKFILES) as [PackageManager, readonly string[]][]) {
      for (const file of files) {
        const dir = repoWith(['package.json', file]);
        try {
          expect(detectLockfile(dir)?.pm, `${file} detects as ${pm}`).toBe(pm);
          const s = nodeInstallStrategy.strategy(dir)!;
          expect(s.manager, `${file} installs with ${pm}`).toBe(pm);
          expect(s).toBe(NODE_STRATEGY_BY_PM[pm]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });

  it('no package.json → nothing to install (the hint still names an install)', () => {
    const dir = repoWith([]);
    try {
      expect(nodeInstallStrategy.strategy(dir)).toBeNull();
      expect(nodeProvisionHint(dir)).toBe('npm install');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every resync is a lock-WRITING form, never the frozen install', () => {
    for (const pm of Object.keys(LOCKFILES) as PackageManager[]) {
      const resync = NODE_STRATEGY_BY_PM[pm].modes.resync!;
      const text = [resync.primary.bin, ...resync.primary.args].join(' ');
      expect(text).not.toContain(' --frozen-lockfile');
      expect(text).not.toContain(' --immutable');
      expect(resync.primary.args).not.toContain('ci');
    }
  });

  it('the npm peer-conflict fallback is composable (viaFlags) so the bump lane can apply it to its own argv', () => {
    const fb = NODE_STRATEGY_BY_PM.npm.modes.resync!.fallbacks[0];
    expect(fb.when).toBe('peer-conflict');
    expect(fb.viaFlags).toEqual(['--legacy-peer-deps']);
    expect(fb.command.args).toEqual([
      ...NODE_STRATEGY_BY_PM.npm.modes.resync!.primary.args,
      ...fb.viaFlags!,
    ]);
  });
});

describe('the npm classifiers', () => {
  it('a peer conflict (ERESOLVE) is the one --legacy-peer-deps answers', () => {
    expect(isPeerConflictOnly('npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve')).toBe(
      true,
    );
    expect(isPeerConflictOnly('npm ERR! peer dep missing: react@^18')).toBe(true);
  });
  it('an out-of-sync lockfile (EUSAGE) is NOT, even when ERESOLVE text is around', () => {
    const drift =
      'npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync.\nnpm ERR! Missing: left-pad@1.3.0 from lock file';
    expect(isPeerConflictOnly(drift)).toBe(false);
    expect(isLockfileDrift(drift)).toBe(true);
    expect(isPeerConflictOnly('code EUSAGE ... ERESOLVE')).toBe(false);
    expect(NODE_STRATEGY_BY_PM.npm.modes.frozen.classifyFailure!(drift)).toBe(LOCKFILE_DRIFT);
  });
  it('an unrelated failure is neither', () => {
    expect(isPeerConflictOnly('npm ERR! code ENOTFOUND')).toBe(false);
    expect(isLockfileDrift('npm ERR! code ENOTFOUND')).toBe(false);
    expect(isPeerConflictOnly('')).toBe(false);
  });
  it('yarn classic rejecting a berry flag is the unsupported-flag shape; a berry immutable failure is not', () => {
    expect(isYarnClassicFlagRejection("error: unknown option '--immutable'")).toBe(true);
    expect(isYarnClassicFlagRejection('error Unknown option: --no-immutable')).toBe(true);
    expect(isYarnClassicFlagRejection('YN0028: The lockfile would have been modified')).toBe(false);
  });
});

describe('the derived lockfile-sync check', () => {
  it('npm: a non-installing dry-run that tolerates a peer conflict only, under the default tolerances', () => {
    const c = lockfileCheckFromStrategy(NODE_STRATEGY_BY_PM.npm, defaultResolvedTolerances());
    expect(c?.kind).toBe('command');
    if (c?.kind !== 'command') return;
    expect([c.command.bin, ...c.command.args]).toEqual([
      'npm',
      'ci',
      '--dry-run',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    expect(c.tolerated?.matches('npm ERR! code ERESOLVE')).toBe(true);
    expect(c.tolerated?.matches('npm ERR! code EUSAGE not in sync')).toBe(false);
    expect(c.tolerated?.disclosure).toContain('peer-conflict');
  });
  it('npm: with the peer-conflict tolerance withdrawn, the dry-run tolerates nothing', () => {
    const c = lockfileCheckFromStrategy(NODE_STRATEGY_BY_PM.npm, {
      tolerated: new Set(),
      sources: new Map(),
      unknown: [],
    });
    expect(c?.kind === 'command' && c.tolerated).toBeFalsy();
  });
  it('bun: a frozen dry-run with no tolerated failure', () => {
    const c = lockfileCheckFromStrategy(NODE_STRATEGY_BY_PM.bun, defaultResolvedTolerances());
    expect(c?.kind).toBe('command');
    if (c?.kind !== 'command') return;
    expect(c.command.bin).toBe('bun');
    expect(c.command.args).toContain('--dry-run');
    expect(c.tolerated).toBeUndefined();
  });
  it('pnpm and yarn: DISCLOSED skips, never a lockfile-writing command', () => {
    for (const pm of ['pnpm', 'yarn'] as const) {
      const c = lockfileCheckFromStrategy(NODE_STRATEGY_BY_PM[pm], defaultResolvedTolerances());
      expect(c?.kind).toBe('skipped');
      if (c?.kind === 'skipped') expect(c.reason).toContain('backstop');
    }
  });
});
