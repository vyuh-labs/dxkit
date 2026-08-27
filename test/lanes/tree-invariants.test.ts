/**
 * The frame's tree-invariant step (4.4.6): the executor's policy over a
 * synthetic invariant with a scripted exec, and the ONE derivation of the
 * dependency invariant from an install strategy.
 *
 * The executor is pinned in every direction: already consistent (nothing
 * spawned beyond the check), re-established (the resync ran, the check
 * re-ran, the rewritten paths are reported), could not be re-established
 * (the resync failed; the check still fails after it; no command is
 * declared; infrastructure), not applicable (never touched), and
 * untrusted (nothing spawned). The derivation is pinned on the node
 * strategy: applies on the manifest or the lockfile at its root, owns the
 * lockfile, re-establishes through the RESYNC plan and verifies through
 * the strategy's sync check.
 */
import { describe, it, expect } from 'vitest';
import type { CommandOutcome, RunnableCommand } from '../../src/analyzers/tools/bounded-exec';
import { trustedLocalContext, trustContextFromFlag } from '../../src/analysis-trust';
import { defaultResolvedTolerances } from '../../src/install/tolerances';
import {
  dependencyTreeInvariant,
  renderTreeInvariantContract,
  type TreeInvariant,
} from '../../src/languages/capabilities/tree-invariants';
import { matchesManifestPattern } from '../../src/languages';
import { NODE_STRATEGY_BY_PM } from '../../src/languages/node-install';
import {
  describeTreeInvariantOutcome,
  reestablishTreeInvariants,
} from '../../src/lanes/tree-invariants';

type Script = (cmd: RunnableCommand) => Partial<CommandOutcome> | void;

function exec(script?: Script) {
  const calls: string[] = [];
  return {
    calls,
    exec: (cmd: RunnableCommand): CommandOutcome => {
      calls.push([cmd.bin, ...cmd.args].join(' '));
      return { available: true, code: 0, output: '', ...(script?.(cmd) ?? {}) };
    },
  };
}

/** A synthetic invariant with a distinctive binary, keyed on `.pbk` paths. */
function synthetic(overrides: Partial<TreeInvariant> = {}): TreeInvariant {
  return {
    id: 'playbook-generated',
    pack: 'playbook',
    root: '',
    summary: 'the generated playbook artifact matches its sources',
    ownedPaths: ['playbook.gen'],
    agentEdits: 'the .pbk sources',
    appliesWhen: (paths) => paths.some((p) => p.endsWith('.pbk')),
    reestablish: { primary: { bin: 'playbook-gen-mock', args: ['regen'] }, fallbacks: [] },
    verify: {
      kind: 'command',
      command: { label: 'playbook-generated', bin: 'playbook-gen-mock', args: ['check'] },
    },
    ...overrides,
  };
}

function step(
  inv: TreeInvariant,
  changedPaths: readonly string[],
  e: ReturnType<typeof exec>,
  extra: { tree?: () => readonly string[]; trust?: ReturnType<typeof trustedLocalContext> } = {},
) {
  return reestablishTreeInvariants({
    cwd: '/repo',
    trust: extra.trust ?? trustedLocalContext(),
    changedPaths,
    invariants: [inv],
    exec: e.exec,
    tolerances: defaultResolvedTolerances(),
    workingTreePaths: extra.tree ?? (() => []),
  });
}

describe('reestablishTreeInvariants: the executor policy', () => {
  it('not applicable: an untripped invariant is reported and never spawns', () => {
    const e = exec();
    const r = step(synthetic(), ['docs/readme.md'], e);
    expect(r.applied).toEqual([]);
    expect(r.notApplicable).toEqual(['playbook-generated']);
    expect(r.failed).toBe(false);
    expect(e.calls).toEqual([]);
  });

  it('already consistent: the check passes first, nothing is re-established', () => {
    const e = exec();
    const r = step(synthetic(), ['src/a.pbk'], e);
    expect(r.applied.map((o) => o.status)).toEqual(['already-consistent']);
    expect(e.calls).toEqual(['playbook-gen-mock check']);
    expect(r.changedPaths).toEqual([]);
    expect(r.failed).toBe(false);
  });

  it('re-established: check fails, the resync runs, the check passes, the rewritten paths are reported', () => {
    let regenerated = false;
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check' && !regenerated) return { code: 1, output: 'stale artifact' };
      if (cmd.args[0] === 'regen') regenerated = true;
    });
    const r = step(synthetic(), ['src/a.pbk'], e, {
      tree: () => (regenerated ? ['playbook.gen'] : []),
    });
    expect(e.calls).toEqual([
      'playbook-gen-mock check',
      'playbook-gen-mock regen',
      'playbook-gen-mock check',
    ]);
    const o = r.applied[0];
    expect(o.status).toBe('reestablished');
    if (o.status !== 'reestablished') throw new Error('unreachable');
    expect(o.command).toBe('playbook-gen-mock regen');
    expect(o.changedPaths).toEqual(['playbook.gen']);
    expect(o.verification).toBe('verified');
    expect(r.changedPaths).toEqual(['playbook.gen']);
    expect(r.failed).toBe(false);
    expect(describeTreeInvariantOutcome(o)).toContain('RE-ESTABLISHED');
    expect(describeTreeInvariantOutcome(o)).toContain('playbook.gen');
  });

  it('could not re-establish: the resync fails, the order fails at this step, named', () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'stale artifact' };
      if (cmd.args[0] === 'regen') return { code: 1, output: 'generator exploded' };
    });
    const r = step(synthetic(), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.step).toBe('reestablish');
    expect(o.reason).toContain('generator exploded');
    expect(r.failed).toBe(true);
    expect(describeTreeInvariantOutcome(o)).toContain('COULD NOT');
  });

  it('could not re-establish: the resync ran but the check still fails', () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'still stale' };
    });
    const r = step(synthetic(), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.step).toBe('verify');
    expect(o.reason).toContain('still stale');
    expect(r.failed).toBe(true);
  });

  it('could not re-establish: no command is declared (verify-only invariant that does not hold)', () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'stale' };
    });
    const r = step(synthetic({ reestablish: null }), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.reason).toContain('declares no command');
    expect(e.calls).toEqual(['playbook-gen-mock check']);
  });

  it('infrastructure (the binary is missing) is could-not-reestablish with the infrastructure named, never a silent pass', () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'stale' };
      if (cmd.args[0] === 'regen') return { available: false, code: 127, output: 'not found' };
    });
    const r = step(synthetic(), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.reason).toContain('not available');
    expect(r.failed).toBe(true);
  });

  it('a declared verify skip re-establishes without a re-check and discloses the skip', () => {
    const e = exec();
    const r = step(
      synthetic({ verify: { kind: 'none', reason: 'no dry-run in this ecosystem' } }),
      ['src/a.pbk'],
      e,
    );
    const o = r.applied[0];
    expect(o.status).toBe('reestablished');
    if (o.status !== 'reestablished') throw new Error('unreachable');
    expect(o.verification).toEqual({ skipped: 'no dry-run in this ecosystem' });
    expect(e.calls).toEqual(['playbook-gen-mock regen']);
    expect(describeTreeInvariantOutcome(o)).toContain('re-check skipped');
  });

  it('untrusted tree: nothing spawns, the step fails with the trust reason', () => {
    const e = exec();
    const r = step(synthetic(), ['src/a.pbk'], e, {
      trust: trustContextFromFlag(true),
    });
    expect(r.applied.map((o) => o.status)).toEqual(['skipped-untrusted']);
    expect(r.failed).toBe(true);
    expect(e.calls).toEqual([]);
  });
});

describe('dependencyTreeInvariant: the ONE derivation from an install strategy', () => {
  const npm = NODE_STRATEGY_BY_PM.npm;
  const patterns = ['package.json', 'package-lock.json'];
  const derive = (root: string) =>
    dependencyTreeInvariant({
      pack: 'typescript',
      root,
      strategy: npm,
      manifestPatterns: patterns,
      matchesManifest: matchesManifestPattern,
      tolerances: defaultResolvedTolerances(),
    });

  it('applies on the manifest or the lockfile at its root, not on source', () => {
    const inv = derive('');
    expect(inv.id).toBe('lockfile-sync');
    expect(inv.appliesWhen(['package.json'])).toBe(true);
    expect(inv.appliesWhen(['package-lock.json'])).toBe(true);
    expect(inv.appliesWhen(['src/index.ts'])).toBe(false);
    expect(inv.appliesWhen([])).toBe(false);
  });

  it('a nested root applies only to paths under it and owns its own lockfile', () => {
    const inv = derive('packages/api');
    expect(inv.ownedPaths).toEqual(['packages/api/package-lock.json']);
    expect(inv.appliesWhen(['packages/api/package.json'])).toBe(true);
    expect(inv.appliesWhen(['package.json'])).toBe(false);
    expect(inv.agentEdits).toBe('packages/api/package.json');
  });

  it('re-establishes through the RESYNC plan and verifies through the sync check', () => {
    const inv = derive('');
    expect(inv.reestablish).toBe(npm.modes.resync);
    expect(inv.verify.kind).toBe('command');
    if (inv.verify.kind !== 'command') throw new Error('unreachable');
    expect(inv.verify.command.args).toEqual(
      npm.syncCheck?.kind === 'command' ? npm.syncCheck.command.args : [],
    );
    // The peer-conflict tolerance the floor's check carries reaches the
    // invariant's check too (one derivation, `lockfileCheckFromStrategy`).
    expect(inv.verify.tolerated).toBeDefined();
  });

  it('the contract line names the owned lockfile, what to edit instead, and the frame command', () => {
    const line = renderTreeInvariantContract(derive(''));
    expect(line).toContain('do not edit package-lock.json');
    expect(line).toContain('change package.json and stop');
    expect(line).toContain('npm install --no-audit --no-fund');
    expect(line).toContain('lockfile-sync');
  });
});
