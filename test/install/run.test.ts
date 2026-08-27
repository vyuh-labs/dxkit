import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyInstallFailure,
  describeInfrastructure,
  describeUnauthorizedFallback,
  runInstall,
} from '../../src/install/run';
import {
  defaultResolvedTolerances,
  describeTolerances,
  resolveTolerances,
  type ResolvedTolerances,
} from '../../src/install/tolerances';
import {
  ALL_TOLERANCE_CLASSES,
  TOLERANCE_CLASSES,
  policyTolerances,
  type InstallPlan,
} from '../../src/languages/capabilities/install-strategy';
import type { CommandExec } from '../../src/analyzers/tools/bounded-exec';

/**
 * The ONE install executor and the ONE tolerance resolver (4.4.6). The
 * executor owns the fallback ladder: a fallback runs only when its class is
 * authorized AND the primary's failure has that class's shape; every other
 * failure is reported against the primary with the pack's classification.
 * The resolver owns authorization: policy replaces the default set, an
 * observed repo config authorizes, intrinsic classes always apply.
 */

const PLAN: InstallPlan = {
  primary: { bin: 'pm', args: ['install'] },
  fallbacks: [
    {
      command: { bin: 'pm', args: ['install', '--tolerate-peers'] },
      when: 'peer-conflict',
      matches: (o) => o.includes('PEER'),
      disclosure: 'peer conflict tolerated',
      viaFlags: ['--tolerate-peers'],
    },
    {
      command: { bin: 'pm', args: ['install', '--old-flag'] },
      when: 'unsupported-flag',
      matches: (o) => o.includes('UNKNOWN-FLAG'),
      disclosure: 'older manager spelling',
    },
  ],
  classifyFailure: (o) => (o.includes('DRIFT') ? 'lockfile-drift' : null),
};

const ALL: ResolvedTolerances = defaultResolvedTolerances();
const NONE: ResolvedTolerances = { tolerated: new Set(), sources: new Map(), unknown: [] };

function scripted(script: (argv: readonly string[]) => Partial<ReturnType<CommandExec>>): {
  exec: CommandExec;
  argvs: string[];
} {
  const argvs: string[] = [];
  return {
    argvs,
    exec: (cmd) => {
      const argv = [cmd.bin, ...cmd.args];
      argvs.push(argv.join(' '));
      return { available: true, code: 0, output: '', ...script(argv) };
    },
  };
}

describe('runInstall', () => {
  it('primary ok: no fallback consulted', () => {
    const { exec, argvs } = scripted(() => ({}));
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(r.status).toBe('ok');
    expect(argvs).toEqual(['pm install']);
    if (r.status === 'ok') expect(r.fallback).toBeUndefined();
  });

  it('primary fails with a tolerated, authorized shape: the matching fallback runs and is disclosed', () => {
    const { exec, argvs } = scripted((argv) =>
      argv.includes('--tolerate-peers') ? {} : { code: 1, output: 'PEER' },
    );
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(argvs).toEqual(['pm install', 'pm install --tolerate-peers']);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.fallback?.when).toBe('peer-conflict');
      expect(r.fallback?.disclosure).toBe('peer conflict tolerated');
      expect(r.attempts).toHaveLength(2);
    }
  });

  it('the fallback whose class matches is picked, not the first declared', () => {
    const { exec, argvs } = scripted((argv) =>
      argv.includes('--old-flag') ? {} : { code: 1, output: 'UNKNOWN-FLAG' },
    );
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(argvs).toEqual(['pm install', 'pm install --old-flag']);
    expect(r.status === 'ok' && r.fallback?.when).toBe('unsupported-flag');
  });

  it('a failure no fallback answers is reported against the PRIMARY with the plan classification; nothing retried', () => {
    const { exec, argvs } = scripted(() => ({ code: 1, output: 'DRIFT: lockfile stale' }));
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(argvs).toEqual(['pm install']);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.command).toEqual(PLAN.primary);
      expect(r.classification).toBe('lockfile-drift');
      expect(r.unauthorized).toBeUndefined();
    }
  });

  it('an unrecognized failure is unclassified, against the primary', () => {
    const { exec } = scripted(() => ({ code: 1, output: 'EACCES' }));
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(r.status === 'failed' && r.classification).toBe('unclassified');
  });

  it('a tolerated shape whose class is NOT authorized: failed against the primary, the fallback named as the remedy, no retry', () => {
    const { exec, argvs } = scripted(() => ({ code: 1, output: 'PEER' }));
    const r = runInstall(PLAN, '/repo', exec, NONE);
    expect(argvs).toEqual(['pm install']);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.classification).toBe('peer-conflict');
      expect(r.unauthorized?.when).toBe('peer-conflict');
      const remedy = describeUnauthorizedFallback(r, 'dependencies.tolerate')!;
      expect(remedy).toContain('pm install --tolerate-peers');
      expect(remedy).toContain('dependencies.tolerate');
    }
  });

  it('both fail: reported against the fallback, both outputs kept', () => {
    const { exec } = scripted(() => ({ code: 1, output: 'PEER still' }));
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.command.args).toContain('--tolerate-peers');
      expect(r.output).toContain('--- fallback');
      expect(r.attempts).toHaveLength(2);
    }
  });

  it('infrastructure on the primary or the fallback is its own outcome, never a failure verdict', () => {
    const unavailable = runInstall(
      PLAN,
      '/repo',
      () => ({ available: false, code: -1, output: 'pm: not found' }),
      ALL,
    );
    expect(unavailable.status).toBe('infrastructure');
    if (unavailable.status === 'infrastructure') {
      expect(unavailable.reason).toBe('unavailable');
      expect(describeInfrastructure(unavailable)).toContain('pm is not available');
    }
    const { exec } = scripted((argv) =>
      argv.includes('--tolerate-peers')
        ? { timedOut: true, code: -1 }
        : { code: 1, output: 'PEER' },
    );
    const timedOut = runInstall(PLAN, '/repo', exec, ALL);
    expect(timedOut.status).toBe('infrastructure');
    if (timedOut.status === 'infrastructure') {
      expect(timedOut.reason).toBe('timed-out');
      expect(describeInfrastructure(timedOut)).toContain('pm install --tolerate-peers');
    }
    const overflowed = runInstall(
      PLAN,
      '/repo',
      () => ({ available: true, overflowed: true, code: 1, output: 'x' }),
      ALL,
    );
    expect(overflowed.status === 'infrastructure' && overflowed.reason).toBe('overflowed');
  });

  it('classifyInstallFailure: the first matching fallback names the class; the plan classifier is the backstop', () => {
    expect(classifyInstallFailure(PLAN, 'PEER').classification).toBe('peer-conflict');
    expect(classifyInstallFailure(PLAN, 'DRIFT').fallback).toBeNull();
    expect(classifyInstallFailure(PLAN, 'DRIFT').classification).toBe('lockfile-drift');
    expect(classifyInstallFailure({ ...PLAN, classifyFailure: undefined }, 'DRIFT')).toEqual({
      classification: 'unclassified',
      fallback: null,
    });
  });
});

describe('resolveTolerances', () => {
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-tolerances-'));
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    return dir;
  }

  it('the registry: every class carries a doctrine, and peer-conflict is default-on', () => {
    for (const cls of ALL_TOLERANCE_CLASSES) {
      expect(TOLERANCE_CLASSES[cls].summary.length).toBeGreaterThan(0);
    }
    expect(TOLERANCE_CLASSES['peer-conflict'].authorization).toBe('default-on');
    expect(TOLERANCE_CLASSES['unsupported-flag'].authorization).toBe('intrinsic');
    expect(policyTolerances()).toEqual(['peer-conflict']);
  });

  it('no policy, no repo config: the declared defaults (default-on + intrinsic)', () => {
    const dir = repo({});
    try {
      const t = resolveTolerances(dir);
      expect([...t.tolerated].sort()).toEqual(['peer-conflict', 'unsupported-flag']);
      expect(t.sources.get('peer-conflict')).toBe('default');
      expect(t).toEqual(defaultResolvedTolerances());
      expect(describeTolerances(t)).toBe('install tolerances: peer-conflict (default)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('policy REPLACES the default set: an empty list withdraws peer-conflict; intrinsic classes stay', () => {
    const dir = repo({ '.dxkit/policy.json': JSON.stringify({ dependencies: { tolerate: [] } }) });
    try {
      const t = resolveTolerances(dir);
      expect([...t.tolerated]).toEqual(['unsupported-flag']);
      expect(describeTolerances(t)).toContain('peer-conflict (not tolerated)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('policy naming the class authorizes it, with the source disclosed; unknown entries are disclosed, never dropped silently', () => {
    const dir = repo({
      '.dxkit/policy.json': JSON.stringify({
        dependencies: { tolerate: ['peer-conflict', 'not-a-class'] },
      }),
    });
    try {
      const t = resolveTolerances(dir);
      expect(t.tolerated.has('peer-conflict')).toBe(true);
      expect(t.sources.get('peer-conflict')).toBe('policy');
      expect(t.unknown).toEqual(['not-a-class']);
      expect(describeTolerances(t)).toContain(
        'unknown dependencies.tolerate entries ignored: not-a-class',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an observed .npmrc legacy-peer-deps=true authorizes peer-conflict even when policy withdrew it (repo-config source)', () => {
    const dir = repo({
      '.npmrc': 'registry=https://registry.npmjs.org/\nlegacy-peer-deps=true\n',
      '.dxkit/policy.json': JSON.stringify({ dependencies: { tolerate: [] } }),
    });
    try {
      const t = resolveTolerances(dir);
      expect(t.tolerated.has('peer-conflict')).toBe(true);
      expect(t.sources.get('peer-conflict')).toBe('repo-config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed policy reads as absent (fail-open to the defaults), never a throw', () => {
    const dir = repo({ '.dxkit/policy.json': '{not json' });
    try {
      expect(resolveTolerances(dir)).toEqual(defaultResolvedTolerances());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
