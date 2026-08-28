/**
 * The recipe phase runner: envelope containment (pure + enforced with
 * disclosure), the trust refusal before any spawn, per-order commits, the
 * discard-on-failure doctrine, and the synthetic-recipe injection proving
 * the runner iterates the registry it is handed (the recipe-playbook
 * discipline). Plus the phase-for-task composition: disabled config, a
 * plan built from the entry floor, and the tier split.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionByEnvelope,
  pathAllowedByEnvelope,
  pathInEnvelope,
} from '../../../src/remediate/recipes/envelope';
import { REPO_WIDE_ENVELOPE } from '../../../src/remediate/work-orders/types';
import {
  cachedOsvQuery,
  effectiveBlockSeverities,
  groupRecipeOrders,
  recipeCounts,
  runRecipeOrders,
  runRecipePhaseForTask,
} from '../../../src/remediate/recipes/run-recipes';
import type { RecipeGit } from '../../../src/remediate/recipes/git';
import {
  RECIPE_REGISTRY,
  type RecipeDeclaration,
} from '../../../src/remediate/work-orders/recipes-registry';
import type { CorrectnessFloorResult } from '../../../src/analyzers/correctness/run';
import { budgetForTask, resolveRemediateConfig } from '../../../src/remediate/config';
import { deriveBudget } from '../../../src/remediate/work-orders/shared';
import { trustedLocalContext, untrustedContentContext } from '../../../src/analysis-trust';
import { advisoryFinding, fakeExec, lintFinding, makeOrder, tempRepo } from './helpers';

describe('envelope containment', () => {
  it('speaks the planner language: explicit repo-wide marker, directory prefix, exact file', () => {
    // The EXPLICIT marker matches everything; a bare empty string matches
    // NOTHING (the accidental startsWith('') match-all it used to be).
    expect(pathInEnvelope('anything/x.ts', { paths: [REPO_WIDE_ENVELOPE], manifests: false })).toBe(
      true,
    );
    expect(pathInEnvelope('anything/x.ts', { paths: [''], manifests: false })).toBe(false);
    expect(pathInEnvelope('src/a/b.ts', { paths: ['src/a/'], manifests: false })).toBe(true);
    expect(pathInEnvelope('src/ab/c.ts', { paths: ['src/a/'], manifests: false })).toBe(false);
    expect(pathInEnvelope('package.json', { paths: ['package.json'], manifests: true })).toBe(true);
    expect(pathInEnvelope('package.json5', { paths: ['package.json'], manifests: true })).toBe(
      false,
    );
    const split = partitionByEnvelope(['a.ts', 'b.ts'], { paths: ['a.ts'], manifests: false });
    expect(split).toEqual({ inside: ['a.ts'], outside: ['b.ts'] });
    // manifests: false excludes dependency files even under the repo-wide
    // marker; manifests: true admits them (the predicate is pack-injected).
    const isManifest = (p: string) => p === 'package.json';
    expect(
      pathAllowedByEnvelope(
        'package.json',
        { paths: [REPO_WIDE_ENVELOPE], manifests: false },
        isManifest,
      ),
    ).toBe(false);
    expect(
      pathAllowedByEnvelope(
        'package.json',
        { paths: [REPO_WIDE_ENVELOPE], manifests: true },
        isManifest,
      ),
    ).toBe(true);
  });
});

/** A scripted fake git: `dirty` is what changedPaths reports next; every
 *  mutation is recorded. */
function fakeGit(): RecipeGit & {
  dirty: string[];
  discarded: string[][];
  commits: Array<{ paths: readonly string[]; message: string }>;
} {
  const state = {
    dirty: [] as string[],
    discarded: [] as string[][],
    commits: [] as Array<{ paths: readonly string[]; message: string }>,
    changedPaths() {
      return [...state.dirty];
    },
    discardPaths(paths: readonly string[]) {
      state.discarded.push([...paths]);
      state.dirty = state.dirty.filter((p) => !paths.includes(p));
    },
    commitPaths(paths: readonly string[], message: string) {
      state.commits.push({ paths, message });
      state.dirty = state.dirty.filter((p) => !paths.includes(p));
    },
    head: () => 'deadbeef',
  };
  return state;
}

function syntheticRecipe(
  execute: RecipeDeclaration['execute'],
  id = 'synthetic-fixer',
): RecipeDeclaration {
  return {
    id,
    class: 'synthetic-class',
    summary: 't',
    implemented: true,
    matches: () => true,
    execute,
  };
}

const syntheticOrder = makeOrder({
  id: 'synthetic-class:unit',
  class: 'synthetic-class',
  recipe: 'synthetic-fixer',
  envelope: { paths: ['fixed.txt'], manifests: false },
});

describe('runRecipeOrders', () => {
  it('a SYNTHETIC recipe injected into the registry executes and commits per order (the runner iterates the registry)', async () => {
    const git = fakeGit();
    const { exec } = fakeExec();
    const registry = [
      syntheticRecipe(async (_order, ctx) => {
        git.dirty.push('fixed.txt');
        expect(ctx.trust.repoExecutionAllowed).toBe(true);
        return { kind: 'applied', changedFiles: ['fixed.txt'] };
      }),
    ];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(records).toHaveLength(1);
    expect(records[0].outcome.kind).toBe('applied');
    expect(git.commits).toEqual([
      {
        paths: ['fixed.txt'],
        message: 'fix(synthetic-class): synthetic-class:unit (synthetic-fixer recipe)',
      },
    ]);
  });

  it("an applied record carries the packages the order's findings name (the containment package tier reads them)", async () => {
    const git = fakeGit();
    const { exec } = fakeExec();
    const depOrder = makeOrder({
      id: 'dep-advisory:tmp',
      class: 'dep-advisory',
      recipe: 'synthetic-fixer',
      envelope: { paths: ['package.json'], manifests: true },
      findings: [advisoryFinding('f1', 'tmp', 'GHSA-test', '0.2.4')],
    });
    const registry = [
      syntheticRecipe(async () => {
        git.dirty.push('package.json');
        return { kind: 'applied' as const, changedFiles: ['package.json'] };
      }),
    ];
    const records = await runRecipeOrders([depOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(records[0].outcome.kind).toBe('applied');
    expect(records[0].packages).toEqual(['tmp']);
    // An order naming no package records none (the field stays absent).
    const git2 = fakeGit();
    const plain = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git: git2,
      exec,
      registry: [
        syntheticRecipe(async () => {
          git2.dirty.push('fixed.txt');
          return { kind: 'applied' as const, changedFiles: ['fixed.txt'] };
        }),
      ],
    });
    expect(plain[0].packages).toBeUndefined();
  });

  it('an UNTRUSTED tree refuses every order before any execute runs (disclosed, nothing spawns)', async () => {
    const git = fakeGit();
    const { exec, calls } = fakeExec();
    let executed = false;
    const registry = [
      syntheticRecipe(async () => {
        executed = true;
        return { kind: 'applied', changedFiles: [] };
      }),
    ];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: untrustedContentContext(),
      git,
      exec,
      registry,
    });
    expect(executed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(records[0].outcome.kind).toBe('refused');
    if (records[0].outcome.kind === 'refused') {
      expect(records[0].outcome.reason).toContain('untrusted-content');
    }
  });

  it('drops an out-of-envelope hunk WITH disclosure and commits only the envelope diff', async () => {
    const git = fakeGit();
    const { exec } = fakeExec();
    const registry = [
      syntheticRecipe(async () => {
        git.dirty.push('fixed.txt', 'sprawl/other.txt');
        return { kind: 'applied', changedFiles: ['fixed.txt', 'sprawl/other.txt'] };
      }),
    ];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(records[0].droppedPaths).toEqual(['sprawl/other.txt']);
    expect(git.discarded).toEqual([['sprawl/other.txt']]);
    expect(records[0].outcome.kind).toBe('applied');
    if (records[0].outcome.kind === 'applied') {
      expect(records[0].outcome.changedFiles).toEqual(['fixed.txt']);
    }
    expect(git.commits[0].paths).toEqual(['fixed.txt']);
  });

  it('an applied claim whose whole diff was out-of-envelope becomes a FAILED envelope outcome', async () => {
    const git = fakeGit();
    const { exec } = fakeExec();
    const registry = [
      syntheticRecipe(async () => {
        git.dirty.push('sprawl/other.txt');
        return { kind: 'applied', changedFiles: ['sprawl/other.txt'] };
      }),
    ];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(records[0].outcome.kind).toBe('failed');
    if (records[0].outcome.kind === 'failed') expect(records[0].outcome.step).toBe('envelope');
    expect(git.commits).toHaveLength(0);
  });

  it('a failed or throwing recipe discards its own diff, and only its own', async () => {
    const git = fakeGit();
    git.dirty.push('user-was-editing.md'); // pre-existing local dirt
    const { exec } = fakeExec();
    const registry = [
      syntheticRecipe(async () => {
        git.dirty.push('half-done.txt');
        throw new Error('midway explosion');
      }),
    ];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(records[0].outcome.kind).toBe('failed');
    if (records[0].outcome.kind === 'failed') {
      expect(records[0].outcome.output).toContain('midway explosion');
    }
    expect(git.discarded).toEqual([['half-done.txt']]);
    expect(git.dirty).toEqual(['user-was-editing.md']);
  });

  it('REFUSES an order whose envelope intersects PRE-DIRTY paths (named), so a recipe edit is never mixed with local dirt', async () => {
    const git = fakeGit();
    git.dirty.push('fixed.txt', 'unrelated.md'); // fixed.txt is IN the envelope
    const { exec } = fakeExec();
    let executed = false;
    const registry = [
      syntheticRecipe(async () => {
        executed = true;
        return { kind: 'applied', changedFiles: [] };
      }),
    ];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(executed).toBe(false);
    expect(records[0].outcome.kind).toBe('refused');
    if (records[0].outcome.kind === 'refused') {
      expect(records[0].outcome.reason).toContain('fixed.txt');
      expect(records[0].outcome.reason).not.toContain('unrelated.md');
    }
    // Nothing was discarded or committed: both contracts hold exactly.
    expect(git.discarded).toEqual([]);
    expect(git.commits).toEqual([]);
  });

  it('an unreadable working tree is a named per-order failure, never an unenforced envelope', async () => {
    const git = fakeGit();
    git.changedPaths = () => {
      throw new Error('git exploded');
    };
    const { exec } = fakeExec();
    const registry = [syntheticRecipe(async () => ({ kind: 'applied', changedFiles: [] }))];
    const records = await runRecipeOrders([syntheticOrder], {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec,
      registry,
    });
    expect(records[0].outcome.kind).toBe('failed');
    if (records[0].outcome.kind === 'failed') {
      expect(records[0].outcome.step).toBe('working-tree');
    }
  });

  it('a declared-but-unimplemented recipe id is a refusal, never a crash', async () => {
    const git = fakeGit();
    const { exec } = fakeExec();
    const records = await runRecipeOrders(
      [makeOrder({ id: 'x:y', class: 'synthetic-class', recipe: 'ghost-recipe' })],
      { cwd: '/x', trust: trustedLocalContext(), git, exec, registry: [] },
    );
    expect(records[0].outcome.kind).toBe('refused');
    if (records[0].outcome.kind === 'refused') {
      expect(records[0].outcome.reason).toContain('ghost-recipe');
    }
  });
});

describe('grouped execution (a file of lint slices is ONE fix attempt)', () => {
  const sliceOrder = (id: string, rule: string, slice: number) =>
    makeOrder({
      id,
      class: 'lint-located',
      recipe: 'grouped-fixer',
      findings: [lintFinding(`f-${id}`, 'lint:typescript', 'src/big.ts', rule)],
      envelope: { paths: ['src/big.ts'], manifests: false },
      provenance: { source: 'debt-slice', file: 'src/big.ts', slice, of: 3 },
    });
  const slices = [
    sliceOrder('lint-located:src/big.ts#1', 'prefer-const', 1),
    sliceOrder('lint-located:src/big.ts#2', 'no-unused-vars', 2),
    sliceOrder('lint-located:src/big.ts#3', 'quotes', 3),
  ];
  function groupedRecipe(execute: RecipeDeclaration['execute']): RecipeDeclaration {
    return {
      id: 'grouped-fixer',
      class: 'lint-located',
      summary: 't',
      implemented: true,
      matches: () => true,
      execute,
      groupKey: (order) => {
        const first = order.findings[0]?.evidence;
        return first && first.type === 'custom-check' && first.file ? first.file : null;
      },
    };
  }

  it('a 3-slice file fixes in ONE execution: all three applied, one commit naming them all', async () => {
    const git = fakeGit();
    let executions = 0;
    const registry = [
      groupedRecipe(async (order) => {
        executions += 1;
        // The merged attempt carries EVERY slice's findings.
        expect(order.findings).toHaveLength(3);
        git.dirty.push('src/big.ts');
        return { kind: 'applied', changedFiles: ['src/big.ts'] };
      }),
    ];
    const records = await runRecipeOrders(slices, {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec: fakeExec().exec,
      registry,
    });
    expect(executions).toBe(1);
    expect(records.map((r) => r.outcome.kind)).toEqual(['applied', 'applied', 'applied']);
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0].message).toContain('lint-located:src/big.ts#1');
    expect(git.commits[0].message).toContain('#2');
    expect(git.commits[0].message).toContain('#3');
  });

  it('KNOWN leftovers split per slice: fixed slices apply and COMMIT, the unfixed slice falls to the agent', async () => {
    const git = fakeGit();
    const registry = [
      groupedRecipe(async () => {
        git.dirty.push('src/big.ts');
        return {
          kind: 'failed',
          step: 'verify-lint',
          output: 'no-unused-vars remains',
          leftoverRules: ['no-unused-vars'],
        };
      }),
    ];
    const records = await runRecipeOrders(slices, {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec: fakeExec().exec,
      registry,
    });
    const byId = new Map(records.map((r) => [r.orderId, r.outcome]));
    expect(byId.get('lint-located:src/big.ts#1')?.kind).toBe('applied');
    expect(byId.get('lint-located:src/big.ts#3')?.kind).toBe('applied');
    const open = byId.get('lint-located:src/big.ts#2');
    expect(open?.kind).toBe('failed');
    if (open?.kind === 'failed') {
      expect(open.step).toBe('verify-lint');
      expect(open.output).toContain('no-unused-vars');
    }
    // The partial fix is real work: committed (naming only the closed
    // slices), never discarded.
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0].message).toContain('#1');
    expect(git.commits[0].message).not.toContain('#2');
    expect(git.discarded).toEqual([]);
  });

  it('a plain failure (no structured leftovers, the net-new guard) discards the diff for every slice', async () => {
    const git = fakeGit();
    const registry = [
      groupedRecipe(async () => {
        git.dirty.push('src/big.ts');
        return { kind: 'failed', step: 'verify-lint', output: 'net-new rule appeared' };
      }),
    ];
    const records = await runRecipeOrders(slices, {
      cwd: '/x',
      trust: trustedLocalContext(),
      git,
      exec: fakeExec().exec,
      registry,
    });
    expect(records.every((r) => r.outcome.kind === 'failed')).toBe(true);
    expect(git.commits).toHaveLength(0);
    expect(git.discarded).toEqual([['src/big.ts']]);
  });

  it('end to end with the REAL lint-autofix: three slices, ONE eslint --fix run, all applied', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'node_modules/.bin/eslint': '#!/bin/sh\n',
      'src/big.ts': 'let x = 1;\nexport default x;\n',
    });
    const realSlices = slices.map((o) => ({
      ...o,
      recipe: 'lint-autofix',
      findings: o.findings.map((f) => ({
        ...f,
        evidence: { ...f.evidence, file: 'src/big.ts' },
      })),
      envelope: { paths: ['src/big.ts'], manifests: false },
    }));
    const git = fakeGit();
    let fixRuns = 0;
    const { exec } = (() => {
      const inner = fakeExec((cmd) => {
        if (cmd.args.includes('--fix')) {
          fixRuns += 1;
          git.dirty.push('src/big.ts');
        }
        return {
          code: 0,
          output: JSON.stringify([{ filePath: `${cwd}/src/big.ts`, messages: [] }]),
        };
      });
      return inner;
    })();
    const records = await runRecipeOrders(realSlices, {
      cwd,
      trust: trustedLocalContext(),
      git,
      exec,
    });
    expect(fixRuns).toBe(1);
    expect(records.map((r) => r.outcome.kind)).toEqual(['applied', 'applied', 'applied']);
    expect(git.commits).toHaveLength(1);
  });

  it('the REAL registry groups lint slices by file, and everything else stays singleton', () => {
    const realSlices = slices.map((o) => ({ ...o, recipe: 'lint-autofix' }));
    const other = makeOrder({
      id: 'dep-advisory:js-yaml',
      class: 'dep-advisory',
      recipe: 'override-pin',
    });
    const groups = groupRecipeOrders(
      [realSlices[0], other, realSlices[1], realSlices[2]],
      [...RECIPE_REGISTRY],
    );
    expect(groups.map((g) => g.map((o) => o.id))).toEqual([
      ['lint-located:src/big.ts#1', 'lint-located:src/big.ts#2', 'lint-located:src/big.ts#3'],
      ['dep-advisory:js-yaml'],
    ]);
  });
});

describe('block-tier plumbing (Rule 2.30: the ONE policy normalizer)', () => {
  it('effectiveBlockSeverities reads newAdvisories.blockSeverities through the canonical normalizer', () => {
    const cwd = tempRepo({
      '.dxkit/policy.json': JSON.stringify({
        newAdvisories: { blockSeverities: ['critical', 'high', 'medium'] },
      }),
    });
    expect([...effectiveBlockSeverities(cwd)].sort()).toEqual(['critical', 'high', 'medium']);
    // Absent policy: the same default the guardrail classifier uses.
    const bare = tempRepo({});
    expect([...effectiveBlockSeverities(bare)].sort()).toEqual(['critical', 'high']);
  });

  it('cachedOsvQuery asks the network once per candidate within a run', async () => {
    let calls = 0;
    const cached = cachedOsvQuery(async () => {
      calls += 1;
      return [];
    });
    await cached('left-pad', '1.3.0', 'npm');
    await cached('left-pad', '1.3.0', 'npm');
    await cached('left-pad', '1.4.0', 'npm');
    expect(calls).toBe(2);
  });
});

describe('runRecipePhaseForTask', () => {
  const floorWith = (checks: CorrectnessFloorResult['checks']): CorrectnessFloorResult => ({
    ran: true,
    checks,
    blocks: checks.some((c) => c.status === 'fail'),
    scope: 'full',
  });

  it('remediate.recipes.enabled: false is a disclosed no-run', async () => {
    const cwd = tempRepo({ '.dxkit/policy.json': '{"remediate":{"recipes":{"enabled":false}}}' });
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor: floorWith([]),
    });
    expect(summary.ran).toBe(false);
    expect(summary.disabled).toBe(true);
  });

  it('plans from the entry floor and executes the stale-lockfile order end to end', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'package-lock.json': '{}',
      'src/index.ts': 'export const x = 1;\n',
      '.dxkit/policy.json': '{}',
    });
    const git = fakeGit();
    const { exec } = fakeExec((cmd) => {
      if (cmd.args.includes('install')) git.dirty.push('package-lock.json');
      return undefined;
    });
    const entryFloor = floorWith([
      {
        pack: 'typescript',
        label: 'lockfile-sync',
        bin: 'npm',
        args: ['ci', '--dry-run'],
        status: 'fail',
        output: 'EUSAGE',
      },
    ]);
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor,
      git,
      exec,
    });
    expect(summary.ran).toBe(true);
    expect(summary.selectedRecipeTier).toBe(1);
    expect(summary.selectedAgentTier).toBe(0);
    expect(summary.records[0].recipe).toBe('lockfile-sync');
    expect(summary.records[0].outcome.kind).toBe('applied');
    expect(recipeCounts(summary)).toEqual({ applied: 1, refused: 0, failed: 0 });
    expect(git.commits[0].message).toContain('fix(stale-lockfile)');
  });

  it('a refused/failed recipe order JOINS the agent queue (agentOrders), in plan order', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'package-lock.json': '{}',
      'src/index.ts': 'export const x = 1;\n',
      '.dxkit/policy.json': '{}',
    });
    const git = fakeGit();
    // The install never dirties the lockfile, so the lockfile-sync recipe
    // reports applied with no in-envelope change and FAILS at the envelope
    // step — the class of order the agent tier must pick up in-run.
    const { exec } = fakeExec(() => undefined);
    const entryFloor = floorWith([
      {
        pack: 'typescript',
        label: 'lockfile-sync',
        bin: 'npm',
        args: ['ci', '--dry-run'],
        status: 'fail',
        output: 'EUSAGE',
      },
      // A plain failing floor check: the agent-only floor-failure class.
      { pack: 'typescript', label: 'tests', bin: 'npx', args: ['vitest'], status: 'fail' },
    ] as CorrectnessFloorResult['checks']);
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor,
      git,
      exec,
    });
    expect(summary.ran).toBe(true);
    expect(summary.records[0].outcome.kind).not.toBe('applied');
    const ids = (summary.agentOrders ?? []).map((o) => o.id);
    // Both the non-applied recipe order and the agent-tier floor order are queued.
    expect(ids.some((id) => id.startsWith('stale-lockfile:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('floor-failure:'))).toBe(true);
  });

  it('a fallthrough order joins the agent queue with the RAISED recipe-fallthrough budget, disclosed', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'package-lock.json': '{}',
      'src/index.ts': 'export const x = 1;\n',
      '.dxkit/policy.json': '{}',
    });
    const git = fakeGit();
    const { exec } = fakeExec(() => undefined);
    const entryFloor = floorWith([
      {
        pack: 'typescript',
        label: 'lockfile-sync',
        bin: 'npm',
        args: ['ci', '--dry-run'],
        status: 'fail',
        output: 'EUSAGE',
      },
      { pack: 'typescript', label: 'tests', bin: 'npx', args: ['vitest'], status: 'fail' },
    ] as CorrectnessFloorResult['checks']);
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor,
      git,
      exec,
    });
    const queue = summary.agentOrders ?? [];
    const fallthrough = queue.find((o) => o.id.startsWith('stale-lockfile:'));
    const native = queue.find((o) => o.id.startsWith('floor-failure:'));
    expect(fallthrough).toBeDefined();
    expect(native).toBeDefined();
    // The fallthrough order's budget is re-derived with the disclosed
    // recipe-fallthrough floor; a native agent-tier order keeps the
    // planner's standard derivation.
    expect(fallthrough!.budget.derivation).toContain('recipe-fallthrough floor');
    expect(native!.budget.derivation).not.toContain('recipe-fallthrough');
    const cap = budgetForTask(resolveRemediateConfig(cwd), 'fix-build');
    expect(fallthrough!.budget).toEqual(
      deriveBudget(fallthrough!.findings.length, cap, { recipeFallthrough: true }),
    );
    expect(fallthrough!.budget.turns).toBeGreaterThan(
      deriveBudget(fallthrough!.findings.length, cap).turns,
    );
  });

  it('recipes disabled still plans and routes EVERY selected order to the agent queue', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'package-lock.json': '{}',
      '.dxkit/policy.json': '{"remediate":{"recipes":{"enabled":false}}}',
    });
    const entryFloor = floorWith([
      {
        pack: 'typescript',
        label: 'lockfile-sync',
        bin: 'npm',
        args: ['ci', '--dry-run'],
        status: 'fail',
        output: 'EUSAGE',
      },
    ] as CorrectnessFloorResult['checks']);
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor,
    });
    expect(summary.disabled).toBe(true);
    expect(summary.ran).toBe(false);
    expect(summary.records).toHaveLength(0);
    expect(summary.selectedAgentTier).toBe(1);
    expect((summary.agentOrders ?? []).map((o) => o.id)).toEqual([
      expect.stringMatching(/^stale-lockfile:/),
    ]);
  });

  it('skips planning entirely when BOTH consumers are off (recipes disabled + order dispatch off)', async () => {
    const cwd = tempRepo({
      '.dxkit/policy.json': '{"remediate":{"recipes":{"enabled":false},"maxOrdersPerRun":0}}',
    });
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor: floorWith([]),
      // A gather seam that THROWS proves planning never ran: a planned call
      // would surface as planError.
      gather: {
        runFloor: () => {
          throw new Error('planning must not run when nothing consumes the plan');
        },
      },
    });
    expect(summary.disabled).toBe(true);
    expect(summary.planError).toBeUndefined();
    expect(summary.agentOrders).toBeUndefined();
  });

  it('a task selecting no orders is an honest no-run with the tier split at zero', async () => {
    const cwd = tempRepo({ '.dxkit/policy.json': '{}' });
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-lint',
      config: resolveRemediateConfig(cwd),
      entryFloor: floorWith([]),
    });
    expect(summary.ran).toBe(false);
    expect(summary.selectedRecipeTier).toBe(0);
    expect(summary.records).toHaveLength(0);
  });
});

describe('circuit-breaker partition (runRecipePhaseForTask)', () => {
  const failedRow = (n: number) => ({
    schema_version: 1,
    timestamp: `2026-08-1${n}T00:00:00.000Z`,
    lane: 'remediate',
    task: 'fix-build',
    orderId: `stale-lockfile:${n}`,
    class: 'stale-lockfile',
    tier: 'recipe' as const,
    outcome: 'guardrail-red' as const,
    dxkitVersion: '4.4.5',
    policyHash: 'hash-a',
  });
  const STAMP = { dxkitVersion: '4.4.5', policyHash: 'hash-a' };
  const pausedEntryFloor: CorrectnessFloorResult = {
    ran: true,
    blocks: true,
    scope: 'full',
    checks: [
      {
        pack: 'typescript',
        label: 'lockfile-sync',
        bin: 'npm',
        args: ['ci', '--dry-run'],
        status: 'fail',
        output: 'EUSAGE',
      },
    ],
  };

  it('a paused class is in NEITHER tier: no recipe executes, the agent queue excludes it, the pause is disclosed', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'package-lock.json': '{}',
      'src/index.ts': 'export const x = 1;\n',
      '.dxkit/policy.json': '{}',
    });
    const { exec, calls } = fakeExec();
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor: pausedEntryFloor,
      exec,
      gather: { history: [failedRow(1), failedRow(2)], stamp: STAMP },
    });
    expect(summary.ran).toBe(false);
    expect(summary.records).toEqual([]);
    expect(calls).toEqual([]); // nothing spawned for a paused order
    expect(summary.selectedRecipeTier).toBe(0);
    expect(summary.selectedAgentTier).toBe(0);
    expect(summary.agentOrders).toEqual([]);
    expect(summary.paused).toHaveLength(1);
    expect(summary.paused![0].class).toBe('stale-lockfile');
    expect(summary.paused![0].reason).toContain('failures');
    expect(summary.paused![0].unpause).toContain('fix-build');
  });

  it('an explicit dispatch threaded through gather lifts the pause and the recipe tier runs again', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"fx"}',
      'package-lock.json': '{}',
      'src/index.ts': 'export const x = 1;\n',
      '.dxkit/policy.json': '{}',
    });
    const git = fakeGit();
    const { exec } = fakeExec((cmd) => {
      if (cmd.args.includes('install')) git.dirty.push('package-lock.json');
      return undefined;
    });
    const summary = await runRecipePhaseForTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-build',
      config: resolveRemediateConfig(cwd),
      entryFloor: pausedEntryFloor,
      git,
      exec,
      gather: {
        history: [failedRow(1), failedRow(2)],
        stamp: STAMP,
        dispatchedTask: 'fix-build',
      },
    });
    expect(summary.paused ?? []).toEqual([]);
    expect(summary.selectedRecipeTier).toBe(1);
    expect(summary.records[0]?.outcome.kind).toBe('applied');
  });
});
