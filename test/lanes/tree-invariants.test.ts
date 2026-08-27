/**
 * The frame's tree-invariant step (4.4.6): the executor's policy over a
 * synthetic invariant with a scripted exec, the ONE derivation of the
 * dependency invariant from an install strategy, and the OWNING-ROOT
 * collector.
 *
 * The executor is pinned in every direction: already consistent (nothing
 * spawned beyond the check), re-established (the resync ran, the check
 * re-ran, the rewritten paths are reported), could not be re-established
 * (the resync failed; the check still fails after it; no command is
 * declared; infrastructure) with the touched paths reported on the FAILURE
 * exits too, pre-existing (the check fails at the order base as well:
 * disclosed, never blamed, never rewritten), not applicable (never
 * touched), and untrusted (nothing spawned). The derivation is pinned on
 * the node strategy: applies on the root's own manifest or lockfile,
 * resolves a workspace member to the lockfile-anchored root, and never
 * applies under an unlocked root's subdirectories. The collector anchors
 * roots to lockfiles (`discoverPackDepRoots`) and DISCLOSES a changed
 * manifest no invariant covers instead of guessing an install.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandOutcome, RunnableCommand } from '../../src/analyzers/tools/bounded-exec';
import { trustedLocalContext, trustContextFromFlag } from '../../src/analysis-trust';
import { defaultResolvedTolerances } from '../../src/install/tolerances';
import {
  dependencyTreeInvariant,
  renderTreeInvariantContract,
  type TreeInvariant,
} from '../../src/languages/capabilities/tree-invariants';
import { collectTreeInvariants, getLanguage, matchesManifestPattern } from '../../src/languages';
import { NODE_STRATEGY_BY_PM } from '../../src/languages/node-install';
import {
  describeTreeInvariantOutcome,
  reestablishTreeInvariants,
  type TreeInvariantStepInput,
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
  extra: {
    tree?: () => readonly string[];
    trust?: ReturnType<typeof trustedLocalContext>;
    baseVerify?: TreeInvariantStepInput['baseVerify'];
  } = {},
) {
  return reestablishTreeInvariants({
    cwd: '/repo',
    trust: extra.trust ?? trustedLocalContext(),
    changedPaths,
    invariants: [inv],
    exec: e.exec,
    tolerances: defaultResolvedTolerances(),
    workingTreePaths: extra.tree ?? (() => []),
    ...(extra.baseVerify ? { baseVerify: extra.baseVerify } : {}),
  });
}

describe('reestablishTreeInvariants: the executor policy', () => {
  it('not applicable: an untripped invariant is reported and never spawns', async () => {
    const e = exec();
    const r = await step(synthetic(), ['docs/readme.md'], e);
    expect(r.applied).toEqual([]);
    expect(r.notApplicable).toEqual(['playbook-generated']);
    expect(r.failed).toBe(false);
    expect(e.calls).toEqual([]);
  });

  it('already consistent: the check passes first, nothing is re-established', async () => {
    const e = exec();
    const r = await step(synthetic(), ['src/a.pbk'], e);
    expect(r.applied.map((o) => o.status)).toEqual(['already-consistent']);
    expect(e.calls).toEqual(['playbook-gen-mock check']);
    expect(r.changedPaths).toEqual([]);
    expect(r.failed).toBe(false);
  });

  it('re-established: check fails, the resync runs, the check passes, the rewritten paths are reported', async () => {
    let regenerated = false;
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check' && !regenerated) return { code: 1, output: 'stale artifact' };
      if (cmd.args[0] === 'regen') regenerated = true;
    });
    const r = await step(synthetic(), ['src/a.pbk'], e, {
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

  it('could not re-establish: the resync fails, the order fails at this step, named', async () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'stale artifact' };
      if (cmd.args[0] === 'regen') return { code: 1, output: 'generator exploded' };
    });
    const r = await step(synthetic(), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.step).toBe('reestablish');
    expect(o.reason).toContain('generator exploded');
    expect(r.failed).toBe(true);
    expect(describeTreeInvariantOutcome(o)).toContain('COULD NOT');
  });

  it('review fix 6: a failure at verify still reports what the attempt touched, and a pre-dirty owned path is included and disclosed', async () => {
    // The resync rewrites the owned artifact (which was ALREADY dirty
    // before the step) and creates a stray file, then the re-check still
    // fails: the failure outcome must carry both paths so the caller's
    // discard can restore everything the step touched.
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'still stale' };
    });
    let regenerated = false;
    const e2 = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'still stale' };
      if (cmd.args[0] === 'regen') regenerated = true;
    });
    void e;
    const r = await step(synthetic(), ['src/a.pbk'], e2, {
      tree: () => (regenerated ? ['playbook.gen', 'stray.tmp'] : ['playbook.gen']),
    });
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.step).toBe('verify');
    expect([...o.changedPaths].sort()).toEqual(['playbook.gen', 'stray.tmp']);
    expect(o.preDirtyOwned).toEqual(['playbook.gen']);
    expect([...r.changedPaths].sort()).toEqual(['playbook.gen', 'stray.tmp']);
    expect(describeTreeInvariantOutcome(o)).toContain('restored on drop');
  });

  it('could not re-establish: no command is declared (verify-only invariant that does not hold)', async () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'stale' };
    });
    const r = await step(synthetic({ reestablish: null }), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.reason).toContain('declares no command');
    expect(e.calls).toEqual(['playbook-gen-mock check']);
  });

  it('infrastructure (the binary is missing) is could-not-reestablish with the infrastructure named, never a silent pass', async () => {
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check') return { code: 1, output: 'stale' };
      if (cmd.args[0] === 'regen') return { available: false, code: 127, output: 'not found' };
    });
    const r = await step(synthetic(), ['src/a.pbk'], e);
    const o = r.applied[0];
    expect(o.status).toBe('could-not-reestablish');
    if (o.status !== 'could-not-reestablish') throw new Error('unreachable');
    expect(o.reason).toContain('not available');
    expect(r.failed).toBe(true);
  });

  it('a declared verify skip re-establishes without a re-check and discloses the skip', async () => {
    const e = exec();
    const r = await step(
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

  it('untrusted tree: nothing spawns, the step fails with the trust reason', async () => {
    const e = exec();
    const r = await step(synthetic(), ['src/a.pbk'], e, {
      trust: trustContextFromFlag(true),
    });
    expect(r.applied.map((o) => o.status)).toEqual(['skipped-untrusted']);
    expect(r.failed).toBe(true);
    expect(e.calls).toEqual([]);
  });
});

describe('review fix 4: base-side attribution before blame', () => {
  const failingCheck: Script = (cmd) => {
    if (cmd.args[0] === 'check') return { code: 1, output: 'stale artifact' };
  };

  it('drift that exists at the order base too is PRE-EXISTING: disclosed, never re-established, never a failure', async () => {
    const e = exec(failingCheck);
    const r = await step(synthetic(), ['src/a.pbk'], e, {
      baseVerify: async () => 'fails',
    });
    const o = r.applied[0];
    expect(o.status).toBe('pre-existing');
    if (o.status !== 'pre-existing') throw new Error('unreachable');
    expect(o.reason).toContain('predates this order');
    // Attribution decided; the frame did NOT rewrite unrelated drift: no
    // regen spawned, nothing touched, the step did not fail the order.
    expect(e.calls).toEqual(['playbook-gen-mock check']);
    expect(r.changedPaths).toEqual([]);
    expect(r.failed).toBe(false);
    expect(describeTreeInvariantOutcome(o)).toContain('PRE-EXISTING');
  });

  it('a base where the check holds keeps the failure attributed to the order (re-established as usual)', async () => {
    let regenerated = false;
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check' && !regenerated) return { code: 1, output: 'stale artifact' };
      if (cmd.args[0] === 'regen') regenerated = true;
    });
    const r = await step(synthetic(), ['src/a.pbk'], e, { baseVerify: async () => 'holds' });
    expect(r.applied[0].status).toBe('reestablished');
  });

  it('an unanswerable base probe proceeds with a disclosure, never silently', async () => {
    let regenerated = false;
    const e = exec((cmd) => {
      if (cmd.args[0] === 'check' && !regenerated) return { code: 1, output: 'stale artifact' };
      if (cmd.args[0] === 'regen') regenerated = true;
    });
    const r = await step(synthetic(), ['src/a.pbk'], e, { baseVerify: async () => 'unknown' });
    expect(r.applied[0].status).toBe('reestablished');
    expect(r.disclosures.join('\n')).toContain('base-side probe could not answer');
  });
});

describe('dependencyTreeInvariant: the ONE derivation from an install strategy', () => {
  const npm = NODE_STRATEGY_BY_PM.npm;
  const patterns = ['package.json', 'package-lock.json'];
  const derive = (root: string, otherRoots: readonly string[] = []) =>
    dependencyTreeInvariant({
      pack: 'typescript',
      root,
      strategy: npm,
      manifestPatterns: patterns,
      matchesManifest: matchesManifestPattern,
      tolerances: defaultResolvedTolerances(),
      otherRoots,
    });

  it('applies on the root manifest or the lockfile, not on source', () => {
    const inv = derive('');
    expect(inv.id).toBe('lockfile-sync');
    expect(inv.appliesWhen(['package.json'])).toBe(true);
    expect(inv.appliesWhen(['package-lock.json'])).toBe(true);
    expect(inv.appliesWhen(['src/index.ts'])).toBe(false);
    expect(inv.appliesWhen([])).toBe(false);
  });

  it('a workspace member resolves to the lockfile-anchored root; another discovered root keeps its own paths', () => {
    const inv = derive('', ['', 'packages/api']);
    // A nested manifest under the LOCKED root is a workspace member: the
    // root's resync owns it.
    expect(inv.appliesWhen(['packages/web/package.json'])).toBe(true);
    // A path under ANOTHER discovered root belongs to that root's
    // invariant, never this one's.
    expect(inv.appliesWhen(['packages/api/package.json'])).toBe(false);
  });

  it('an UNLOCKED root never claims nested manifests (no guessed npm install below it)', () => {
    const unlocked = dependencyTreeInvariant({
      pack: 'typescript',
      root: '',
      strategy: { ...npm, lockfile: null },
      manifestPatterns: patterns,
      matchesManifest: matchesManifestPattern,
      tolerances: defaultResolvedTolerances(),
    });
    expect(unlocked.appliesWhen(['package.json'])).toBe(true);
    expect(unlocked.appliesWhen(['packages/foo/package.json'])).toBe(false);
  });

  it('a nested root applies to its own manifest and owns its own lockfile', () => {
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

describe('review fix 3: the collector anchors roots to lockfiles, never bare dirnames', () => {
  const TS = [getLanguage('typescript')!];
  const tolerances = defaultResolvedTolerances();
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function repo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-collector-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }

  it('a lockfile-less workspace member resolves to the workspace root strategy (never a nested npm install)', () => {
    const dir = repo({
      'pnpm-lock.yaml': '',
      'package.json': '{}',
      'packages/foo/package.json': '{}',
    });
    const collected = collectTreeInvariants(TS, dir, ['packages/foo/package.json'], tolerances);
    expect(collected.invariants.map((i) => i.root)).toEqual(['']);
    const inv = collected.invariants[0];
    expect(inv.ownedPaths).toEqual(['pnpm-lock.yaml']);
    // The member's manifest trips the ROOT invariant (the workspace root
    // owns the resync); nothing was minted at packages/foo.
    expect(inv.appliesWhen(['packages/foo/package.json'])).toBe(true);
    expect(collected.disclosures).toEqual([]);
  });

  it('a nested root with its OWN lockfile gets its own invariant', () => {
    const dir = repo({
      'packages/api/package.json': '{}',
      'packages/api/package-lock.json': '{}',
    });
    const collected = collectTreeInvariants(TS, dir, ['packages/api/package.json'], tolerances);
    expect(collected.invariants.map((i) => i.root)).toEqual(['packages/api']);
    expect(collected.invariants[0].ownedPaths).toEqual(['packages/api/package-lock.json']);
    expect(collected.disclosures).toEqual([]);
  });

  it('a manifest with neither its own lockfile nor a lockfile-anchored parent gets NO invariant, DISCLOSED', () => {
    const dir = repo({ 'tools/scripts/package.json': '{}' });
    const collected = collectTreeInvariants(TS, dir, ['tools/scripts/package.json'], tolerances);
    expect(collected.invariants.some((i) => i.appliesWhen(['tools/scripts/package.json']))).toBe(
      false,
    );
    expect(collected.disclosures.join('\n')).toContain('tools/scripts/package.json');
    expect(collected.disclosures.join('\n')).toContain('no resolvable dependency root');
  });
});
