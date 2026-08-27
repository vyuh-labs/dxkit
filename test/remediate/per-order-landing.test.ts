/**
 * Per-order landing (4.4.6, R3): the unit of work is the order, so the
 * unit of landing is the order. Each agent order's commits are verified
 * (install + floor, the guardrail deferred) on top of the previously
 * verified head; a failing order is DROPPED (its commits reverted, the
 * reason recorded) and the run lands the verified prefix; the guardrail
 * arbitrates ONCE over the landed head.
 *
 * Scenarios, all through the one public entry point with the tree
 * verification's seams keyed on the candidate head:
 *   - all orders pass: every record kept, `verified`, no reset;
 *   - prefix passes then one fails: the prefix lands, the tail is dropped
 *     with its step + reason, the outcome is `partially-landed`, the ledger
 *     and the order rows say which is which;
 *   - the first (only) order fails: nothing lands, the outcome is the
 *     order's own failure, the branch is back at the base;
 *   - a recipe group followed by an agent order: the group is verified as
 *     one unit first and lands; a dropped group is reverted before any
 *     agent order dispatches;
 *   - the executor lands a partially-landed run as a normal (non-draft) PR
 *     and keeps the task non-clean.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { trustedLocalContext } from '../../src/analysis-trust';
import { runRemediateTask, type RemediateGit, type RemediateResult } from '../../src/remediate/run';
import type { AgentDriver } from '../../src/remediate/driver';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RecipePhaseSummary } from '../../src/remediate/recipes/run-recipes';
import type { WorkOrder } from '../../src/remediate/work-orders/types';
import type { InstallOutcome } from '../../src/lanes/verify-tree';
import { orderOutcomeRows } from '../../src/remediate/order-outcomes';
import { executeTask } from '../../src/remediate/cli';
import { GREEN_FLOOR } from './helpers';
import { makeOrder } from './recipes/helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-per-order-'));
  dirs.push(d);
  return d;
}

/** A head-counting fake: every commit advances `headN`; a reset moves it
 *  back. `hasDiff(base)` is true whenever the head moved past `base`. */
function fakeGit() {
  let commits = 0;
  const g = {
    resets: [] as string[],
    commitCalls: [] as string[],
    head: () => `head${commits}`,
    commit: () => {
      commits += 1;
    },
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
    changedPaths: () => ['src/a.ts'],
    commitPaths: (_p: readonly string[], message: string) => {
      g.commitCalls.push(message);
      commits += 1;
    },
  };
  return g as RemediateGit & typeof g;
}

function driver(): AgentDriver & { runs: number } {
  const d = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier: string) => `fake-${tier}`,
    available: () => ({ ok: true }),
    runs: 0,
    run: async () => {
      d.runs += 1;
      return { completed: true, timedOut: false, transcriptTail: '', turns: 2, costUsd: 0.1 };
    },
  };
  return d as unknown as AgentDriver & { runs: number };
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
    maxOrdersPerRun: 5,
    pauseAfterFailures: 0,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
  };
}

function agentOrder(id: string): WorkOrder {
  return makeOrder({
    id,
    class: 'floor-failure',
    tier: 'agent',
    envelope: { paths: ['src/'], manifests: false },
    done: { absentIds: [`x#${id}`], verifier: 'floor', command: 'floor check' },
    budget: { turns: 12, minutes: 6, usd: 2, derivation: 'turns = derived(12)' },
  });
}

function summary(
  orders: readonly WorkOrder[],
  extra: Partial<RecipePhaseSummary> = {},
): RecipePhaseSummary {
  return {
    ran: false,
    disclosures: [],
    selectedRecipeTier: 0,
    selectedAgentTier: orders.length,
    records: [],
    agentOrders: orders,
    ...extra,
  };
}

const INSTALLED: InstallOutcome = { status: 'installed', steps: [] };
const BROKEN: InstallOutcome = {
  status: 'failed',
  pack: 'typescript',
  argv: ['npm', 'ci'],
  output: 'npm error Missing: tmp@0.2.5 from lock file',
  classification: 'lockfile-drift',
};

/** The install seam keyed on the candidate head: the worktree seam hands
 *  the REF through as the worktree path, so `failAt` names a head. */
function runWith(o: {
  readonly orders: readonly WorkOrder[];
  readonly git: ReturnType<typeof fakeGit>;
  readonly driver: AgentDriver;
  readonly failAt?: readonly string[];
  /** Replaces the recipe phase; may commit on the fake git to simulate
   *  recipe commits before the agent tier. */
  readonly recipePhase?: () => RecipePhaseSummary;
}): Promise<RemediateResult> {
  const guardrailCalls: string[] = [];
  return runRemediateTask({
    cwd: tmpCwd(),
    trust: trustedLocalContext(),
    taskId: 'fix-vulns',
    config: config(),
    drivers: [o.driver],
    git: o.git,
    runFloor: () => GREEN_FLOOR,
    runGuardrail: async () => {
      guardrailCalls.push('x');
      return { verdict: 'PASSED', ran: true, passesGate: true };
    },
    verifySeams: {
      worktree: async <T>(opts: { ref: string }, fn: (p: string) => Promise<T>) => fn(opts.ref),
      install: (head) => ((o.failAt ?? []).includes(head) ? BROKEN : INSTALLED),
      changedFiles: () => ['src/a.ts'],
    },
    armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
    runRecipePhase: async () => (o.recipePhase ? o.recipePhase() : summary(o.orders)),
    frameInvariants: {
      step: () => ({ applied: [], notApplicable: [], changedPaths: [], failed: false }),
    },
  }).then((r) => Object.assign(r, { guardrailCalls }));
}

describe('per-order landing: every order verifies on top of the previously verified head', () => {
  it('all pass: every record is kept, the run is verified, nothing was reset, the guardrail ran once', async () => {
    const git = fakeGit();
    const r = await runWith({
      orders: [agentOrder('floor-failure:a'), agentOrder('floor-failure:b')],
      git,
      driver: driver(),
    });
    expect(r.outcome).toBe('verified');
    expect(r.orders?.records.map((x) => [x.orderId, x.disposition?.kind])).toEqual([
      ['floor-failure:a', 'kept'],
      ['floor-failure:b', 'kept'],
    ]);
    expect(git.resets).toEqual([]);
    expect((r as unknown as { guardrailCalls: string[] }).guardrailCalls).toHaveLength(1);
    expect(r.ledger).toContain('landing: KEPT');
  });

  it('prefix passes then one fails: the prefix lands, the tail is dropped with its reason, partially-landed', async () => {
    const git = fakeGit();
    // Order a commits head0 -> head1 (verified); order b commits head2,
    // whose install is broken: dropped, the head reset to head1.
    const r = await runWith({
      orders: [agentOrder('floor-failure:a'), agentOrder('floor-failure:b')],
      git,
      driver: driver(),
      failAt: ['head2'],
    });
    expect(r.outcome).toBe('partially-landed');
    const recs = r.orders?.records ?? [];
    expect(recs[0].disposition).toEqual({ kind: 'kept', head: 'head1' });
    expect(recs[1].disposition).toEqual({
      kind: 'dropped',
      step: 'install',
      reason: expect.stringContaining('lockfile-drift'),
    });
    expect(git.resets).toEqual(['head1']);
    expect(r.head).toBe('head1');
    expect(r.note).toContain('floor-failure:b');
    expect(r.note).toContain('still open');
    expect(r.ledger).toContain('landing: DROPPED at install');
    expect(r.ledger).toContain('Per-order landing');
    // The breaker counts the DROPPED order's class on its own step; the
    // kept order records the run's landing verdict.
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows.map((row) => [row.orderId, row.outcome])).toEqual([
      ['floor-failure:a', 'verified'],
      ['floor-failure:b', 'install-failed'],
    ]);
    expect(rows[1].detail).toContain('install:');
  });

  it("the first (only) order fails: nothing lands, the outcome is the order's own failure, the branch is back at the base", async () => {
    const git = fakeGit();
    const r = await runWith({
      orders: [agentOrder('floor-failure:a')],
      git,
      driver: driver(),
      failAt: ['head1'],
    });
    expect(r.outcome).toBe('install-failed');
    expect(r.orders?.records[0].disposition?.kind).toBe('dropped');
    expect(git.resets).toEqual(['head0']);
    expect(git.head()).toBe('head0');
    expect(r.note).toContain('nothing lands');
    expect((r as unknown as { guardrailCalls: string[] }).guardrailCalls).toHaveLength(0);
  });

  it('a later order is dispatched from the verified head, not from the dropped one', async () => {
    const git = fakeGit();
    const r = await runWith({
      orders: [
        agentOrder('floor-failure:a'),
        agentOrder('floor-failure:b'),
        agentOrder('floor-failure:c'),
      ],
      git,
      driver: driver(),
      failAt: ['head1'],
    });
    // a: head1 dropped -> reset head0; b: head1 again (fails again, same
    // key) -> reset head0; c: head1 -> fails. Every order dispatched from
    // head0, every drop named, nothing landed.
    expect(git.resets).toEqual(['head0', 'head0', 'head0']);
    expect(r.outcome).toBe('install-failed');
    expect(r.orders?.records.every((x) => x.disposition?.kind === 'dropped')).toBe(true);
  });
});

describe('per-order landing: a recipe group before the agent tier', () => {
  const appliedRecord = {
    orderId: 'dep-advisory:js-yaml',
    class: 'dep-advisory',
    recipe: 'override-pin',
    outcome: { kind: 'applied' as const, changedFiles: ['package.json'] },
  };

  it('the group verifies as one unit first and lands; a dropped agent order after it does not discard the pins', async () => {
    const git = fakeGit();
    const r = await runWith({
      orders: [agentOrder('floor-failure:a')],
      git,
      driver: driver(),
      recipePhase: () => {
        git.commit(); // the recipe tier committed the pin: head0 -> head1
        return summary([agentOrder('floor-failure:a')], {
          ran: true,
          selectedRecipeTier: 1,
          records: [appliedRecord],
        });
      },
      // The recipe group commits head1 (verified); the agent order commits
      // head2 (broken) and is dropped back to head1.
      failAt: ['head2'],
    });
    expect(r.recipes?.groupVerification).toEqual({ kept: true, head: 'head1' });
    expect(r.recipes?.records[0].disposition).toEqual({ kind: 'kept', head: 'head1' });
    expect(r.orders?.records[0].disposition?.kind).toBe('dropped');
    expect(git.resets).toEqual(['head1']);
    expect(r.outcome).toBe('partially-landed');
    expect(r.head).toBe('head1');
    expect(r.ledger).toContain('recipe group verified as one unit');
  });

  it('a dropped recipe group is reverted, its applied orders marked dropped and its rows recorded on the failing step', async () => {
    const git = fakeGit();
    // Install fails on the group's head only: the seam counts calls so the
    // agent order's identical head string passes on the second visit.
    let installCalls = 0;
    const r = await runRemediateTask({
      cwd: tmpCwd(),
      trust: trustedLocalContext(),
      taskId: 'fix-vulns',
      config: config(),
      drivers: [driver()],
      git,
      runFloor: () => GREEN_FLOOR,
      runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
      verifySeams: {
        worktree: async <T>(opts: { ref: string }, fn: (p: string) => Promise<T>) => fn(opts.ref),
        install: (head) => {
          installCalls += 1;
          // 1st: the group's head1 (broken); 2nd: the base probe (installs);
          // later: the agent order (installs).
          return installCalls === 1 && head === 'head1' ? BROKEN : INSTALLED;
        },
        changedFiles: () => ['package.json'],
      },
      armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
      runRecipePhase: async () => {
        git.commit(); // the recipe tier committed the pin: head0 -> head1
        return summary([agentOrder('floor-failure:a')], {
          ran: true,
          selectedRecipeTier: 1,
          records: [appliedRecord],
        });
      },
      frameInvariants: {
        step: () => ({ applied: [], notApplicable: [], changedPaths: [], failed: false }),
      },
    });
    expect(r.recipes?.groupVerification).toEqual({
      kept: false,
      step: 'install',
      reason: expect.stringContaining('lockfile-drift'),
      droppedOrderIds: ['dep-advisory:js-yaml'],
    });
    expect(git.resets[0]).toBe('head0');
    expect(r.recipes?.records[0].disposition?.kind).toBe('dropped');
    // The agent order dispatched from the base and landed.
    expect(r.orders?.records[0].disposition?.kind).toBe('kept');
    expect(r.outcome).toBe('partially-landed');
    expect(r.ledger).toContain('recipe group DROPPED before the agent tier at install');
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows.map((row) => [row.orderId, row.tier, row.outcome])).toEqual([
      ['dep-advisory:js-yaml', 'recipe', 'install-failed'],
      ['floor-failure:a', 'agent', 'verified'],
    ]);
  });
});

describe('the executor lands a partially-landed run as a normal PR and keeps it non-clean', () => {
  it('landEligible, not a draft, title says partial, clean:false', async () => {
    const cwd = tmpCwd();
    let landed: { draft?: boolean; prTitle: string } | undefined;
    const run = await executeTask(cwd, { ...config(), tasks: ['fix-build'] }, 'fix-build', 'pr', {
      runTask: async () => ({
        outcome: 'partially-landed',
        task: 'fix-build',
        ledger: 'LEDGER',
        baseHead: 'aaaa1111',
        head: 'bbbb2222',
      }),
      branch: () => 'main',
      defaultBranch: () => 'main',
      landHead: (o) => {
        landed = { ...(o.draft !== undefined ? { draft: o.draft } : {}), prTitle: o.prTitle };
        return {
          outcome: 'pr-opened' as const,
          mode: 'pr' as const,
          prUrl: 'https://example.test/pr/9',
        };
      },
      probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
      writeOrderLedger: () => null,
      publishOrderRows: () => ({ published: true }),
    });
    expect(run.landed).toBe(true);
    expect(run.clean).toBe(false);
    expect(run.prUrl).toBe('https://example.test/pr/9');
    expect(landed?.draft).toBe(false);
    expect(landed?.prTitle).toContain('partial: some orders dropped');
  });
});
