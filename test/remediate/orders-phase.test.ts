/**
 * The order-driven agent phase (section 3C): one order per agent run, value
 * order, cap honored with disclosure; the order's derived budget IS the
 * driver budget; the order scope file is written before each dispatch and
 * cleared after (the Stop-gate's in-session done contract); envelope
 * enforcement drops out-of-envelope commits with disclosure; a dead CLI
 * stops the queue; the tool policy is applied through the driver's declared
 * mechanism and disclosed either way; and the ledger renders the per-order
 * sections. Open-ended tasks and order-less runs keep the legacy
 * task-prompt path byte-identical (pinned by the existing run tests).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  renderRemediateLedger,
  runRemediateTask,
  type RemediateGit,
} from '../../src/remediate/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { RemediateConfig } from '../../src/remediate/config';
import { DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import { trustedLocalContext } from '../../src/analysis-trust';
import type { RecipePhaseSummary } from '../../src/remediate/recipes/run-recipes';
import { makeOrder } from './recipes/helpers';
import type { WorkOrder } from '../../src/remediate/work-orders/types';
import { orderRunDisallowedTools } from '../../src/remediate/tool-policy';
import { installCommandPrefixes } from '../../src/package-manager';
import { ORDER_TOKEN_ENV, readOrderScope } from '../../src/loop/order-scope';

const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-orders-'));
}

function agentOrder(id: string, overrides: Partial<WorkOrder> = {}): WorkOrder {
  return makeOrder({
    id,
    class: 'floor-failure',
    tier: 'agent',
    envelope: { paths: ['src/'], manifests: false },
    done: { absentIds: [`typescript:tests#${id}`], verifier: 'floor', command: 'floor check' },
    budget: { turns: 12, minutes: 6, usd: 2, derivation: 'turns = derived(12)' },
    ...overrides,
  });
}

function summaryWith(orders: readonly WorkOrder[]): RecipePhaseSummary {
  return {
    ran: false,
    disclosures: [],
    selectedRecipeTier: 0,
    selectedAgentTier: orders.length,
    records: [],
    agentOrders: orders,
  };
}

interface GitScript {
  diffAfterRuns?: boolean;
  outside?: string[];
  enforceError?: string;
  sweepError?: string;
}

function fakeGit(script: GitScript = {}): RemediateGit & {
  enforceCalls: Array<{ base: string; allowed: (p: string) => boolean }>;
} {
  let commits = 0;
  const g = {
    enforceCalls: [] as Array<{ base: string; allowed: (p: string) => boolean }>,
    head: () => `head${commits}`,
    sweepLeftovers: () => script.sweepError,
    scrubRuntimeArtifacts: () => [] as string[],
    hasDiff: () => (script.diffAfterRuns ?? true) && commits > 0,
    enforceEnvelope: (base: string, allowed: (p: string) => boolean) => {
      g.enforceCalls.push({ base, allowed });
      commits += 1; // each dispatch that reaches enforcement counts as work
      if (script.enforceError) return { dropped: [], error: script.enforceError };
      const dropped = (script.outside ?? []).filter((p) => !allowed(p));
      return { dropped };
    },
  };
  return g;
}

function fakeDriver(
  perRun: (runIndex: number) => Partial<AgentRunResult>,
  overrides: Partial<AgentDriver> = {},
): AgentDriver & { runs: Parameters<AgentDriver['run']>[0][]; scopes: unknown[] } {
  const driver: AgentDriver & { runs: Parameters<AgentDriver['run']>[0][]; scopes: unknown[] } = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async (opts) => {
      driver.runs.push(opts);
      // Capture the order scope AS SEEN DURING the run (written before,
      // cleared after — this is the only window it exists in), bound by the
      // session token the runner injected into the agent env.
      driver.scopes.push(
        readOrderScope(opts.cwd, { expectedToken: opts.env[ORDER_TOKEN_ENV] }).scope,
      );
      return {
        completed: true,
        timedOut: false,
        transcriptTail: '',
        ...perRun(driver.runs.length - 1),
      };
    },
    runs: [],
    scopes: [],
    ...overrides,
  };
  return driver;
}

function config(partial: Partial<RemediateConfig> = {}): RemediateConfig {
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
    ...partial,
  };
}

function base(
  driver: AgentDriver,
  orders: readonly WorkOrder[],
  extra: Partial<Parameters<typeof runRemediateTask>[0]> = {},
) {
  return {
    cwd: tmpCwd(),
    trust: trustedLocalContext(),
    taskId: 'fix-vulns',
    config: config(),
    drivers: [driver],
    git: fakeGit(),
    runFloor: () => GREEN_FLOOR,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    verifySeams: {
      worktree: async <T>(_o: unknown, fn: (p: string) => Promise<T>) => fn('/tmp/fake-wt'),
      install: () => ({ status: 'nothing-to-install' }) as const,
      changedFiles: () => ['src/a.ts'],
    },
    armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
    runRecipePhase: async () => summaryWith(orders),
    ...extra,
  };
}

describe('order dispatch: one order per run, value order, cap honored', () => {
  it('dispatches each queued order in its own driver run, in queue order, with the rendered order prompt', async () => {
    const driver = fakeDriver(() => ({}));
    const orders = [agentOrder('floor-failure:a'), agentOrder('floor-failure:b')];
    const r = await runRemediateTask(base(driver, orders));
    expect(driver.runs).toHaveLength(2);
    expect(driver.runs[0].prompt).toContain('Work order floor-failure:a');
    expect(driver.runs[0].prompt).not.toContain('floor-failure:b');
    expect(driver.runs[1].prompt).toContain('Work order floor-failure:b');
    // The rendered order carries the shared ground rules and the budget note.
    expect(driver.runs[0].prompt).toContain('Ground rules (non-negotiable)');
    expect(driver.runs[0].prompt).toContain('Budget for this run (runner-enforced)');
    expect(r.outcome).toBe('verified');
    expect(r.orders?.records.map((rec) => [rec.orderId, rec.outcome])).toEqual([
      ['floor-failure:a', 'completed'],
      ['floor-failure:b', 'completed'],
    ]);
  });

  it('honors remediate.maxOrdersPerRun: orders beyond the cap are disclosed, never silently dropped', async () => {
    const driver = fakeDriver(() => ({}));
    const orders = ['a', 'b', 'c', 'd', 'e'].map((s) => agentOrder(`floor-failure:${s}`));
    const r = await runRemediateTask(
      base(driver, orders, { config: config({ maxOrdersPerRun: 2 }) }),
    );
    expect(driver.runs).toHaveLength(2);
    const notDispatched = (r.orders?.records ?? []).filter((x) => x.outcome === 'not-dispatched');
    expect(notDispatched).toHaveLength(3);
    expect(notDispatched[0].detail).toContain('maxOrdersPerRun');
    expect(r.ledger).toContain('not-dispatched');
  });

  it('maxOrdersPerRun: 0 keeps the legacy task-prompt path (order dispatch off)', async () => {
    const driver = fakeDriver(() => ({}));
    const orders = [agentOrder('floor-failure:a')];
    const r = await runRemediateTask(
      base(driver, orders, { config: config({ maxOrdersPerRun: 0 }) }),
    );
    expect(driver.runs).toHaveLength(1);
    // The legacy path sends the TASK prompt, not a work order.
    expect(driver.runs[0].prompt).not.toContain('Work order');
    expect(r.orders).toBeUndefined();
  });

  it('a summary carrying no order queue (no plan) keeps the legacy path under the default cap', async () => {
    const driver = fakeDriver(() => ({}));
    const legacySummary: RecipePhaseSummary = {
      ran: false,
      disclosures: [],
      selectedRecipeTier: 0,
      selectedAgentTier: 1,
      records: [],
      // agentOrders absent: planning failed or an older summary shape.
    };
    const r = await runRemediateTask(
      base(driver, [], { runRecipePhase: async () => legacySummary }),
    );
    expect(driver.runs).toHaveLength(1);
    expect(driver.runs[0].prompt).not.toContain('Work order');
    expect(r.orders).toBeUndefined();
  });
});

describe('derived budget reaches the driver, disclosed with its derivation', () => {
  it("the order's planner-derived budget becomes the driver budget for that run", async () => {
    const driver = fakeDriver(() => ({ turns: 5, costUsd: 0.5 }));
    const order = agentOrder('floor-failure:a', {
      budget: { turns: 17, minutes: 9, usd: 3, derivation: 'turns = derived(17)' },
    });
    const r = await runRemediateTask(base(driver, [order]));
    expect(driver.runs[0].budget).toEqual({ maxTurns: 17, maxMinutes: 9 });
    expect(r.orders?.records[0].budget.derivation).toBe('turns = derived(17)');
    expect(r.ledger).toContain('turns = derived(17)');
    // Envelope totals aggregate the per-order spends.
    expect(r.envelope?.turns).toBe(5);
    expect(r.envelope?.costUsd).toBe(0.5);
  });

  it('per-order minutes are clamped to the run budget remaining, disclosed', async () => {
    const driver = fakeDriver(() => ({}));
    const order = agentOrder('floor-failure:a', {
      budget: { turns: 10, minutes: 500, usd: 1, derivation: 'd' },
    });
    const r = await runRemediateTask(base(driver, [order])); // run cap: 30 min
    expect(driver.runs[0].budget.maxMinutes).toBeLessThanOrEqual(30);
    expect(r.orders?.records[0].clamped).toContain('clamped');
  });

  it('turns accumulate across orders against runBudget.maxTurns: clamped, then exhausted with disclosure', async () => {
    // Run cap 60 turns; each order derives 50. Order a spends 50, b is
    // clamped to the remaining 10, c finds the turn budget exhausted.
    const driver = fakeDriver(() => ({ turns: 50 }));
    const orders = ['a', 'b', 'c'].map((x) =>
      agentOrder(`floor-failure:${x}`, {
        budget: { turns: 50, minutes: 5, usd: 1, derivation: 'd' },
      }),
    );
    const r = await runRemediateTask(
      base(driver, orders, {
        config: config({
          agent: {
            driver: 'fake-agent',
            model: 'auto',
            budget: { ...DEFAULT_REMEDIATE_BUDGET, maxTurns: 60 },
          },
        }),
      }),
    );
    expect(driver.runs).toHaveLength(2);
    expect(driver.runs[0].budget.maxTurns).toBe(50);
    expect(driver.runs[1].budget.maxTurns).toBe(10);
    const recB = r.orders?.records.find((x) => x.orderId === 'floor-failure:b');
    expect(recB?.clamped).toContain('turns clamped 50 to 10');
    const recC = r.orders?.records.find((x) => x.orderId === 'floor-failure:c');
    expect(recC?.outcome).toBe('not-dispatched');
    expect(recC?.detail).toContain('turns');
    expect(r.outcome).toBe('budget-exhausted');
  });

  it('run-budget exhaustion (spend) stops dispatch with the later orders deferred, and the verified diff lands as budget-exhausted', async () => {
    // First order reports spend beyond the whole run cap.
    const driver = fakeDriver(() => ({ costUsd: 99 }));
    const orders = [agentOrder('floor-failure:a'), agentOrder('floor-failure:b')];
    const r = await runRemediateTask(base(driver, orders));
    expect(driver.runs).toHaveLength(1);
    const second = r.orders?.records.find((x) => x.orderId === 'floor-failure:b');
    expect(second?.outcome).toBe('not-dispatched');
    expect(second?.detail).toContain('run budget is exhausted');
    expect(r.outcome).toBe('budget-exhausted');
    expect(r.partial).toBe(true);
  });
});

describe('the order scope file (the Stop-gate in-session done contract)', () => {
  it('is written before each dispatch with the order done criterion, and cleared after', async () => {
    const driver = fakeDriver(() => ({}));
    const order = agentOrder('floor-failure:a');
    const opts = base(driver, [order]);
    await runRemediateTask(opts);
    // Seen during the run:
    const scope = driver.scopes[0] as {
      orderId: string;
      absentIds: string[];
      kinds: string[];
      verifier: string;
      token: string;
      envelope: { paths: string[] };
    } | null;
    expect(scope).not.toBeNull();
    expect(scope!.orderId).toBe('floor-failure:a');
    expect(scope!.absentIds).toEqual(['typescript:tests#floor-failure:a']);
    expect(scope!.kinds).toEqual([]);
    expect(scope!.verifier).toBe('floor');
    expect(scope!.token).toBeTruthy();
    expect(scope!.envelope.paths).toEqual(['src/']);
    // Cleared after the dispatch:
    expect(readOrderScope(opts.cwd).scope).toBeNull();
  });

  it('is cleared even when the driver throws', async () => {
    const driver = fakeDriver(() => ({}));
    driver.run = async (opts) => {
      driver.runs.push(opts);
      throw new Error('driver crashed');
    };
    const order = agentOrder('floor-failure:a');
    const opts = base(driver, [order]);
    await expect(runRemediateTask(opts)).rejects.toThrow('driver crashed');
    expect(readOrderScope(opts.cwd).scope).toBeNull();
  });
});

describe('envelope enforcement at the sweep', () => {
  it('drops committed out-of-envelope hunks with disclosure in the records and the ledger', async () => {
    const driver = fakeDriver(() => ({}));
    const git = fakeGit({ outside: ['README.md', 'src/ok.ts', '.github/workflows/x.yml'] });
    const order = agentOrder('floor-failure:a');
    const r = await runRemediateTask(base(driver, [order], { git }));
    expect(git.enforceCalls).toHaveLength(1);
    expect(r.orders?.records[0].droppedPaths).toEqual(['README.md', '.github/workflows/x.yml']);
    expect(r.ledger).toContain('envelope enforcement DROPPED');
    expect(r.ledger).toContain('README.md');
    expect(r.outcome).toBe('verified');
  });

  it('always allows the remediation notes file through the envelope', async () => {
    const driver = fakeDriver(() => ({}));
    const git = fakeGit({ outside: ['docs/DXKIT-REMEDIATION-NOTES.md'] });
    const r = await runRemediateTask(base(driver, [agentOrder('floor-failure:a')], { git }));
    expect(r.orders?.records[0].droppedPaths).toBeUndefined();
  });

  it('an enforcement failure is fail-closed: nothing lands, the step named', async () => {
    const driver = fakeDriver(() => ({}));
    const git = fakeGit({ enforceError: 'git checkout failed' });
    const r = await runRemediateTask(base(driver, [agentOrder('floor-failure:a')], { git }));
    expect(r.outcome).toBe('sweep-failed');
    expect(r.note).toContain('envelope');
    expect(r.note).toContain('git checkout failed');
  });
});

describe('dead-CLI and failure arms', () => {
  it('an uncontradicted never-ran stops the queue: later orders are not dispatched, outcome agent-never-ran', async () => {
    const driver = fakeDriver(() => ({
      completed: false,
      neverRan: { reason: 'credit exhausted' },
    }));
    const git = fakeGit({ diffAfterRuns: false });
    // never-ran path skips enforcement, so no commits accrue
    git.enforceEnvelope = (b, a) => {
      git.enforceCalls.push({ base: b, allowed: a });
      return { dropped: [] };
    };
    const orders = [agentOrder('floor-failure:a'), agentOrder('floor-failure:b')];
    const r = await runRemediateTask(base(driver, orders, { git }));
    expect(driver.runs).toHaveLength(1);
    expect(r.outcome).toBe('agent-never-ran');
    expect(r.note).toContain('credit exhausted');
    const second = r.orders?.records.find((x) => x.orderId === 'floor-failure:b');
    expect(second?.outcome).toBe('not-dispatched');
  });
});

describe('tool policy: narrowed through the driver mechanism, disclosed either way', () => {
  it('a driver declaring disallowed-tools receives the package-manager deny patterns, disclosed in the envelope', async () => {
    const driver = fakeDriver(() => ({}), {
      toolPolicy: { mechanism: 'disallowed-tools', cliRequirement: 'pinned CLI supports it' },
    });
    const r = await runRemediateTask(base(driver, [agentOrder('floor-failure:a')]));
    expect(driver.runs[0].tools?.disallowed).toEqual(orderRunDisallowedTools());
    expect(r.envelope?.toolPolicy?.mechanism).toBe('disallowed-tools');
    expect(r.ledger).toContain('tool policy: disallowed-tools');
    // Derived from package-manager.ts, never hardcoded: every known install
    // prefix appears as a deny pattern.
    for (const prefix of installCommandPrefixes()) {
      expect(driver.runs[0].tools?.disallowed).toContain(`Bash(${prefix}:*)`);
    }
  });

  it('a driver with no mechanism gets NO tools option and a disclosed none policy', async () => {
    const driver = fakeDriver(() => ({}));
    const r = await runRemediateTask(base(driver, [agentOrder('floor-failure:a')]));
    expect(driver.runs[0].tools).toBeUndefined();
    expect(r.envelope?.toolPolicy?.mechanism).toBe('none');
    expect(r.ledger).toContain('tool policy: NOT applied');
  });
});

describe('negative constraint from a prior blocked attempt', () => {
  it('priorBlocking is rendered into every order prompt and disclosed in the ledger', async () => {
    const driver = fakeDriver(() => ({}));
    const orders = [agentOrder('floor-failure:a'), agentOrder('floor-failure:b')];
    const r = await runRemediateTask(
      base(driver, orders, { priorBlocking: '- [secret] src/config.ts' }),
    );
    for (const run of driver.runs) {
      expect(run.prompt).toContain('NEGATIVE CONSTRAINT');
      expect(run.prompt).toContain('src/config.ts');
    }
    expect(r.orders?.priorBlockingApplied).toBe(true);
    expect(r.ledger).toContain('negative constraint');
  });
});

describe('refused recipe orders fall through to the agent tier in-run', () => {
  it('a recipe-only plan whose recipes all refused dispatches those orders to the agent instead of ending recipes-refused', async () => {
    const driver = fakeDriver(() => ({}));
    const refusedOrder = agentOrder('stale-lockfile:package.json', {
      class: 'stale-lockfile',
      tier: 'recipe',
      recipe: 'lockfile-sync',
    });
    const summary: RecipePhaseSummary = {
      ran: true,
      disclosures: [],
      selectedRecipeTier: 1,
      selectedAgentTier: 0,
      records: [
        {
          orderId: refusedOrder.id,
          class: 'stale-lockfile',
          recipe: 'lockfile-sync',
          outcome: { kind: 'refused', reason: 'yarn has no dry-run' },
        },
      ],
      agentOrders: [refusedOrder],
    };
    const r = await runRemediateTask(base(driver, [], { runRecipePhase: async () => summary }));
    expect(r.outcome).toBe('verified');
    expect(driver.runs).toHaveLength(1);
    expect(driver.runs[0].prompt).toContain('Work order stale-lockfile:package.json');
    // Both sections render: the recipe refusal AND the order dispatch.
    expect(r.ledger).toContain('refused, yarn has no dry-run');
    expect(r.ledger).toContain('Work-order dispatches');
  });
});

describe('manifests: false is ENFORCED at the sweep', () => {
  it('drops a dependency-manifest change even inside the envelope paths, disclosed', async () => {
    const driver = fakeDriver(() => ({}));
    const cwd = tmpCwd();
    // A real package.json plus a source file makes the TypeScript pack
    // active (detection needs manifest AND source), so the DEFAULT manifest
    // predicate (pack-declared patterns, Rule 6) recognizes the manifest —
    // no injected probe.
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fx"}');
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const x = 1;\n');
    const git = fakeGit({ outside: ['package.json', 'src/ok.ts'] });
    const order = agentOrder('floor-failure:a', {
      envelope: { paths: ['src/', 'package.json'], manifests: false },
    });
    const r = await runRemediateTask(base(driver, [order], { cwd, git }));
    expect(r.orders?.records[0].droppedPaths).toEqual(['package.json']);
    expect(r.ledger).toContain('manifest-excluded');
  });

  it('manifests: true keeps manifest changes inside the envelope', async () => {
    const driver = fakeDriver(() => ({}));
    const cwd = tmpCwd();
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fx"}');
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const x = 1;\n');
    const git = fakeGit({ outside: ['package.json'] });
    const order = agentOrder('floor-failure:a', {
      envelope: { paths: ['src/', 'package.json'], manifests: true },
    });
    const r = await runRemediateTask(base(driver, [order], { cwd, git }));
    expect(r.orders?.records[0].droppedPaths).toBeUndefined();
  });
});

describe('starvation guard: a no-diff fallback run stays non-clean', () => {
  it('refused-recipe fallback orders that landed nothing yield recipes-refused (never a green no-op)', async () => {
    const driver = fakeDriver(() => ({}));
    const fallback = agentOrder('stale-lockfile:package.json', {
      class: 'stale-lockfile',
      tier: 'recipe',
      recipe: 'lockfile-sync',
    });
    const git = fakeGit({ diffAfterRuns: false });
    const r = await runRemediateTask(base(driver, [fallback], { git }));
    expect(r.outcome).toBe('recipes-refused');
    expect(r.note).toContain('stale-lockfile:package.json');
    expect(r.note).toContain('not clean');
  });

  it('a pure agent-tier queue with no diff stays an honest no-op', async () => {
    const driver = fakeDriver(() => ({}));
    const git = fakeGit({ diffAfterRuns: false });
    const r = await runRemediateTask(base(driver, [agentOrder('floor-failure:a')], { git }));
    expect(r.outcome).toBe('no-op');
  });
});

describe('the legacy path keeps the negative constraint (maxOrdersPerRun: 0)', () => {
  it('priorBlocking is rendered into the legacy task prompt too, never silently dropped', async () => {
    const driver = fakeDriver(() => ({}));
    const r = await runRemediateTask(
      base(driver, [], {
        config: config({ maxOrdersPerRun: 0 }),
        priorBlocking: '- [secret] src/config.ts',
      }),
    );
    expect(driver.runs).toHaveLength(1);
    expect(driver.runs[0].prompt).not.toContain('Work order');
    expect(driver.runs[0].prompt).toContain('NEGATIVE CONSTRAINT');
    expect(driver.runs[0].prompt).toContain('src/config.ts');
    // No diff on this fake tree — the legacy no-op arm; the prompt content
    // above is the assertion that matters.
    expect(r.outcome).toBe('no-op');
  });
});

describe('ledger honesty for the recipe section', () => {
  it('disabled AND plan-broken renders BOTH facts (the disabled note must not hide the planError)', () => {
    const ledger = renderRemediateLedger({
      outcome: 'no-op',
      task: 'fix-build',
      recipes: {
        ran: false,
        disabled: true,
        planError: 'gather exploded',
        disclosures: [],
        selectedRecipeTier: 0,
        selectedAgentTier: 0,
        records: [],
      },
    });
    expect(ledger).toContain('Recipes are disabled by policy');
    expect(ledger).toContain('gather exploded');
  });
});

describe('the per-order done disclosure', () => {
  const failing: CorrectnessFloorResult = {
    ran: true,
    checks: [
      { pack: 'typescript', label: 'tests', bin: 'npx', status: 'fail' },
    ] as unknown as CorrectnessFloorResult['checks'],
    blocks: true,
  };

  it('floor-verifier orders report closed/open against the verified floor (check-level id)', async () => {
    const driver = fakeDriver(() => ({}));
    const order = agentOrder('floor-failure:a', {
      done: { absentIds: ['typescript:tests'], verifier: 'floor', command: 'floor check' },
    });
    // The entry floor already carries the failure (pre-existing), so the
    // verified outcome is not floor-red; the order's target id stays OPEN.
    const r = await runRemediateTask(
      base(driver, [order], { runFloor: () => failing, entryFloor: failing }),
    );
    expect(r.orders?.records[0].doneAfterVerify).toEqual({ closed: 0, open: 1, undecided: 0 });
    expect(r.ledger).toContain('still open');
  });

  it('a target check the verification did not observe is UNDECIDED, never claimed closed', async () => {
    const driver = fakeDriver(() => ({}));
    // The order targets a check the verified floor never ran (absent from
    // its checks) — the pre-fix ledger claimed it closed.
    const order = agentOrder('floor-failure:b', {
      done: { absentIds: ['go:build'], verifier: 'floor', command: 'floor check' },
    });
    const r = await runRemediateTask(
      base(driver, [order], { runFloor: () => failing, entryFloor: failing }),
    );
    expect(r.orders?.records[0].doneAfterVerify).toEqual({ closed: 0, open: 0, undecided: 1 });
    expect(r.ledger).toContain('undecided');
    expect(r.ledger).toContain('not claimed closed');
  });
});
