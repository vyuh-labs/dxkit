import { describe, it, expect } from 'vitest';
import {
  describeInstall,
  runDeclaredInstall,
  verifyTree,
  type InstallOutcome,
  type VerifyTreeOptions,
  type VerifyTreeSeams,
} from '../../src/lanes/verify-tree';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { AnalysisTrustContext } from '../../src/analysis-trust';
import { renderFloorVerification } from '../../src/lanes/verification-render';
import type { LanguageSupport } from '../../src/languages/types';
import type {
  InstallStrategy,
  InstallStrategyProvider,
} from '../../src/languages/capabilities/install-strategy';
import { defaultResolvedTolerances, type ResolvedTolerances } from '../../src/install/tolerances';

/**
 * The ONE tree verification (4.4.5): a clean worktree of the candidate, the
 * repo's declared frozen install, the diff-scoped floor attributed vs entry,
 * the guardrail. Every step is injected here so the COMPOSITION is what is
 * pinned: an install that fails is its own verdict and nothing downstream
 * runs; an infrastructure failure is a disclosed step failure, never a pass
 * and never a false block; and the floor sees the worktree + the real diff,
 * not the lane's dirty cwd with an empty changed-set.
 */

const TRUSTED = { repoExecutionAllowed: true, source: 'local-workspace' } as AnalysisTrustContext;
const GREEN: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };
const RED: CorrectnessFloorResult = {
  ran: true,
  checks: [{ pack: 'typescript', label: 'typecheck', bin: 'npx', status: 'fail' }],
  blocks: true,
};
const INSTALLED: InstallOutcome = {
  status: 'installed',
  steps: [{ pack: 'typescript', argv: ['npm', 'ci'] }],
};
const DRIFTED: InstallOutcome = {
  status: 'failed',
  pack: 'typescript',
  argv: ['npm', 'ci'],
  output: 'npm ERR! code EUSAGE',
  classification: 'lockfile-drift',
};

function seams(over: Partial<VerifyTreeSeams> = {}): VerifyTreeSeams {
  return {
    // Ref-addressed fake paths so the base-attribution probe (which opens a
    // second worktree at baseHead) is distinguishable in the install seam.
    worktree: async (o, fn) => fn(`/wt/${o.ref}`),
    install: () => INSTALLED,
    changedFiles: () => ['src/a.ts'],
    runFloor: () => GREEN,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    ...over,
  };
}

/** An install seam that fails on the CANDIDATE worktree only (the base
 *  probe, addressed by baseHead, installs clean). */
function failsOnCandidate(output: string): (wt: string) => InstallOutcome {
  return (wt) => (wt.endsWith('head1111') ? { ...DRIFTED, output } : INSTALLED);
}

function opts(over: Partial<VerifyTreeOptions> = {}): VerifyTreeOptions {
  return {
    cwd: '/tmp/fake-repo',
    head: 'head1111',
    baseHead: 'base0000',
    trust: TRUSTED,
    entryFloor: GREEN,
    absentMeans: 'net-new',
    seams: seams(),
    ...over,
  };
}

describe('verifyTree', () => {
  it('verified: install ok, floor net-new-clean, guardrail passes', async () => {
    const r = await verifyTree(opts());
    expect(r.verdict).toBe('verified');
    expect(r.install).toEqual(INSTALLED);
    expect(r.changedFiles).toEqual(['src/a.ts']);
    expect(r.guardrail?.verdict).toBe('PASSED');
    expect(r.failure).toBeUndefined();
  });

  it('install-failed: a NET-NEW install failure (base installs clean) is its own verdict and NOTHING downstream runs', async () => {
    let floorRan = false;
    let guardrailRan = false;
    const r = await verifyTree(
      opts({
        seams: seams({
          install: failsOnCandidate('npm ERR! code EUSAGE\nnot in sync'),
          runFloor: () => {
            floorRan = true;
            return GREEN;
          },
          runGuardrail: async () => {
            guardrailRan = true;
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(r.verdict).toBe('install-failed');
    expect(r.install?.status).toBe('failed');
    if (r.install?.status === 'failed') {
      expect(r.install.attribution).toBe('net-new');
      // The probe's evidence travels with the verdict: the base installed.
      expect(r.install.base?.status).toBe('installed');
    }
    // The diff was computed before the install and survives into the result.
    expect(r.changedFiles).toEqual(['src/a.ts']);
    expect(floorRan).toBe(false);
    expect(guardrailRan).toBe(false);
    const line = describeInstall(r.install)!;
    expect(line).toContain('FAILED on a clean checkout');
    expect(line).toContain('lockfile-drift');
    expect(line).toContain('The base installs');
  });

  // Finding-1 class: a lockfile already drifted at baseHead would fail the
  // frozen install on EVERY run. The base probe attributes it: an IDENTICAL
  // classification on both sides is pre-existing debt, disclosed, never
  // blamed, and verification proceeds.
  it('a PRE-EXISTING install failure (base fails with the same classification) is disclosed and verification proceeds', async () => {
    const probed: string[] = [];
    const r = await verifyTree(
      opts({
        seams: seams({
          install: (wt) => {
            probed.push(wt);
            return DRIFTED;
          },
        }),
      }),
    );
    expect(probed).toEqual(['/wt/head1111', '/wt/base0000']);
    expect(r.verdict).toBe('verified');
    if (r.install?.status === 'failed') {
      expect(r.install.attribution).toBe('pre-existing');
      expect(r.install.base).toEqual({
        status: 'failed',
        argv: ['npm', 'ci'],
        classification: 'lockfile-drift',
      });
    }
    const line = describeInstall(r.install)!;
    expect(line).toContain('pre-existing');
    expect(line).toContain('not caused by this change');
    expect(line).toContain('lockfile-drift on both sides');
  });

  // A base that fails for a DIFFERENT reason does not absolve the candidate:
  // the candidate changed the failure, so it is attributed net-new with the
  // base's own classification named as the evidence.
  it('a base that fails DIFFERENTLY leaves the candidate failure net-new, with both classifications named', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: (wt) =>
            wt.endsWith('head1111')
              ? DRIFTED
              : { ...DRIFTED, output: 'ERESOLVE', classification: 'peer-conflict' },
        }),
      }),
    );
    expect(r.verdict).toBe('install-failed');
    if (r.install?.status === 'failed') {
      expect(r.install.attribution).toBe('net-new');
      expect(r.install.base).toMatchObject({ status: 'failed', classification: 'peer-conflict' });
    }
    expect(describeInstall(r.install)).toContain('fails DIFFERENTLY');
  });

  // The unprovisioned-worktree class (4.4.5): with the install broken at the
  // base too, the worktree has no node_modules, so a floor run reports "tsc:
  // not found" (exit 127) as a failure the entry floor never saw, and the
  // comparator attributes it NET-NEW. Nothing about the change is observable
  // there: the floor is skipped with the reason named, the guardrail (which
  // needs no dependency tree) still decides.
  it('a PRE-EXISTING broken install skips the floor as a DISCLOSED unprovisioned outcome, never floor-red', async () => {
    let floorRan = false;
    let guardrailRan = false;
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => DRIFTED,
          runFloor: () => {
            floorRan = true;
            return {
              ran: true,
              blocks: true,
              checks: [
                {
                  pack: 'typescript',
                  label: 'typecheck',
                  bin: 'npm',
                  status: 'fail',
                  output: 'sh: 1: tsc: not found',
                },
              ],
            };
          },
          runGuardrail: async () => {
            guardrailRan = true;
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(floorRan).toBe(false);
    expect(guardrailRan).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(r.floor).toBeUndefined();
    expect(r.floorAttribution).toBeUndefined();
    expect(r.floorSkipped?.reason).toBe('unprovisioned');
    expect(r.floorSkipped?.detail).toContain('npm ci');
    expect(r.floorSkipped?.detail).toContain('cannot be attributed');
    // The ledger renders the skip as a reason, never as "dry run" and never
    // as a pass.
    const lines = renderFloorVerification(r.floor, r.floorAttribution, 'entry', r.floorSkipped);
    expect(lines[0]).toContain('not run');
    expect(lines[0]).toContain('unprovisioned');
    expect(lines.join('\n')).not.toContain('dry run');
    expect(lines.join('\n')).not.toContain('passed');
  });

  it('a pre-existing broken install still lets a RED guardrail block', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => DRIFTED,
          runGuardrail: async () => ({ verdict: 'BLOCKED', ran: true, passesGate: false }),
        }),
      }),
    );
    expect(r.verdict).toBe('guardrail-red');
    expect(r.floorSkipped?.reason).toBe('unprovisioned');
  });

  it('a base probe that cannot run is a disclosed error at step base-install, never a blame', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          worktree: async (o, fn) => {
            if (o.ref === 'base0000') throw new Error('base ref unreachable');
            return fn(`/wt/${o.ref}`);
          },
          install: () => DRIFTED,
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure).toEqual({ step: 'base-install', message: 'base ref unreachable' });
  });

  // Finding-4 class (Rule 17): the seam gates on trust ITSELF — the install
  // runs lifecycle scripts and the floor runs repo-declared commands, so an
  // untrusted tree must never spawn either, by design not caller convention.
  it('an untrusted tree is a disclosed skipped-untrusted verdict; nothing spawns', async () => {
    const touched: string[] = [];
    const r = await verifyTree(
      opts({
        trust: { repoExecutionAllowed: false, source: 'untrusted-content' } as AnalysisTrustContext,
        seams: seams({
          worktree: async (o, fn) => {
            touched.push('worktree');
            return fn(`/wt/${o.ref}`);
          },
          install: () => {
            touched.push('install');
            return INSTALLED;
          },
          runFloor: () => {
            touched.push('floor');
            return GREEN;
          },
        }),
      }),
    );
    expect(r.verdict).toBe('skipped-untrusted');
    expect(touched).toEqual([]);
    expect(r.failure?.step).toBe('trust');
    expect(r.failure?.message).toContain('untrusted-content');
  });

  it('the fallback install is disclosed, never silent, and the verdict proceeds normally', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => ({
            status: 'installed',
            steps: [
              {
                pack: 'typescript',
                argv: ['npm', 'ci'],
                fallback: {
                  argv: ['npm', 'ci', '--legacy-peer-deps'],
                  when: 'peer-conflict',
                  reason: 'the tree only resolves under --legacy-peer-deps',
                },
              },
            ],
          }),
        }),
      }),
    );
    expect(r.verdict).toBe('verified');
    expect(r.floor).toEqual(GREEN);
    expect(describeInstall(r.install)).toContain('`npm ci --legacy-peer-deps` succeeded');
    expect(describeInstall(r.install)).toContain('peer-conflict');
  });

  it('floor-red: a NET-NEW failure vs the entry floor blocks; the guardrail is not consulted', async () => {
    let guardrailRan = false;
    const r = await verifyTree(
      opts({
        seams: seams({
          runFloor: () => RED,
          runGuardrail: async () => {
            guardrailRan = true;
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(r.verdict).toBe('floor-red');
    expect(r.floorAttribution?.some((a) => a.attribution === 'net-new')).toBe(true);
    expect(guardrailRan).toBe(false);
  });

  it('pre-existing floor debt (red at entry too) does not block', async () => {
    const r = await verifyTree(opts({ entryFloor: RED, seams: seams({ runFloor: () => RED }) }));
    expect(r.verdict).toBe('verified');
    expect(r.floorAttribution?.every((a) => a.attribution === 'pre-existing')).toBe(true);
  });

  it('the floor runs IN THE WORKTREE with the REAL diff, diff-scoped (never cwd + [])', async () => {
    let seen: { cwd: string; changedFiles: readonly string[] | null } | undefined;
    const r = await verifyTree(
      opts({
        seams: seams({
          worktree: async (o, fn) => {
            expect(o).toEqual({ cwd: '/tmp/fake-repo', ref: 'head1111' });
            return fn('/tmp/wt-xyz');
          },
          changedFiles: (wt, base) => {
            expect(wt).toBe('/tmp/wt-xyz');
            expect(base).toBe('base0000');
            return ['package.json', 'src/b.ts'];
          },
          runFloor: (args) => {
            seen = args;
            return GREEN;
          },
          runGuardrail: async (wt) => {
            expect(wt).toBe('/tmp/wt-xyz');
            return { verdict: 'PASSED', ran: true, passesGate: true };
          },
        }),
      }),
    );
    expect(r.verdict).toBe('verified');
    expect(seen).toEqual({ cwd: '/tmp/wt-xyz', changedFiles: ['package.json', 'src/b.ts'] });
  });

  // An UNDETERMINABLE diff reaches the floor as null (unknown), never as an
  // empty array (known: nothing changed): the runner keeps change-triggered
  // checks (the lockfile dry-run) running only in the unknown case. The
  // result still reports the empty projection for its readers.
  it('an undeterminable diff reaches the floor as null, not as an empty (known) set', async () => {
    let seen: { cwd: string; changedFiles: readonly string[] | null } | undefined;
    const r = await verifyTree(
      opts({
        seams: seams({
          changedFiles: () => null,
          runFloor: (args) => {
            seen = args;
            return GREEN;
          },
        }),
      }),
    );
    expect(r.verdict).toBe('verified');
    expect(seen?.changedFiles).toBeNull();
    expect(r.changedFiles).toEqual([]);
  });

  it('guardrail-red: a BLOCKED guardrail', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          runGuardrail: async () => ({ verdict: 'BLOCKED', ran: true, passesGate: false }),
        }),
      }),
    );
    expect(r.verdict).toBe('guardrail-red');
  });

  it('error: a worktree that cannot be created is a DISCLOSED step failure, never a pass', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          worktree: async () => {
            throw new Error('Cannot resolve baseline ref head1111.');
          },
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure).toEqual({
      step: 'worktree',
      message: 'Cannot resolve baseline ref head1111.',
    });
    expect(r.install).toBeUndefined();
  });

  it('error: a package manager missing from the environment names the install step', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => {
            throw new Error('pnpm is not available in the verification environment');
          },
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure?.step).toBe('install');
    expect(r.failure?.message).toContain('pnpm is not available');
  });

  it('error: an unrunnable guardrail names the guardrail step', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          runGuardrail: async () => ({
            verdict: 'unavailable (boom)',
            ran: false,
            passesGate: false,
          }),
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure).toEqual({ step: 'guardrail', message: 'unavailable (boom)' });
  });

  it('reports steps in order through onStep — the diff BEFORE the install', async () => {
    const steps: string[] = [];
    await verifyTree(opts({ onStep: (s) => steps.push(s) }));
    expect(steps).toEqual([
      'worktree',
      'changed-files',
      'install',
      'floor',
      'attribution',
      'guardrail',
    ]);
  });

  // Finding-6 class: an install can rewrite the lockfile or drop node_modules
  // into an unignored tree; computed after the install those artifacts read
  // as the agent's diff and force a bogus manifest escalation.
  it('changedFiles is computed on the PRISTINE checkout, before the install mutates it', async () => {
    const order: string[] = [];
    await verifyTree(
      opts({
        seams: seams({
          changedFiles: () => {
            order.push('changed-files');
            return ['src/a.ts'];
          },
          install: () => {
            order.push('install');
            return INSTALLED;
          },
        }),
      }),
    );
    expect(order).toEqual(['changed-files', 'install']);
  });
});

/** A pack stub declaring (or not) an install strategy; only the fields the
 *  install runner reads. */
function pack(id: string, strategy: InstallStrategy | null): LanguageSupport {
  // A stub provider that applies at ANY dir (the fake worktree paths here do
  // not exist on disk), never the file-keyed derivation.
  const provider: InstallStrategyProvider | undefined = strategy
    ? {
        variants: () => [{ when: [], strategy }],
        strategy: () => strategy,
        ciDependencyInstall: false,
      }
    : undefined;
  return { id, ...(provider ? { installStrategy: provider } : {}) } as unknown as LanguageSupport;
}

const EXEC_ANY = {
  hosts: ['any' as const],
  toolchains: [],
  needsBuild: false,
  buildTarget: 'none' as const,
  weight: 'cheap' as const,
};

/** An npm-shaped strategy with the peer-conflict fallback and a drift classifier. */
const NPM: InstallStrategy = {
  manager: 'npm',
  lockfile: 'package-lock.json',
  modes: {
    frozen: {
      primary: { bin: 'npm', args: ['ci'] },
      fallbacks: [
        {
          command: { bin: 'npm', args: ['ci', '--legacy-peer-deps'] },
          when: 'peer-conflict',
          matches: (o) => /ERESOLVE/.test(o) && !/EUSAGE/.test(o),
          disclosure: 'peer conflict',
        },
      ],
      classifyFailure: (o) => (/EUSAGE/.test(o) ? 'lockfile-drift' : null),
    },
  },
  execution: EXEC_ANY,
};

const BUNDLER: InstallStrategy = {
  manager: 'bundler',
  lockfile: 'Gemfile.lock',
  modes: { frozen: { primary: { bin: 'bundle', args: ['install'] }, fallbacks: [] } },
  execution: EXEC_ANY,
};

const PIP: InstallStrategy = {
  manager: 'pip',
  lockfile: null,
  modes: {
    frozen: { primary: { bin: 'pip', args: ['install', '-r', 'requirements.txt'] }, fallbacks: [] },
  },
  execution: EXEC_ANY,
};

const TOLERANT: ResolvedTolerances = defaultResolvedTolerances();
const INTOLERANT: ResolvedTolerances = {
  tolerated: new Set(),
  sources: new Map(),
  unknown: [],
};

describe('runDeclaredInstall', () => {
  it('primary succeeds: installed with the pack + primary argv', () => {
    const argvs: string[] = [];
    const r = runDeclaredInstall(
      '/wt',
      (cmd) => {
        argvs.push([cmd.bin, ...cmd.args].join(' '));
        return { available: true, code: 0, output: '' };
      },
      [pack('typescript', NPM)],
      TOLERANT,
    );
    expect(r).toEqual({
      status: 'installed',
      steps: [{ pack: 'typescript', argv: ['npm', 'ci'] }],
    });
    expect(argvs).toEqual(['npm ci']);
  });

  it('primary fails with the tolerated shape, fallback succeeds: installed with the fallback disclosed (the CI `a || b`)', () => {
    const r = runDeclaredInstall(
      '/wt',
      (cmd) =>
        cmd.args.includes('--legacy-peer-deps')
          ? { available: true, code: 0, output: '' }
          : { available: true, code: 1, output: 'npm ERR! code ERESOLVE' },
      [pack('typescript', NPM)],
      TOLERANT,
    );
    expect(r.status).toBe('installed');
    if (r.status === 'installed') {
      expect(r.steps[0].fallback?.argv).toEqual(['npm', 'ci', '--legacy-peer-deps']);
      expect(r.steps[0].fallback?.when).toBe('peer-conflict');
      expect(r.steps[0].fallback?.reason).toBe('peer conflict');
    }
  });

  // The live shape (the class this unit closes): a hand-edited lockfile
  // fails `npm ci` with EUSAGE. A blanket `a || b` ran the fallback into the
  // same failure and named the FALLBACK as the failing command, which read
  // as "the peer-conflict fallback is missing". The executor classifies the
  // primary's failure first: no fallback answers lockfile drift, so the
  // primary is the reported command and the fallback never runs.
  it('a failure no fallback answers (the stale-lockfile class) is reported against the PRIMARY; the fallback never runs', () => {
    const argvs: string[] = [];
    const r = runDeclaredInstall(
      '/wt',
      (cmd) => {
        argvs.push([cmd.bin, ...cmd.args].join(' '));
        return {
          available: true,
          code: 1,
          output:
            'npm ERR! code EUSAGE\nnpm ERR! package.json and package-lock.json are not in sync',
        };
      },
      [pack('typescript', NPM)],
      TOLERANT,
    );
    expect(argvs).toEqual(['npm ci']);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.pack).toBe('typescript');
      expect(r.argv).toEqual(['npm', 'ci']);
      expect(r.classification).toBe('lockfile-drift');
      expect(r.output).toContain('EUSAGE');
      expect(r.output).not.toContain('--- fallback');
    }
  });

  it('a tolerated shape whose class the repo does NOT authorize is a failure naming the remedy, no retry', () => {
    const argvs: string[] = [];
    const r = runDeclaredInstall(
      '/wt',
      (cmd) => {
        argvs.push([cmd.bin, ...cmd.args].join(' '));
        return { available: true, code: 1, output: 'npm ERR! code ERESOLVE' };
      },
      [pack('typescript', NPM)],
      INTOLERANT,
    );
    expect(argvs).toEqual(['npm ci']);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.classification).toBe('peer-conflict');
      expect(r.unauthorizedRemedy).toContain('dependencies.tolerate');
      expect(describeInstall(r)).toContain('dependencies.tolerate');
    }
  });

  it('both fail on a tolerated shape: failed against the fallback, both outputs kept', () => {
    const r = runDeclaredInstall(
      '/wt',
      () => ({ available: true, code: 1, output: 'npm ERR! code ERESOLVE' }),
      [pack('typescript', NPM)],
      TOLERANT,
    );
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.argv).toEqual(['npm', 'ci', '--legacy-peer-deps']);
      expect(r.classification).toBe('peer-conflict');
      expect(r.output).toContain('--- fallback');
    }
  });

  it('a pack without a fallback fails on its primary alone, unclassified', () => {
    const r = runDeclaredInstall(
      '/wt',
      () => ({ available: true, code: 1, output: 'boom' }),
      [pack('ruby', BUNDLER)],
      TOLERANT,
    );
    expect(r).toEqual({
      status: 'failed',
      pack: 'ruby',
      argv: ['bundle', 'install'],
      output: 'boom',
      classification: 'unclassified',
    });
  });

  // Item 19 (4.4.5): the install is PACK-DECLARED, so a polyglot tree runs
  // every declared install (a Python service beside a Node client), in
  // registry order, and the first failure is the outcome.
  it('every declaring pack installs, in order; a pack declaring null is skipped', () => {
    const argvs: string[] = [];
    const r = runDeclaredInstall(
      '/wt',
      (cmd) => {
        argvs.push([cmd.bin, ...cmd.args].join(' '));
        return { available: true, code: 0, output: '' };
      },
      [pack('python', PIP), pack('go', null), pack('typescript', NPM)],
      TOLERANT,
    );
    expect(argvs).toEqual(['pip install -r requirements.txt', 'npm ci']);
    expect(r).toEqual({
      status: 'installed',
      steps: [
        { pack: 'python', argv: ['pip', 'install', '-r', 'requirements.txt'] },
        { pack: 'typescript', argv: ['npm', 'ci'] },
      ],
    });
    expect(describeInstall(r)).toContain('`pip install -r requirements.txt` succeeded');
    expect(describeInstall(r)).toContain('`npm ci` succeeded');
  });

  it('a package manager not on PATH throws (infrastructure, the caller discloses the step)', () => {
    expect(() =>
      runDeclaredInstall(
        '/wt',
        () => ({ available: false, code: -1, output: 'pnpm: not found' }),
        [
          pack('typescript', {
            ...NPM,
            modes: {
              frozen: {
                primary: { bin: 'pnpm', args: ['install', '--frozen-lockfile'] },
                fallbacks: [],
              },
            },
          }),
        ],
        TOLERANT,
      ),
    ).toThrow(/pnpm is not available/);
  });

  // Finding-3 class (#272 shape): a run that did not finish says nothing
  // about the tree. A timed-out or overflowed install THROWS (a disclosed
  // error step in verifyTree), never "CI cannot install this tree".
  it('a timed-out primary install throws as infrastructure, never install-failed', () => {
    expect(() =>
      runDeclaredInstall(
        '/wt',
        () => ({ available: true, timedOut: true, code: -1, output: '' }),
        [pack('typescript', NPM)],
        TOLERANT,
      ),
    ).toThrow(/timed out: infrastructure, not a verdict on the tree/);
  });

  it('a timed-out FALLBACK install throws too (the marker survives the fallback path)', () => {
    expect(() =>
      runDeclaredInstall(
        '/wt',
        (cmd) =>
          cmd.args.includes('--legacy-peer-deps')
            ? { available: true, timedOut: true, code: -1, output: '' }
            : { available: true, code: 1, output: 'npm ERR! code ERESOLVE' },
        [pack('typescript', NPM)],
        TOLERANT,
      ),
    ).toThrow(/`npm ci --legacy-peer-deps` timed out/);
  });

  it('an overflowed capture is the same infrastructure shape', () => {
    expect(() =>
      runDeclaredInstall(
        '/wt',
        () => ({ available: true, overflowed: true, code: 1, output: 'x' }),
        [pack('typescript', NPM)],
        TOLERANT,
      ),
    ).toThrow(/overflowed the capture buffer/);
  });

  it('verifyTree surfaces an install timeout as a disclosed error at step install', async () => {
    const r = await verifyTree(
      opts({
        seams: seams({
          install: () => {
            throw new Error(
              'install (`npm ci`) timed out: infrastructure, not a verdict on the tree',
            );
          },
        }),
      }),
    );
    expect(r.verdict).toBe('error');
    expect(r.failure?.step).toBe('install');
    expect(r.failure?.message).toContain('timed out');
  });

  // A pack with no install strategy is a DISCLOSED skip: nothing runs,
  // nothing is claimed, the packs are named.
  it('no declaring pack: a disclosed no-provision-declared outcome, no command runs', () => {
    let ran = false;
    const r = runDeclaredInstall(
      '/wt',
      () => {
        ran = true;
        return { available: true, code: 0, output: '' };
      },
      [{ id: 'go' } as unknown as LanguageSupport, pack('rust', null)],
      TOLERANT,
    );
    expect(r).toEqual({ status: 'no-provision-declared', packs: ['go', 'rust'] });
    expect(ran).toBe(false);
    expect(describeInstall(r)).toContain('no active pack declares an install');
    expect(describeInstall(r)).toContain('go, rust');
    expect(describeInstall(r)).toContain('unprovisioned');
  });
});
