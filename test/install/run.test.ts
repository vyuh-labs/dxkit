import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyInstallFailure,
  composePlan,
  describeInfrastructure,
  describeUnauthorizedFallback,
  runInstall,
} from '../../src/install/run';
import {
  defaultResolvedTolerances,
  describeTolerances,
  resolveTolerances,
  toleranceWarnings,
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
const NONE: ResolvedTolerances = {
  tolerated: new Set(),
  sources: new Map(),
  unknown: [],
  conflicts: [],
};

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

  it('both fail with the SAME class: reported against the fallback, both outputs kept, no history field', () => {
    const { exec } = scripted(() => ({ code: 1, output: 'PEER still' }));
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.command.args).toContain('--tolerate-peers');
      expect(r.classification).toBe('peer-conflict');
      expect(r.primaryClassification).toBeUndefined();
      expect(r.output).toContain('--- fallback');
      expect(r.attempts).toHaveLength(2);
    }
  });

  // Item-3 class: the fallback ran and failed DIFFERENTLY (the peer conflict
  // it answered gave way to another break). The result classifies the FINAL
  // failing output — attribution compares what actually stopped the install
  // — and keeps the primary's class as disclosed history.
  it('a fallback that fails with a DIFFERENT class re-classifies the final output and keeps the primary class as history', () => {
    const { exec } = scripted((argv) =>
      argv.includes('--tolerate-peers')
        ? { code: 1, output: 'DRIFT after retry' }
        : { code: 1, output: 'PEER' },
    );
    const r = runInstall(PLAN, '/repo', exec, ALL);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.command.args).toContain('--tolerate-peers');
      expect(r.classification).toBe('lockfile-drift');
      expect(r.primaryClassification).toBe('peer-conflict');
    }
  });

  // Rule 20 fold-in: the strategy's declared execution requirement gates the
  // spawn — an unmet environment is infrastructure decided BEFORE anything
  // runs, never an install verdict.
  it('an unmet execution requirement is environment infrastructure, decided before any spawn', () => {
    const { exec, argvs } = scripted(() => ({}));
    const r = runInstall(PLAN, '/repo', exec, ALL, {
      execution: {
        hosts: ['windows'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      },
      env: { host: 'linux', hasToolchain: () => true },
    });
    expect(argvs).toEqual([]);
    expect(r.status).toBe('infrastructure');
    if (r.status === 'infrastructure') {
      expect(r.reason).toBe('environment');
      expect(describeInfrastructure(r)).toContain('cannot run in this environment');
    }
    // Met requirement: the plan executes normally.
    const met = runInstall(PLAN, '/repo', exec, ALL, {
      execution: {
        hosts: ['any'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      },
      env: { host: 'linux', hasToolchain: () => true },
    });
    expect(met.status).toBe('ok');
  });

  // Item-10: composePlan re-bases the COMPOSABLE fallbacks (viaFlags) onto a
  // caller-built primary, so the dep-bump lane inherits the one ladder.
  it('composePlan: composable fallbacks re-base onto the custom primary; non-composable ones drop', () => {
    const custom = { bin: 'pm', args: ['add', 'pkg@1.2.3'] };
    const composed = composePlan(PLAN, custom);
    expect(composed.primary).toEqual(custom);
    expect(composed.fallbacks).toHaveLength(1);
    expect(composed.fallbacks[0].when).toBe('peer-conflict');
    expect(composed.fallbacks[0].command).toEqual({
      bin: 'pm',
      args: ['add', 'pkg@1.2.3', '--tolerate-peers'],
    });
    expect(composed.classifyFailure).toBe(PLAN.classifyFailure);
    const { exec, argvs } = scripted((argv) =>
      argv.includes('--tolerate-peers') ? {} : { code: 1, output: 'PEER' },
    );
    const r = runInstall(composed, '/repo', exec, ALL);
    expect(argvs).toEqual(['pm add pkg@1.2.3', 'pm add pkg@1.2.3 --tolerate-peers']);
    expect(r.status === 'ok' && r.fallback?.when).toBe('peer-conflict');
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

  it('an observed .npmrc legacy-peer-deps=true authorizes peer-conflict when policy says NOTHING (repo-config source)', () => {
    const dir = repo({
      '.npmrc': 'registry=https://registry.npmjs.org/\nlegacy-peer-deps = true\n',
    });
    try {
      const t = resolveTolerances(dir);
      expect(t.tolerated.has('peer-conflict')).toBe(true);
      expect(t.sources.get('peer-conflict')).toBe('repo-config');
      expect(t.conflicts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Item-8 precedence: an EXPLICIT policy opt-out is a decision the observed
  // config cannot silently override; the disagreement is disclosed.
  it('an explicit tolerate: [] beats an observed .npmrc declaration, with the conflict disclosed', () => {
    const dir = repo({
      '.npmrc': 'legacy-peer-deps=true\n',
      '.dxkit/policy.json': JSON.stringify({ dependencies: { tolerate: [] } }),
    });
    try {
      const t = resolveTolerances(dir);
      expect(t.tolerated.has('peer-conflict')).toBe(false);
      expect(t.conflicts).toHaveLength(1);
      expect(t.conflicts[0]).toContain('.npmrc legacy-peer-deps=true');
      expect(t.conflicts[0]).toContain('policy opt-out stands');
      expect(toleranceWarnings(t)).toEqual(t.conflicts);
      expect(describeTolerances(t)).toContain('policy opt-out stands');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Item-9: the accepted set IS the schema enum's list (policyTolerances):
  // an intrinsic class in policy is not a policy decision and is disclosed.
  it('an intrinsic class named in policy reads as a non-settable entry, disclosed through toleranceWarnings', () => {
    const dir = repo({
      '.dxkit/policy.json': JSON.stringify({
        dependencies: { tolerate: ['peer-conflict', 'unsupported-flag'] },
      }),
    });
    try {
      const t = resolveTolerances(dir);
      expect(t.tolerated.has('peer-conflict')).toBe(true);
      // Intrinsic classes still apply — they are just not POLICY entries.
      expect(t.tolerated.has('unsupported-flag')).toBe(true);
      expect(t.unknown).toEqual(['unsupported-flag']);
      const warnings = toleranceWarnings(t);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not a policy-settable');
      expect(warnings[0]).toContain('settable: peer-conflict');
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
