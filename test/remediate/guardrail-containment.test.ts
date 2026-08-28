/**
 * Guardrail-red containment per order (4.4.7, defect A2): the final
 * guardrail is the run's ONE arbiter, but its red verdict must not drag
 * verified orders down with the one order that caused it. Pinned here,
 * both directions per behavior:
 *
 *   - contained: blocking findings attribute to one order (package match /
 *     diff / envelope overlap), the attributed order's commits are
 *     reverted, the remainder re-verifies green and lands as
 *     `partially-landed`; the ledger, containment disclosure, and breaker
 *     rows name the dropped order on its own failure;
 *   - evidence strength: direct evidence (package naming, committed-diff
 *     touch) outranks circumstantial overlap (envelope containment, the
 *     manifest heuristic), so a repo-wide-envelope order can never absorb
 *     another order's finding; within one tier a driver-failed order is
 *     preferred over verified ones; ambiguity among verified orders
 *     REFUSES;
 *   - refusal: a finding attributing to NO order refuses; a red that
 *     survives the bounded rounds refuses and restores the branch; a red
 *     with no attributable findings (a refusal-tier verdict) refuses; a
 *     revert conflict refuses; dropping EVERY order refuses (nothing would
 *     remain);
 *   - driver-failure hygiene: a driver-failed order's committed partial is
 *     verified like any order and disclosed in the ledger when kept;
 *   - the pure attribution ladder and the recipe-fallthrough budget floor.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeTask } from '../../src/remediate/cli';
import { DEFERRED_LANDING_ENV, landingRecordPath } from '../../src/remediate/landing-record';
import { trustedLocalContext } from '../../src/analysis-trust';
import { runRemediateTask, type RemediateGit, type RemediateResult } from '../../src/remediate/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RecipePhaseSummary } from '../../src/remediate/recipes/run-recipes';
import type { WorkOrder, WorkOrderFinding } from '../../src/remediate/work-orders/types';
import { deriveBudget, withRecipeFallthroughBudget } from '../../src/remediate/work-orders/shared';
import type { GuardrailGateResult } from '../../src/lanes/verify';
import { orderOutcomeRows } from '../../src/remediate/order-outcomes';
import {
  attributeFinding,
  buildKeptUnits,
  overlapEvidence,
  MAX_CONTAINMENT_ROUNDS,
  type KeptUnit,
} from '../../src/remediate/containment';
import { GREEN_FLOOR } from './helpers';
import { makeOrder } from './recipes/helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-containment-'));
  dirs.push(d);
  return d;
}

/** A head-counting fake with per-range diff paths and a revert log. A
 *  revert commits at the tip (head advances); a reset moves it back. */
function fakeGit(rangePaths: Record<string, readonly string[]> = {}) {
  let commits = 0;
  const g = {
    resets: [] as string[],
    reverts: [] as { from: string; to: string; message: string }[],
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
    changedPaths: (base: string, head?: string) => [
      ...(rangePaths[`${base}..${head ?? 'HEAD'}`] ?? ['src/a.ts']),
    ],
    commitPaths: () => {
      commits += 1;
    },
    cleanPaths: () => {},
    revertPaths: () => {},
    revertRange: (from: string, to: string, message: string) => {
      g.reverts.push({ from, to, message });
      commits += 1;
    },
  };
  return g as RemediateGit & typeof g;
}

/** A driver whose result is scripted per run index (default: completed). */
function scriptedDriver(results: readonly Partial<AgentRunResult>[] = []): AgentDriver {
  let i = 0;
  return {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier: string) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async () => {
      const extra = results[i] ?? {};
      i += 1;
      return {
        completed: true,
        timedOut: false,
        transcriptTail: '',
        turns: 2,
        costUsd: 0.1,
        ...extra,
      };
    },
  } as unknown as AgentDriver;
}

function config(): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-vulns'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'draft-pr',
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

function floorOrder(id: string, envelopePath: string): WorkOrder {
  return makeOrder({
    id,
    class: 'floor-failure',
    tier: 'agent',
    envelope: { paths: [envelopePath], manifests: false },
    done: { absentIds: [`x#${id}`], verifier: 'floor', command: 'floor check' },
    budget: { turns: 12, minutes: 6, usd: 2, derivation: 'turns = derived(12)' },
  });
}

function depFinding(pkg: string): WorkOrderFinding {
  return {
    kind: 'dep-vuln',
    id: `dep:${pkg}`,
    attribution: 'net-new',
    evidence: { type: 'dep-vuln', package: pkg, advisoryId: 'GHSA-test' },
  };
}

function depOrder(pkg: string): WorkOrder {
  return makeOrder({
    id: `dep-advisory:${pkg}`,
    class: 'dep-advisory',
    tier: 'agent',
    findings: [depFinding(pkg)],
    envelope: { paths: ['package.json', 'package-lock.json'], manifests: true },
    done: { absentIds: [`dep:${pkg}`], verifier: 'guardrail', command: 'guardrail check' },
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

const GREEN: GuardrailGateResult = { verdict: 'PASSED', ran: true, passesGate: true };
function red(findings: GuardrailGateResult['blockingFindings']): GuardrailGateResult {
  return {
    verdict: 'BLOCKED',
    ran: true,
    passesGate: false,
    blocking: (findings ?? []).map((f) => f.description),
    ...(findings !== undefined ? { blockingFindings: findings } : {}),
  };
}

function runWith(o: {
  readonly orders: readonly WorkOrder[];
  readonly git: ReturnType<typeof fakeGit>;
  readonly driver?: AgentDriver;
  /** Guardrail results, consumed one per verification pass. */
  readonly guardrails: readonly GuardrailGateResult[];
  readonly recipePhase?: () => RecipePhaseSummary;
}): Promise<RemediateResult> {
  const gates = [...o.guardrails];
  return runRemediateTask({
    cwd: tmpCwd(),
    trust: trustedLocalContext(),
    taskId: 'fix-vulns',
    config: config(),
    drivers: [o.driver ?? scriptedDriver()],
    git: o.git,
    runFloor: () => GREEN_FLOOR,
    runGuardrail: async () => gates.shift() ?? GREEN,
    verifySeams: {
      worktree: async <T>(opts: { ref: string }, fn: (p: string) => Promise<T>) => fn(opts.ref),
      install: () => ({ status: 'installed', steps: [] }),
      changedFiles: () => ['src/a.ts'],
    },
    armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
    runRecipePhase: async () => (o.recipePhase ? o.recipePhase() : summary(o.orders)),
    frameInvariants: {
      step: async () => ({
        applied: [],
        notApplicable: [],
        changedPaths: [],
        disclosures: [],
        failed: false,
      }),
    },
  });
}

describe('guardrail-red containment: contained red lands the remainder', () => {
  it('attributes a package-named dep finding to the order naming it, drops that order, re-verifies, lands partially', async () => {
    // Order a: head0..head1 (floor, src/); order b: head1..head2 (dep pin,
    // names tmp). Final guardrail red on tmp; the re-run after the unwind
    // is green.
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['package.json', 'package-lock.json'],
    });
    const finding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] tmp@0.2.6 · GHSA-test — added (no-prior-match)',
      package: 'tmp',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/'), depOrder('tmp')],
      git,
      guardrails: [red([finding]), GREEN],
    });
    expect(r.outcome).toBe('partially-landed');
    const recs = r.orders?.records ?? [];
    expect(recs[0].disposition).toEqual({ kind: 'kept', head: 'head1' });
    expect(recs[1].disposition).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('tmp@0.2.6'),
    });
    // The unwind reverted exactly the attributed order's range, at the tip.
    expect(git.reverts).toEqual([
      {
        from: 'head1',
        to: 'head2',
        message: expect.stringContaining('dep-advisory:tmp'),
      },
    ]);
    expect(r.head).toBe('head3');
    expect(git.resets).toEqual([]);
    // The containment disclosure names the drop, its round, and the evidence.
    expect(r.containment?.refused).toBeUndefined();
    expect(r.containment?.rounds).toBe(1);
    expect(r.containment?.dropped).toEqual([
      {
        unit: 'agent-order',
        orderIds: ['dep-advisory:tmp'],
        round: 1,
        blocking: [finding.description],
        evidence: expect.stringContaining('names package tmp'),
      },
    ]);
    expect(r.note).toContain('attributed per order');
    expect(r.note).toContain('dep-advisory:tmp');
    expect(r.ledger).toContain('### Guardrail containment');
    expect(r.ledger).toContain('dep-advisory:tmp');
    // Breaker rows: the kept order verified; the dropped one carries ITS
    // OWN guardrail failure, never the run's.
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows.map((row) => [row.orderId, row.outcome])).toEqual([
      ['floor-failure:a', 'verified'],
      ['dep-advisory:tmp', 'guardrail-red'],
    ]);
  });

  it('ambiguity between a driver-failed order and a verified one attributes to the driver-failed one (disclosed tiebreak)', async () => {
    // Both orders' envelopes cover src/, so a located finding overlaps
    // both; order d's driver failed, so it is first in line.
    const git = fakeGit({
      'head0..head1': ['src/c.ts'],
      'head1..head2': ['src/d.ts'],
    });
    const finding = {
      kind: 'custom-check',
      description: '[custom-check] lint · src/x.ts:3 — added (no-prior-match)',
      file: 'src/x.ts',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:c', 'src/'), floorOrder('floor-failure:d', 'src/')],
      git,
      driver: scriptedDriver([
        {},
        { completed: false, failure: { reason: 'agent exited nonzero' } },
      ]),
      guardrails: [red([finding]), GREEN],
    });
    expect(r.outcome).toBe('partially-landed');
    const recs = r.orders?.records ?? [];
    expect(recs[0].disposition?.kind).toBe('kept');
    expect(recs[1].outcome).toBe('failed');
    expect(recs[1].disposition).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('src/x.ts'),
    });
    expect(r.containment?.dropped?.[0].evidence).toContain('driver-failed order preferred');
  });
});

describe('guardrail-red containment: evidence strength outranks the driver tiebreak', () => {
  it("a repo-wide-envelope driver-failed floor order does NOT absorb a finding another order's diff touches", async () => {
    // Order e carries the explicit repo-wide envelope (a whole-build floor
    // order) AND its driver failed, so pre-tiering it overlapped every
    // located finding and the driver tiebreak blamed it. Order f is
    // verified and its committed diff touches the finding's file: the
    // direct evidence must win in round 1.
    const git = fakeGit({
      'head0..head1': ['src/util.ts'],
      'head1..head2': ['src/f.ts'],
    });
    const finding = {
      kind: 'custom-check',
      description: '[custom-check] lint · src/f.ts:3 — added (no-prior-match)',
      file: 'src/f.ts',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:e', '*'), floorOrder('floor-failure:f', 'src/')],
      git,
      driver: scriptedDriver([
        { completed: false, failure: { reason: 'agent exited nonzero' } },
        {},
      ]),
      guardrails: [red([finding]), GREEN],
    });
    expect(r.outcome).toBe('partially-landed');
    const recs = r.orders?.records ?? [];
    // The driver-failed repo-wide order is KEPT; the diff-touching order is
    // the attributed drop.
    expect(recs[0].orderId).toBe('floor-failure:e');
    expect(recs[0].disposition?.kind).toBe('kept');
    expect(recs[1].orderId).toBe('floor-failure:f');
    expect(recs[1].disposition).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('src/f.ts'),
    });
    expect(r.containment?.rounds).toBe(1);
    expect(r.containment?.dropped?.[0].orderIds).toEqual(['floor-failure:f']);
    expect(r.containment?.dropped?.[0].evidence).toContain('committed diff touches src/f.ts');
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head1', 'head2']]);
  });
});

describe('guardrail-red containment: an unattributable red refuses honestly', () => {
  it('a finding overlapping no kept order refuses containment, keeps guardrail-red, and reverts nothing', async () => {
    const git = fakeGit();
    const finding = {
      kind: 'secret',
      description: '[secret] docs/readme.md:1 — added (no-prior-match)',
      file: 'docs/readme.md',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/')],
      git,
      guardrails: [red([finding])],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(git.reverts).toEqual([]);
    expect(git.resets).toEqual([]);
    expect(r.containment?.refused).toContain("overlaps no kept order's envelope or committed");
    expect(r.containment?.dropped).toEqual([]);
    expect(r.note).toContain('Containment was attempted and refused');
    expect(r.ledger).toContain('REFUSED');
    // The salvage phrasing of the plain guardrail-red path is unchanged.
    expect(r.note).toContain('the guardrail did not pass');
  });

  it('ambiguity among verified orders refuses (never a guess)', async () => {
    const git = fakeGit();
    const finding = {
      kind: 'custom-check',
      description: '[custom-check] lint · src/x.ts:3 — added (no-prior-match)',
      file: 'src/x.ts',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:c', 'src/'), floorOrder('floor-failure:d', 'src/')],
      git,
      guardrails: [red([finding])],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.refused).toContain('ambiguous between');
    expect(git.reverts).toEqual([]);
  });

  it('a red with no attributable blocking findings (refusal-tier verdict) refuses', async () => {
    const git = fakeGit();
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/')],
      git,
      guardrails: [{ verdict: 'CANNOT GATE', ran: true, passesGate: false }],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.refused).toContain('no attributable blocking findings');
  });

  it('a red attributing to EVERY kept order refuses: nothing would remain to land', async () => {
    const git = fakeGit();
    const finding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] tmp@0.2.6 · GHSA-test — added (no-prior-match)',
      package: 'tmp',
    };
    const r = await runWith({
      orders: [depOrder('tmp')],
      git,
      guardrails: [red([finding])],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.refused).toContain('nothing would remain to land');
    expect(git.reverts).toEqual([]);
  });

  it('a red that survives the bounded unwind rounds refuses and restores the branch', async () => {
    // Three orders in three envelope zones; every re-verification stays
    // red on a finding pointing at the next order. After the bounded
    // rounds the branch is restored to the pre-containment head.
    const git = fakeGit({
      'head0..head1': ['src/a/f.ts'],
      'head1..head2': ['src/b/f.ts'],
      'head2..head3': ['src/c/f.ts'],
    });
    const at = (p: string) => ({
      kind: 'custom-check',
      description: `[custom-check] lint · ${p}:1 — added (no-prior-match)`,
      file: p,
    });
    const r = await runWith({
      orders: [
        floorOrder('floor-failure:a', 'src/a/'),
        floorOrder('floor-failure:b', 'src/b/'),
        floorOrder('floor-failure:c', 'src/c/'),
      ],
      git,
      guardrails: [red([at('src/c/f.ts')]), red([at('src/b/f.ts')]), red([at('src/a/f.ts')])],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.rounds).toBe(MAX_CONTAINMENT_ROUNDS);
    expect(r.containment?.refused).toContain(`${MAX_CONTAINMENT_ROUNDS} unwind round(s)`);
    // Two rounds unwound (newest range first), then the restore.
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([
      ['head2', 'head3'],
      ['head1', 'head2'],
    ]);
    expect(git.resets).toEqual(['head3']);
    expect(git.head()).toBe('head3');
    // No drop survives a refusal: the ledger shows the full attempt.
    expect(r.containment?.dropped).toEqual([]);
    expect(r.orders?.records.every((x) => x.disposition?.kind === 'kept')).toBe(true);
  });

  it('a revert conflict refuses containment and restores the branch', async () => {
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['package.json', 'package-lock.json'],
    });
    git.revertRange = () => {
      throw new Error('CONFLICT (content): package-lock.json');
    };
    const finding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] tmp@0.2.6 · GHSA-test — added (no-prior-match)',
      package: 'tmp',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/'), depOrder('tmp')],
      git,
      guardrails: [red([finding])],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.refused).toContain('conflicted');
  });

  it('the remainder failing its re-verification refuses (the unwound tree no longer verifies)', async () => {
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['package.json', 'package-lock.json'],
    });
    const finding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] tmp@0.2.6 · GHSA-test — added (no-prior-match)',
      package: 'tmp',
    };
    const gates = [red([finding])];
    const r = await runRemediateTask({
      cwd: tmpCwd(),
      trust: trustedLocalContext(),
      taskId: 'fix-vulns',
      config: config(),
      drivers: [scriptedDriver()],
      git,
      runFloor: () => GREEN_FLOOR,
      runGuardrail: async () => gates.shift() ?? GREEN,
      verifySeams: {
        worktree: async <T>(opts: { ref: string }, fn: (p: string) => Promise<T>) => fn(opts.ref),
        // The post-unwind head (head3) no longer installs.
        install: (head: string) =>
          head === 'head3'
            ? {
                status: 'failed',
                pack: 'typescript',
                argv: ['npm', 'ci'],
                output: 'EUSAGE',
                classification: 'lockfile-drift',
              }
            : { status: 'installed', steps: [] },
        changedFiles: () => ['src/a.ts'],
      },
      armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
      runRecipePhase: async () => summary([floorOrder('floor-failure:a', 'src/'), depOrder('tmp')]),
      frameInvariants: {
        step: async () => ({
          applied: [],
          notApplicable: [],
          changedPaths: [],
          disclosures: [],
          failed: false,
        }),
      },
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.refused).toContain('no longer verifies after the unwind');
    // Restored: the revert commit was reset away.
    expect(git.resets).toEqual(['head2']);
  });
});

describe('guardrail-red containment: the recipe group is one unit', () => {
  it('a finding overlapping only the recipe group diff drops the GROUP, keeps the agent order, and the rows record it', async () => {
    const git = fakeGit({
      'head0..head1': ['package.json', 'package-lock.json'],
      'head1..head2': ['src/a.ts'],
    });
    const appliedRecord = {
      orderId: 'dep-advisory:js-yaml',
      class: 'dep-advisory',
      recipe: 'override-pin',
      outcome: { kind: 'applied' as const, changedFiles: ['package.json'] },
    };
    const finding = {
      kind: 'config',
      description: '[config] package.json:4 — added (no-prior-match)',
      file: 'package.json',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/')],
      git,
      // The group pre-verification defers the guardrail, so the seam is
      // consumed only by the final pass (red) and the containment re-run.
      guardrails: [red([finding]), GREEN],
      recipePhase: () => {
        git.commit(); // the recipe tier committed the pin: head0 -> head1
        return summary([floorOrder('floor-failure:a', 'src/')], {
          ran: true,
          selectedRecipeTier: 1,
          records: [appliedRecord],
        });
      },
    });
    expect(r.outcome).toBe('partially-landed');
    expect(r.recipes?.groupVerification).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('package.json'),
      droppedOrderIds: ['dep-advisory:js-yaml'],
    });
    expect(r.recipes?.records[0].disposition?.kind).toBe('dropped');
    expect(r.orders?.records[0].disposition?.kind).toBe('kept');
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head0', 'head1']]);
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows.map((row) => [row.orderId, row.tier, row.outcome])).toEqual([
      ['dep-advisory:js-yaml', 'recipe', 'guardrail-red'],
      ['floor-failure:a', 'agent', 'verified'],
    ]);
  });
});

describe('guardrail-red containment: a red on a recipe-pinned package blames the GROUP, not a driver-failed agent order', () => {
  it('the group unit carries the packages its applied orders pinned, so the package tier attributes to it', async () => {
    const git = fakeGit({
      'head0..head1': ['package.json', 'package-lock.json'],
      'head1..head2': ['package.json', 'package-lock.json'],
    });
    const appliedRecord = {
      orderId: 'dep-advisory:left-pad',
      class: 'dep-advisory',
      recipe: 'override-pin',
      outcome: { kind: 'applied' as const, changedFiles: ['package.json'] },
      packages: ['left-pad'],
    };
    // The red names the package the RECIPE pinned; the driver-failed agent
    // order for another package also touched the manifests, so pre-fix the
    // package tier could never match the group and the driver tiebreak
    // blamed the innocent agent order.
    const finding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] left-pad@1.0.0 · GHSA-test — added (no-prior-match)',
      package: 'left-pad',
    };
    const r = await runWith({
      orders: [depOrder('tmp')],
      git,
      driver: scriptedDriver([{ completed: false, failure: { reason: 'agent exited nonzero' } }]),
      guardrails: [red([finding]), GREEN],
      recipePhase: () => {
        git.commit(); // the recipe tier committed the pin: head0 -> head1
        return summary([depOrder('tmp')], {
          ran: true,
          selectedRecipeTier: 1,
          records: [appliedRecord],
        });
      },
    });
    expect(r.outcome).toBe('partially-landed');
    expect(r.recipes?.groupVerification).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('left-pad'),
      droppedOrderIds: ['dep-advisory:left-pad'],
    });
    // The driver-failed agent order is KEPT: the package evidence names the
    // group, so no tiebreak ever ran against the innocent order.
    expect(r.orders?.records[0].disposition?.kind).toBe('kept');
    expect(r.containment?.dropped?.[0]).toEqual(
      expect.objectContaining({
        unit: 'recipe-group',
        orderIds: ['dep-advisory:left-pad'],
        evidence: expect.stringContaining('names package left-pad'),
      }),
    );
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head0', 'head1']]);
  });
});

describe('driver-failure hygiene: verification is the evidence, first in line for attribution', () => {
  it('a driver-failed order that survives per-order verification is KEPT and disclosed in the ledger', async () => {
    const git = fakeGit();
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/')],
      git,
      driver: scriptedDriver([{ completed: false, failure: { reason: 'max turns exhausted' } }]),
      guardrails: [GREEN],
    });
    expect(r.orders?.records[0].outcome).toBe('failed');
    expect(r.orders?.records[0].disposition?.kind).toBe('kept');
    expect(r.ledger).toContain('driver-failure disclosure');
    expect(r.ledger).toContain('first in line for containment attribution');
    // The breaker row stays neutral for a kept-but-driver-failed order.
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows[0].outcome).toBe('partial-kept');
  });
});

describe('a failed branch restore is disclosed and suppresses the salvage draft', () => {
  it('a refusal whose restore throws sets restoreFailed and says the branch stays local', async () => {
    // Round 1 attributes and reverts; the re-run stays red on a finding
    // no remaining order overlaps, so containment refuses AFTER mutating
    // the branch, and the restore itself throws.
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['package.json', 'package-lock.json'],
    });
    git.resetTo = () => {
      throw new Error('reset refused by the filesystem');
    };
    const tmpFinding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] tmp@0.2.6 · GHSA-test — added (no-prior-match)',
      package: 'tmp',
    };
    const strayFinding = {
      kind: 'secret',
      description: '[secret] docs/readme.md:1 — added (no-prior-match)',
      file: 'docs/readme.md',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/'), depOrder('tmp')],
      git,
      guardrails: [red([tmpFinding]), red([strayFinding])],
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(r.containment?.restoreFailed).toBe(true);
    expect(r.containment?.refused).toContain('restoring the branch');
    expect(r.containment?.refused).toContain('left as-is for inspection');
  });

  it('executor: a guardrail-red refusal with a CLEAN restore still pushes the blocked salvage draft', async () => {
    const cwd = tmpCwd();
    let pushed = 0;
    const run = await executeTask(cwd, config(), 'fix-vulns', 'pr', {
      runTask: async () => refusedRedResult(false),
      branch: () => 'main',
      defaultBranch: () => 'main',
      landHead: () => {
        pushed += 1;
        return { outcome: 'pr-opened' as const, mode: 'pr' as const, prUrl: 'x' };
      },
      probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
      writeOrderLedger: () => null,
      publishOrderRows: () => ({ published: true }),
    });
    expect(pushed).toBe(1);
    expect(run.landed).toBe(true);
    expect(run.clean).toBe(false);
  });

  it('executor: a guardrail-red refusal whose restore FAILED never pushes (HEAD is a tree no verification saw)', async () => {
    const cwd = tmpCwd();
    let pushed = 0;
    const run = await executeTask(cwd, config(), 'fix-vulns', 'pr', {
      runTask: async () => refusedRedResult(true),
      branch: () => 'main',
      defaultBranch: () => 'main',
      landHead: () => {
        pushed += 1;
        return { outcome: 'pr-opened' as const, mode: 'pr' as const, prUrl: 'x' };
      },
      probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
      writeOrderLedger: () => null,
      publishOrderRows: () => ({ published: true }),
    });
    expect(pushed).toBe(0);
    expect(run.landed).toBe(false);
  });
});

/** A guardrail-red refusal result for the executor's salvage decision. */
function refusedRedResult(restoreFailed: boolean): RemediateResult {
  return {
    outcome: 'guardrail-red',
    task: 'fix-vulns',
    ledger: 'THE VERIFICATION LEDGER',
    baseHead: 'aaaa1111',
    head: 'bbbb2222',
    guardrailRan: true,
    containment: {
      maxRounds: MAX_CONTAINMENT_ROUNDS,
      rounds: 1,
      dropped: [],
      refused: 'the remainder no longer verifies after the unwind',
      ...(restoreFailed ? { restoreFailed: true as const } : {}),
    },
  };
}

describe('composition with the deferred landing record (two-phase landing)', () => {
  it('a contained run under the lane env writes ONE landing record for the green subset, no push attempted', async () => {
    const cwd = tmpCwd();
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd });
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

    const contained: RemediateResult = {
      outcome: 'partially-landed',
      task: 'fix-vulns',
      ledger: 'THE VERIFICATION LEDGER',
      baseHead: head,
      head,
      containment: {
        maxRounds: MAX_CONTAINMENT_ROUNDS,
        rounds: 1,
        dropped: [
          {
            unit: 'agent-order',
            orderIds: ['dep-advisory:tmp'],
            round: 1,
            blocking: ['[dep-vuln] tmp@0.2.6'],
            evidence: 'the order names package tmp',
          },
        ],
      },
      orders: {
        cap: 5,
        queued: 2,
        records: [
          {
            orderId: 'floor-failure:a',
            class: 'floor-failure',
            findings: 1,
            budget: { turns: 12, minutes: 6, usd: 2, derivation: 'd' },
            outcome: 'completed',
            done: { verifier: 'floor', absentIds: 1 },
            disposition: { kind: 'kept', head },
          },
          {
            orderId: 'dep-advisory:tmp',
            class: 'dep-advisory',
            findings: 1,
            budget: { turns: 12, minutes: 6, usd: 2, derivation: 'd' },
            outcome: 'completed',
            done: { verifier: 'guardrail', absentIds: 1 },
            disposition: {
              kind: 'dropped',
              step: 'guardrail',
              reason: 'the final guardrail attributed blocking finding(s) to this order',
            },
          },
        ],
      },
    };
    let pushed = 0;
    const run = await executeTask(cwd, config(), 'fix-vulns', 'pr', {
      runTask: async () => contained,
      branch: () => 'main',
      defaultBranch: () => 'main',
      landHead: () => {
        pushed += 1;
        return { outcome: 'pr-opened' as const, mode: 'pr' as const, prUrl: 'x' };
      },
      probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
      env: { [DEFERRED_LANDING_ENV]: '1' },
    });
    expect(pushed).toBe(0);
    expect(run.landed).toBe(false);
    expect(run.landingDeferred).toContain('remediate land');
    // A partial landing is not clean: the dropped order stays visible.
    expect(run.clean).toBe(false);
    const record = JSON.parse(
      fs.readFileSync(path.join(cwd, landingRecordPath('fix-vulns')), 'utf8'),
    ) as {
      action: string;
      head: string;
      prTitle: string;
      orderRows: { orderId: string; outcome: string }[];
    };
    expect(record.action).toBe('land');
    expect(record.head).toBe(head);
    expect(record.prTitle).toContain('partial');
    // The rows the record carries name each order's OWN outcome: the kept
    // one verified, the contained one on its guardrail failure.
    expect(record.orderRows.map((row) => [row.orderId, row.outcome])).toEqual([
      ['floor-failure:a', 'verified'],
      ['dep-advisory:tmp', 'guardrail-red'],
    ]);
  });
});

describe('the pure attribution ladder', () => {
  const unit = (over: Partial<KeptUnit> & Pick<KeptUnit, 'orderIds'>): KeptUnit => ({
    unit: 'agent-order',
    from: 'h0',
    to: 'h1',
    diffPaths: [],
    packages: new Set(),
    driverFailed: false,
    ...over,
  });
  const noManifest = () => false;

  it('package naming narrows manifest-overlap ambiguity to the order naming the package', () => {
    const a = unit({ orderIds: ['dep-advisory:a'], diffPaths: ['package-lock.json'] });
    const b = unit({
      orderIds: ['dep-advisory:tmp'],
      diffPaths: ['package-lock.json'],
      packages: new Set(['tmp']),
    });
    const isManifest = (p: string) => p === 'package-lock.json';
    const res = attributeFinding(
      { kind: 'dep-vuln', description: 'tmp advisory', package: 'tmp' },
      [a, b],
      isManifest,
    );
    expect(res).toEqual({
      kind: 'attributed',
      unit: b,
      evidence: expect.stringContaining('names package tmp'),
    });
  });

  it('ambiguity among several driver-failed candidates stays ambiguous (never a coin flip)', () => {
    const a = unit({ orderIds: ['x'], diffPaths: ['src/x.ts'], driverFailed: true });
    const b = unit({ orderIds: ['y'], diffPaths: ['src/x.ts'], driverFailed: true });
    const res = attributeFinding(
      { kind: 'custom-check', description: 'f', file: 'src/x.ts' },
      [a, b],
      noManifest,
    );
    expect(res.kind).toBe('ambiguous');
  });

  it('overlap evidence covers diff, envelope, and manifest directions with their tiers, and refuses coordinates it lacks', () => {
    const u = unit({
      orderIds: ['o'],
      diffPaths: ['src/a.ts'],
      envelope: { paths: ['src/'], manifests: false },
    });
    expect(
      overlapEvidence({ kind: 'code', description: 'f', file: 'src/a.ts' }, u, noManifest),
    ).toEqual({
      tier: 1,
      evidence: expect.stringContaining('committed diff touches'),
    });
    expect(
      overlapEvidence({ kind: 'code', description: 'f', file: 'src/b.ts' }, u, noManifest),
    ).toEqual({
      tier: 2,
      evidence: expect.stringContaining('inside the order envelope'),
    });
    expect(
      overlapEvidence({ kind: 'code', description: 'f', file: 'docs/x.md' }, u, noManifest),
    ).toBeNull();
    // A finding with neither file nor package can never be attributed.
    expect(overlapEvidence({ kind: 'paired-change', description: 'f' }, u, noManifest)).toBeNull();
    // Package naming is direct; the manifest heuristic is circumstantial.
    const dep = unit({
      orderIds: ['d'],
      packages: new Set(['tmp']),
      diffPaths: ['package-lock.json'],
    });
    const isManifest = (x: string) => x === 'package-lock.json';
    expect(
      overlapEvidence({ kind: 'dep-vuln', description: 'f', package: 'tmp' }, dep, isManifest)
        ?.tier,
    ).toBe(1);
    expect(
      overlapEvidence({ kind: 'dep-vuln', description: 'f', package: 'left-pad' }, dep, isManifest)
        ?.tier,
    ).toBe(2);
  });

  it('tier-1 diff evidence beats a repo-wide-envelope driver-failed candidate (a tiebreak never beats evidence)', () => {
    const repoWide = unit({
      orderIds: ['floor-failure:whole-build'],
      diffPaths: ['src/util.ts'],
      envelope: { paths: ['*'], manifests: false },
      driverFailed: true,
    });
    const toucher = unit({
      orderIds: ['floor-failure:f'],
      diffPaths: ['src/f.ts'],
      envelope: { paths: ['src/'], manifests: false },
    });
    const res = attributeFinding(
      { kind: 'custom-check', description: 'f', file: 'src/f.ts' },
      [repoWide, toucher],
      noManifest,
    );
    expect(res).toEqual({
      kind: 'attributed',
      unit: toucher,
      evidence: expect.stringContaining('direct evidence outranked'),
    });
  });

  it('buildKeptUnits refuses a chain that does not close on the verified head', () => {
    const git = fakeGit();
    git.commit(); // head1, but no kept disposition accounts for it
    const res = buildKeptUnits({
      git,
      baseHead: 'head0',
      agentBase: 'head0',
      entryFloor: GREEN_FLOOR,
      runFloor: () => GREEN_FLOOR,
      recipes: summary([]),
      records: [],
      ordersById: new Map(),
      guardrail: GREEN,
      isManifestPath: noManifest,
    });
    expect(typeof res).toBe('string');
    expect(res).toContain('cannot be trusted');
  });
});

describe('the recipe-fallthrough budget floor (derivation, not a constant)', () => {
  const cap = { maxTurns: 40, maxMinutes: 60, maxUsd: 5 };

  it('doubles the derived floor for a fallthrough order, clamped by the task cap, with the formula disclosed', () => {
    const standard = deriveBudget(1, cap);
    expect(standard.turns).toBe(12);
    expect(standard.derivation).not.toContain('recipe-fallthrough');
    const raised = deriveBudget(1, cap, { recipeFallthrough: true });
    expect(raised.turns).toBe(24);
    expect(raised.minutes).toBe(14);
    expect(raised.derivation).toContain('recipe-fallthrough floor');
    expect(raised.derivation).toContain('2 *');
    // Still clamped by the cap in every dimension.
    const clamped = deriveBudget(
      10,
      { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
      {
        recipeFallthrough: true,
      },
    );
    expect(clamped.turns).toBe(30);
    expect(clamped.minutes).toBe(20);
    expect(clamped.usd).toBeLessThanOrEqual(3);
  });

  it('withRecipeFallthroughBudget re-derives from the order finding count through the ONE formula', () => {
    const order = depOrder('tmp');
    const raised = withRecipeFallthroughBudget(order, cap);
    expect(raised.budget).toEqual(
      deriveBudget(order.findings.length, cap, { recipeFallthrough: true }),
    );
    expect(raised.id).toBe(order.id);
  });
});
