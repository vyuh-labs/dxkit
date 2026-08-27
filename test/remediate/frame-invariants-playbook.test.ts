/**
 * Frame-owned tree invariants, the injection net (4.4.6; the
 * recipe-playbook / producer-playbook discipline): a SYNTHETIC language
 * pack declares an invariant with a distinctive binary and owned path,
 * and the frame must
 *
 *   R1. APPLY it after an agent order whose diff trips `appliesWhen` (the
 *       check runs, the regenerate runs, the rewritten owned path is
 *       committed as the frame's own, and the order record discloses it),
 *       and must NOT apply it after an order whose diff does not (nothing
 *       spawned, nothing disclosed), and must DROP the order when it
 *       cannot be re-established;
 *   R2. TELL the agent the contract, from the same declaration: the
 *       rendered order prompt names the invariant, the owned path, and
 *       what the frame runs, for an envelope that can trip it, and stays
 *       silent for one that cannot.
 *
 * Without the negative directions a step that re-established everything
 * unconditionally (or a prompt that listed every invariant) would pass.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandOutcome, RunnableCommand } from '../../src/analyzers/tools/bounded-exec';
import { trustedLocalContext } from '../../src/analysis-trust';
import { defaultResolvedTolerances } from '../../src/install/tolerances';
import { collectTreeInvariants } from '../../src/languages';
import type { LanguageSupport } from '../../src/languages/types';
import { NO_TREE_INVARIANTS } from '../../src/languages/capabilities/tree-invariants';
import type { TreeInvariant } from '../../src/languages/capabilities/tree-invariants';
import { runRemediateTask, type RemediateGit } from '../../src/remediate/run';
import type { AgentDriver } from '../../src/remediate/driver';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RecipePhaseSummary } from '../../src/remediate/recipes/run-recipes';
import type { WorkOrder } from '../../src/remediate/work-orders/types';
import { renderWorkOrderPrompt } from '../../src/remediate/work-orders/render';
import { frameInvariantsForEnvelope } from '../../src/remediate/frame-invariants';
import { GREEN_FLOOR } from './helpers';
import { makeOrder } from './recipes/helpers';

// ─── The synthetic pack ─────────────────────────────────────────────────────
const SYNTHETIC_INVARIANT: TreeInvariant = {
  id: 'playbook-generated',
  pack: 'playbook',
  root: '',
  summary: 'the generated playbook artifact matches its .pbk sources',
  ownedPaths: ['playbook.gen'],
  agentEdits: 'the .pbk sources',
  appliesWhen: (paths) => paths.some((p) => p.endsWith('.pbk')),
  reestablish: { primary: { bin: 'playbook-gen-mock', args: ['regen'] }, fallbacks: [] },
  verify: {
    kind: 'command',
    command: { label: 'playbook-generated', bin: 'playbook-gen-mock', args: ['check'] },
  },
};

const mockPack = {
  id: 'playbook',
  displayName: 'Playbook (synthetic)',
  sourceExtensions: ['.pbk'],
  testFilePatterns: [],
  detect: () => true,
  treeInvariants: { invariants: () => [SYNTHETIC_INVARIANT] },
} as unknown as LanguageSupport;

const packWithout = {
  ...mockPack,
  id: 'playbook-quiet',
  treeInvariants: NO_TREE_INVARIANTS,
} as unknown as LanguageSupport;

// ─── Fakes ───────────────────────────────────────────────────────────────────
function scriptedExec(regenerated: { value: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    exec: (cmd: RunnableCommand): CommandOutcome => {
      calls.push([cmd.bin, ...cmd.args].join(' '));
      if (cmd.bin === 'playbook-gen-mock' && cmd.args[0] === 'check' && !regenerated.value) {
        return { available: true, code: 1, output: 'stale artifact' };
      }
      if (cmd.bin === 'playbook-gen-mock' && cmd.args[0] === 'regen') regenerated.value = true;
      return { available: true, code: 0, output: '' };
    },
  };
}

function fakeGit(changed: readonly string[]) {
  let commits = 0;
  const g = {
    commitCalls: [] as { paths: readonly string[]; message: string }[],
    resets: [] as string[],
    head: () => `head${commits}`,
    sweepLeftovers: () => undefined,
    scrubRuntimeArtifacts: () => [] as string[],
    hasDiff: (base: string) => commits > 0 && base !== `head${commits}`,
    enforceEnvelope: () => {
      commits += 1;
      return { dropped: [] };
    },
    resetTo: (head: string) => {
      g.resets.push(head);
      commits = Number(head.replace('head', ''));
    },
    changedPaths: () => changed,
    commitPaths: (paths: readonly string[], message: string) => {
      g.commitCalls.push({ paths, message });
      commits += 1;
    },
  };
  return g as RemediateGit & typeof g;
}

function driver(): AgentDriver & { runs: Parameters<AgentDriver['run']>[0][] } {
  const d = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier: string) => `fake-${tier}`,
    available: () => ({ ok: true }),
    runs: [] as Parameters<AgentDriver['run']>[0][],
    run: async (opts: Parameters<AgentDriver['run']>[0]) => {
      d.runs.push(opts);
      return { completed: true, timedOut: false, transcriptTail: '' };
    },
  };
  return d as unknown as AgentDriver & { runs: Parameters<AgentDriver['run']>[0][] };
}

function config(): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-build'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'discard',
    agent: { driver: 'fake-agent', model: 'auto', budget: DEFAULT_REMEDIATE_BUDGET },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    resume: false,
    maxOrdersPerRun: 3,
    pauseAfterFailures: 0,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
  };
}

function order(id: string, paths: readonly string[]): WorkOrder {
  return makeOrder({
    id,
    class: 'floor-failure',
    tier: 'agent',
    envelope: { paths: [...paths], manifests: false },
    done: { absentIds: [`x#${id}`], verifier: 'floor', command: 'floor check' },
    budget: { turns: 12, minutes: 6, usd: 2, derivation: 'turns = derived(12)' },
  });
}

function summary(orders: readonly WorkOrder[]): RecipePhaseSummary {
  return {
    ran: false,
    disclosures: [],
    selectedRecipeTier: 0,
    selectedAgentTier: orders.length,
    records: [],
    agentOrders: orders,
  };
}

async function run(o: {
  readonly orders: readonly WorkOrder[];
  readonly git: ReturnType<typeof fakeGit>;
  readonly exec: ReturnType<typeof scriptedExec>;
  readonly tree: () => readonly string[];
  readonly driver: ReturnType<typeof driver>;
}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-frame-inv-'));
  try {
    return await runRemediateTask({
      cwd,
      trust: trustedLocalContext(),
      taskId: 'fix-vulns',
      config: config(),
      drivers: [o.driver],
      git: o.git,
      runFloor: () => GREEN_FLOOR,
      runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
      verifySeams: {
        worktree: async <T>(_o: unknown, fn: (p: string) => Promise<T>) => fn('/tmp/fake-wt'),
        install: () => ({ status: 'no-provision-declared', packs: [] }) as const,
        changedFiles: () => ['src/a.pbk'],
      },
      armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
      runRecipePhase: async () => summary(o.orders),
      // The REAL step + REAL collector over the synthetic pack: only the
      // spawnable edges are injected.
      frameInvariants: {
        packs: [mockPack, packWithout],
        exec: o.exec.exec,
        tolerances: defaultResolvedTolerances(),
        git: { changedPaths: () => [...o.tree()] },
      },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe('R1: the frame applies a synthetic pack invariant exactly when the order trips it', () => {
  it('the collector picks the synthetic declaration up (registry-driven, never a hardcoded list)', () => {
    const invs = collectTreeInvariants(
      [mockPack, packWithout],
      '/repo',
      ['src/a.pbk'],
      defaultResolvedTolerances(),
    );
    expect(invs.map((i) => i.id)).toEqual(['playbook-generated']);
  });

  it("an order whose diff trips the invariant: check, regenerate, re-check, the owned path committed as the frame's own, disclosed on the record", async () => {
    const regenerated = { value: false };
    const exec = scriptedExec(regenerated);
    const git = fakeGit(['src/a.pbk']);
    const r = await run({
      orders: [order('floor-failure:a', ['src/'])],
      git,
      exec,
      tree: () => (regenerated.value ? ['playbook.gen'] : []),
      driver: driver(),
    });
    expect(exec.calls).toEqual([
      'playbook-gen-mock check',
      'playbook-gen-mock regen',
      'playbook-gen-mock check',
    ]);
    expect(git.commitCalls).toHaveLength(1);
    expect(git.commitCalls[0].paths).toEqual(['playbook.gen']);
    expect(git.commitCalls[0].message).toContain('re-establish playbook-generated');
    const rec = r.orders?.records[0];
    expect(rec?.invariants?.map((o) => [o.id, o.status])).toEqual([
      ['playbook-generated', 'reestablished'],
    ]);
    expect(rec?.disposition?.kind).toBe('kept');
    expect(r.outcome).toBe('verified');
    expect(r.ledger).toContain('frame invariant: playbook-generated');
    expect(r.ledger).toContain('RE-ESTABLISHED');
  });

  it('an order whose diff does NOT trip it: nothing spawned, nothing disclosed, the order still lands', async () => {
    const regenerated = { value: false };
    const exec = scriptedExec(regenerated);
    const git = fakeGit(['docs/notes.md']);
    const r = await run({
      orders: [order('floor-failure:b', ['docs/'])],
      git,
      exec,
      tree: () => [],
      driver: driver(),
    });
    expect(exec.calls).toEqual([]);
    expect(git.commitCalls).toEqual([]);
    expect(r.orders?.records[0]?.invariants).toBeUndefined();
    expect(r.orders?.records[0]?.disposition?.kind).toBe('kept');
    expect(r.outcome).toBe('verified');
  });

  it('an invariant the frame cannot re-establish DROPS the order at that step, named; nothing lands', async () => {
    const exec = {
      calls: [] as string[],
      exec: (cmd: RunnableCommand): CommandOutcome => {
        exec.calls.push([cmd.bin, ...cmd.args].join(' '));
        return cmd.args[0] === 'regen'
          ? { available: true, code: 1, output: 'generator exploded' }
          : { available: true, code: 1, output: 'stale artifact' };
      },
    };
    const git = fakeGit(['src/a.pbk']);
    const r = await run({
      orders: [order('floor-failure:c', ['src/'])],
      git,
      exec: exec as ReturnType<typeof scriptedExec>,
      tree: () => [],
      driver: driver(),
    });
    const rec = r.orders?.records[0];
    expect(rec?.disposition).toEqual({
      kind: 'dropped',
      step: 'tree-invariants',
      reason: expect.stringContaining('generator exploded'),
    });
    expect(git.resets).toEqual(['head0']);
    expect(git.commitCalls).toEqual([]);
    expect(r.outcome).toBe('install-failed');
    expect(r.note).toContain('floor-failure:c');
    expect(r.ledger).toContain('DROPPED at tree-invariants');
  });
});

describe('R2: the order prompt states the contract from the same declaration', () => {
  it('an envelope that can trip the invariant gets the contract line: id, owned path, what to edit, what the frame runs', () => {
    const invs = frameInvariantsForEnvelope(
      '/repo',
      { paths: ['src/a.pbk'], manifests: false },
      {
        packs: [mockPack],
        tolerances: defaultResolvedTolerances(),
      },
    );
    expect(invs.map((i) => i.id)).toEqual(['playbook-generated']);
    const prompt = renderWorkOrderPrompt(order('floor-failure:a', ['src/a.pbk']), {
      invariants: invs,
    });
    expect(prompt).toContain('Frame-owned invariants');
    expect(prompt).toContain('playbook-generated (playbook, repo root)');
    expect(prompt).toContain('do not edit playbook.gen or run installs');
    expect(prompt).toContain('change the .pbk sources and stop');
    expect(prompt).toContain('the frame runs `playbook-gen-mock regen`');
  });

  it('an envelope that cannot trip it gets no contract line (the prompt is not padded with every invariant)', () => {
    const invs = frameInvariantsForEnvelope(
      '/repo',
      { paths: ['docs/'], manifests: false },
      {
        packs: [mockPack],
        tolerances: defaultResolvedTolerances(),
      },
    );
    expect(invs).toEqual([]);
    const prompt = renderWorkOrderPrompt(order('floor-failure:b', ['docs/']), { invariants: invs });
    expect(prompt).not.toContain('Frame-owned invariants');
    expect(prompt).not.toContain('playbook-generated');
  });

  it('the dispatched prompt carries the contract end to end (the orders phase renders from the same collector)', async () => {
    const regenerated = { value: true };
    const d = driver();
    await run({
      orders: [order('floor-failure:a', ['src/a.pbk']), order('floor-failure:b', ['docs/'])],
      git: fakeGit(['docs/notes.md']),
      exec: scriptedExec(regenerated),
      tree: () => [],
      driver: d,
    });
    expect(d.runs).toHaveLength(2);
    expect(d.runs[0].prompt).toContain('do not edit playbook.gen or run installs');
    expect(d.runs[1].prompt).not.toContain('playbook-generated');
  });
});
