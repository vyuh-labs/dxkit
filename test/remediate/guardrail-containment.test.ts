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
 *   - refusal EVIDENCE (#373): a refusal keeps every executed round's
 *     drops with their attribution and the round's re-verify verdict and
 *     blocking set, names the round that refused, and all three renderers
 *     (ledger, PR body, JSON) carry the same record;
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
import { taskRunJson } from '../../src/remediate/attempt-record';
import { renderRemediatePrBody } from '../../src/remediate/ledger-render';
import { PR_BODY_ORDER_LINE_THRESHOLD } from '../../src/remediate/ledger-render-orders';
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
    // The contained case carries the same per-round record a refusal keeps
    // (#373): one round, its drop, a verified re-verify.
    expect(r.containment?.roundEvidence).toEqual([
      {
        round: 1,
        dropped: r.containment?.dropped,
        reverify: {
          verdict: 'verified',
          guardrailVerdict: 'PASSED',
          blocking: [],
          moreBlocking: 0,
        },
      },
    ]);
    expect(r.containment?.refusedAtRound).toBeUndefined();
    expect(r.note).toContain('attributed per order');
    expect(r.note).toContain('dep-advisory:tmp');
    expect(r.ledger).toContain('### Guardrail containment');
    expect(r.ledger).toContain('dep-advisory:tmp');
    expect(r.ledger).toContain('remainder re-verified green in 1 of at most');
    expect(r.ledger).not.toContain('round 1: dropped');
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
        return {
          outcome: 'pr-opened' as const,
          branch: 'dxkit/remediate-write-docs',
          mode: 'pr' as const,
          prUrl: 'x',
        };
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
        return {
          outcome: 'pr-opened' as const,
          branch: 'dxkit/remediate-write-docs',
          mode: 'pr' as const,
          prUrl: 'x',
        };
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
      roundEvidence: [],
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
        roundEvidence: [],
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
        return {
          outcome: 'pr-opened' as const,
          branch: 'dxkit/remediate-write-docs',
          mode: 'pr' as const,
          prUrl: 'x',
        };
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

describe("a containment refusal keeps every round's evidence (#373)", () => {
  const dep = (pkg: string) => ({
    kind: 'dep-vuln',
    description: `[dep-vuln] ${pkg}@1.0.0 - GHSA-test - added (no-prior-match)`,
    package: pkg,
  });
  const pinRecord = (pkg: string, commit: string) => ({
    orderId: `dep-advisory:${pkg}`,
    class: 'dep-advisory',
    recipe: 'override-pin',
    outcome: { kind: 'applied' as const, changedFiles: ['package.json'] },
    packages: [pkg],
    commit,
  });
  const lintRecord = (file: string, commit: string) => ({
    orderId: `lint-located:${file}`,
    class: 'lint-located',
    recipe: 'lint-autofix',
    outcome: { kind: 'applied' as const, changedFiles: [file] },
    commit,
  });
  const lintRed = (file: string, n = 1) => ({
    kind: 'custom-check',
    description: `[custom-check] lint - ${file}:${n} - added (no-prior-match)`,
    file,
  });

  it('a round-2 refusal keeps round 1: the units it dropped with evidence, and its re-verify verdict with the blocking set', async () => {
    // The live shape: a recipe pin group (head0..head1, names minimist) and
    // two agent dep orders (tmp: head1..head2; lodash: head2..head3). The
    // final guardrail is red on tmp AND lodash, so round 1 drops exactly
    // those two and re-verifies the group alone; the re-verify is red on
    // minimist, which attributes to the group, the ONLY unit left, so
    // round 2 refuses ("nothing would remain"). Before #373 the ledger
    // carried only that sentence.
    const git = fakeGit({
      'head0..head1': ['package.json', 'package-lock.json'],
      'head1..head2': ['package.json', 'package-lock.json'],
      'head2..head3': ['package.json', 'package-lock.json'],
    });
    const orders = [depOrder('tmp'), depOrder('lodash')];
    const r = await runWith({
      orders,
      git,
      guardrails: [red([dep('tmp'), dep('lodash')]), red([dep('minimist')])],
      recipePhase: () => {
        git.commit();
        return summary(orders, {
          ran: true,
          selectedRecipeTier: 1,
          records: [pinRecord('minimist', 'head1')],
        });
      },
    });
    expect(r.outcome).toBe('guardrail-red');
    // Round 1 unwound both agent orders (newest first), then the refusal
    // restored the pre-containment head.
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([
      ['head2', 'head3'],
      ['head1', 'head2'],
    ]);
    expect(git.resets).toEqual(['head3']);
    const c = r.containment!;
    expect(c.refused).toContain('nothing would remain to land');
    expect(c.refusedAtRound).toBe(2);
    expect(c.rounds).toBe(1);
    // Nothing is dropped from the landed tree (everything was restored)...
    expect(c.dropped).toEqual([]);
    // ...but round 1 survives on the outcome: what it dropped, on what
    // evidence, and what the re-verify said.
    expect(c.roundEvidence).toEqual([
      {
        round: 1,
        dropped: [
          {
            unit: 'agent-order',
            orderIds: ['dep-advisory:tmp'],
            round: 1,
            blocking: [dep('tmp').description],
            evidence: expect.stringContaining('names package tmp'),
          },
          {
            unit: 'agent-order',
            orderIds: ['dep-advisory:lodash'],
            round: 1,
            blocking: [dep('lodash').description],
            evidence: expect.stringContaining('names package lodash'),
          },
        ],
        reverify: {
          verdict: 'guardrail-red',
          guardrailVerdict: 'BLOCKED',
          blocking: [dep('minimist').description],
          moreBlocking: 0,
        },
      },
    ]);
    // The records stay as the phase recorded them (a refusal drops nothing).
    expect(r.orders?.records.every((x) => x.disposition?.kind === 'kept')).toBe(true);
    // The ledger: one block per round, then the refusal naming its round.
    const roundLine =
      '- round 1: dropped `dep-advisory:tmp`, `dep-advisory:lodash`; re-verify: guardrail-red ' +
      `(BLOCKED), blocking: ${dep('minimist').description}`;
    expect(r.ledger).toContain('### Guardrail containment');
    expect(r.ledger).toContain('but REFUSED after 1 executed round(s)');
    expect(r.ledger).toContain(roundLine);
    expect(r.ledger).toContain(
      '  - `dep-advisory:tmp` (agent-order): attribution: the order names package tmp',
    );
    expect(r.ledger).toContain(`; blocking: ${dep('tmp').description}`);
    expect(r.ledger).toContain('- refused in round 2: every kept order attributed to the red');
    // The PR body (the L4 summary renderer) carries the same block.
    const body = renderRemediatePrBody(r, { ledgerFile: null });
    expect(body).toContain(roundLine);
    expect(body).toContain('- refused in round 2: every kept order attributed to the red');
    // The JSON record carries the same containment record, rounds included.
    const json = taskRunJson({ result: r, landed: false, clean: false });
    expect(json.containment).toEqual(c);
    // The note still says containment was refused, as before.
    expect(r.note).toContain('Containment was attempted and refused');
  });

  it('a round-1 "unattributed" refusal carries zero rounds and names the finding it could not attribute', async () => {
    const git = fakeGit();
    const finding = {
      kind: 'secret',
      description: '[secret] docs/readme.md:1 - added (no-prior-match)',
      file: 'docs/readme.md',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/')],
      git,
      guardrails: [red([finding])],
    });
    expect(r.outcome).toBe('guardrail-red');
    const c = r.containment!;
    expect(c.rounds).toBe(0);
    expect(c.roundEvidence).toEqual([]);
    expect(c.refusedAtRound).toBe(1);
    expect(c.refused).toContain(finding.description);
    expect(r.ledger).toContain('but REFUSED after 0 executed round(s)');
    expect(r.ledger).toContain(`- refused in round 1: blocking finding ${finding.description}`);
    expect(r.ledger).not.toContain('round 1: dropped');
    expect(renderRemediatePrBody(r, { ledgerFile: null })).toContain(
      `- refused in round 1: blocking finding ${finding.description}`,
    );
  });

  it('a red that outlives the bound names the bound as the refusing round and keeps both rounds', async () => {
    const git = fakeGit({
      'head0..head1': ['src/a/f.ts'],
      'head1..head2': ['src/b/f.ts'],
      'head2..head3': ['src/c/f.ts'],
    });
    const r = await runWith({
      orders: [
        floorOrder('floor-failure:a', 'src/a/'),
        floorOrder('floor-failure:b', 'src/b/'),
        floorOrder('floor-failure:c', 'src/c/'),
      ],
      git,
      guardrails: [
        red([lintRed('src/c/f.ts')]),
        red([lintRed('src/b/f.ts')]),
        red([lintRed('src/a/f.ts')]),
      ],
    });
    const c = r.containment!;
    expect(c.refusedAtRound).toBe(MAX_CONTAINMENT_ROUNDS);
    expect(c.roundEvidence.map((x) => x.round)).toEqual([1, 2]);
    expect(c.roundEvidence.map((x) => x.dropped.flatMap((d) => d.orderIds))).toEqual([
      ['floor-failure:c'],
      ['floor-failure:b'],
    ]);
    expect(c.roundEvidence.map((x) => x.reverify.blocking)).toEqual([
      [lintRed('src/b/f.ts').description],
      [lintRed('src/a/f.ts').description],
    ]);
    expect(r.ledger).toContain('- round 2: dropped `floor-failure:b`; re-verify: guardrail-red');
    expect(r.ledger).toContain(
      `- refused in round ${MAX_CONTAINMENT_ROUNDS}: the guardrail stayed red`,
    );
  });

  it("a re-verify that no longer verifies is kept as the round's evidence with its failure named", async () => {
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['package.json', 'package-lock.json'],
    });
    const gates = [red([dep('tmp')])];
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
    const c = r.containment!;
    expect(c.refusedAtRound).toBe(1);
    expect(c.roundEvidence).toHaveLength(1);
    expect(c.roundEvidence[0].dropped.map((d) => d.orderIds)).toEqual([['dep-advisory:tmp']]);
    expect(c.roundEvidence[0].reverify.verdict).toBe('install-failed');
    expect(c.roundEvidence[0].reverify.blocking).toEqual([]);
    expect(r.ledger).toContain('- round 1: dropped `dep-advisory:tmp`; re-verify: install-failed');
    expect(r.ledger).toContain('- refused in round 1: the remainder no longer verifies');
  });

  it("the PR body counts a round's drops past the line threshold while the ledger names each; the re-verify blocking set is capped with the rest counted", async () => {
    // N+1 file-scoped lint orders (one commit each) plus one agent order.
    // Round 1 is red on N of the lint files (N > the PR-body threshold), so
    // N recipe-order units drop; the re-verify is red on the last lint
    // file and six times on the agent order's file, so round 2 attributes
    // every remaining unit and refuses.
    const n = PR_BODY_ORDER_LINE_THRESHOLD + 1;
    const files = Array.from({ length: n + 1 }, (_, i) => `src/f${i}.ts`);
    const ranges: Record<string, string[]> = {};
    files.forEach((f, i) => {
      ranges[`head${i}..head${i + 1}`] = [f];
    });
    ranges[`head${n + 1}..head${n + 2}`] = ['src/agent/x.ts'];
    const git = fakeGit(ranges);
    const agent = floorOrder('floor-failure:agent', 'src/agent/');
    const reverifyRed = [
      lintRed(files[n]),
      ...Array.from({ length: 6 }, (_, i) => lintRed('src/agent/x.ts', i + 1)),
    ];
    const r = await runWith({
      orders: [agent],
      git,
      guardrails: [red(files.slice(0, n).map((f) => lintRed(f))), red(reverifyRed)],
      recipePhase: () => {
        for (let i = 0; i < files.length; i++) git.commit();
        return summary([agent], {
          ran: true,
          selectedRecipeTier: files.length,
          records: files.map((f, i) => lintRecord(f, `head${i + 1}`)),
        });
      },
    });
    const c = r.containment!;
    expect(c.refusedAtRound).toBe(2);
    expect(c.roundEvidence).toHaveLength(1);
    expect(c.roundEvidence[0].dropped).toHaveLength(n);
    // The re-verify's blocking set is capped like a drop's evidence, the
    // rest counted, never silently truncated.
    expect(c.roundEvidence[0].reverify.blocking).toHaveLength(5);
    expect(c.roundEvidence[0].reverify.moreBlocking).toBe(reverifyRed.length - 5);
    expect(r.ledger).toContain('; and 2 more');
    // The committed ledger names every dropped unit with its evidence.
    for (const f of files.slice(0, n)) {
      expect(r.ledger).toContain(`  - \`lint-located:${f}\` (recipe-order): attribution:`);
    }
    // The PR body counts them (the L4 discipline) and points at the ledger.
    const body = renderRemediatePrBody(r, { ledgerFile: null });
    expect(body).toContain(`- round 1: dropped \`lint-located:${files[0]}\``);
    expect(body).toContain(
      `  - ${n} units dropped this round, each named with its attribution evidence in the committed ledger`,
    );
    expect(body).not.toContain('(recipe-order): attribution:');
    expect(body).toContain('Full ledger (every order, one line each)');
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

/**
 * Per-order containment units for file-scoped recipes (4.4.8, #376): a
 * recipe declares `containmentUnit`; the engine drops ONE commit of an
 * `order` recipe and keeps the rest of the tier, while `group` recipes
 * still drop as one unit. The record flip is one code path for both.
 */
describe('per-order containment units (4.4.8, #376)', () => {
  const lintRecord = (file: string, commit: string) => ({
    orderId: `lint-located:${file}`,
    class: 'lint-located',
    recipe: 'lint-autofix',
    outcome: { kind: 'applied' as const, changedFiles: [file] },
    commit,
  });
  const pinRecord = (pkg: string, commit?: string) => ({
    orderId: `dep-advisory:${pkg}`,
    class: 'dep-advisory',
    recipe: 'override-pin',
    outcome: { kind: 'applied' as const, changedFiles: ['package.json'] },
    packages: [pkg],
    ...(commit !== undefined ? { commit } : {}),
  });
  const lintRed = (file: string) => ({
    kind: 'custom-check',
    description: `[custom-check] lint · ${file}:3 - added (no-prior-match)`,
    file,
  });

  it('N file-scoped orders with a red in ONE file: that order drops, N-1 land, the group verification stays kept', async () => {
    // Three lint-autofix files, one commit each (head0..head3), then one
    // agent order (head3..head4). The final guardrail is red on src/b.ts.
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['src/b.ts'],
      'head2..head3': ['src/c.ts'],
      'head3..head4': ['src/agent.ts'],
    });
    const r = await runWith({
      orders: [floorOrder('floor-failure:agent', 'src/agent/')],
      git,
      guardrails: [red([lintRed('src/b.ts')]), GREEN],
      recipePhase: () => {
        git.commit();
        git.commit();
        git.commit();
        return summary([floorOrder('floor-failure:agent', 'src/agent/')], {
          ran: true,
          selectedRecipeTier: 3,
          records: [
            lintRecord('src/a.ts', 'head1'),
            lintRecord('src/b.ts', 'head2'),
            lintRecord('src/c.ts', 'head3'),
          ],
        });
      },
    });
    expect(r.outcome).toBe('partially-landed');
    // Exactly the red file's commit was reverted, at the tip.
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head1', 'head2']]);
    expect(r.containment?.dropped).toEqual([
      {
        unit: 'recipe-order',
        orderIds: ['lint-located:src/b.ts'],
        round: 1,
        blocking: [lintRed('src/b.ts').description],
        evidence: expect.stringContaining('committed diff touches src/b.ts'),
      },
    ]);
    const recs = r.recipes?.records ?? [];
    expect(recs.map((x) => [x.orderId, x.disposition?.kind])).toEqual([
      ['lint-located:src/a.ts', 'kept'],
      ['lint-located:src/b.ts', 'dropped'],
      ['lint-located:src/c.ts', 'kept'],
    ]);
    expect(recs[1].disposition).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('src/b.ts'),
    });
    // The group verification stays KEPT: two of three orders land.
    expect(r.recipes?.groupVerification).toEqual({ kind: 'kept', head: 'head3' });
    expect(r.orders?.records[0].disposition?.kind).toBe('kept');
    // The ledger counts it per recipe, and the group line says what was
    // dropped after the fact.
    expect(r.ledger).toContain('lint-autofix: dropped 1 of 3 applied order(s); 2 land');
    expect(r.ledger).toContain(
      '1 of its applied order(s) were later dropped by guardrail containment',
    );
    expect(r.ledger).toContain('(recipe-order, round 1)');
    // Breaker rows: the dropped order carries its own guardrail failure.
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows.map((row) => [row.orderId, row.outcome])).toEqual([
      ['lint-located:src/a.ts', 'verified'],
      ['lint-located:src/b.ts', 'guardrail-red'],
      ['lint-located:src/c.ts', 'verified'],
      ['floor-failure:agent', 'verified'],
    ]);
  });

  it('a recipe-only run (no agent orders) with a red in ONE file drops that order and lands N-1 as partially-landed', async () => {
    // The live shape: the agent tier never starts (a dead agent key, or
    // zero dispatched orders), so the recipe-only completion is the one
    // verification. Three lint-autofix files, one commit each; red on b.
    const git = fakeGit({
      'head0..head1': ['src/a.ts'],
      'head1..head2': ['src/b.ts'],
      'head2..head3': ['src/c.ts'],
    });
    const r = await runWith({
      orders: [],
      git,
      guardrails: [red([lintRed('src/b.ts')]), GREEN],
      recipePhase: () => {
        git.commit();
        git.commit();
        git.commit();
        return summary([], {
          ran: true,
          selectedRecipeTier: 3,
          records: [
            lintRecord('src/a.ts', 'head1'),
            lintRecord('src/b.ts', 'head2'),
            lintRecord('src/c.ts', 'head3'),
          ],
        });
      },
    });
    expect(r.outcome).toBe('partially-landed');
    expect(r.orders).toBeUndefined();
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head1', 'head2']]);
    expect(r.head).toBe('head4');
    expect(r.containment?.refused).toBeUndefined();
    expect(r.containment?.dropped).toEqual([
      expect.objectContaining({ unit: 'recipe-order', orderIds: ['lint-located:src/b.ts'] }),
    ]);
    expect((r.recipes?.records ?? []).map((x) => [x.orderId, x.disposition?.kind])).toEqual([
      ['lint-located:src/a.ts', 'kept'],
      ['lint-located:src/b.ts', 'dropped'],
      ['lint-located:src/c.ts', 'kept'],
    ]);
    // The tier was verified as one unit at its own head; two of three land.
    expect(r.recipes?.groupVerification).toEqual({ kind: 'kept', head: 'head3' });
    expect(r.note).toContain('$0 run');
    expect(r.note).toContain('lint-located:src/b.ts');
    expect(r.ledger).toContain('lint-autofix: dropped 1 of 3 applied order(s); 2 land');
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: { dxkitVersion: 'v', policyHash: 'h' },
    });
    expect(rows.map((row) => [row.orderId, row.outcome])).toEqual([
      ['lint-located:src/a.ts', 'verified'],
      ['lint-located:src/b.ts', 'guardrail-red'],
      ['lint-located:src/c.ts', 'verified'],
    ]);
  });

  it('a recipe-only run whose red cannot be attributed refuses, stays guardrail-red, and reverts nothing', async () => {
    const git = fakeGit({ 'head0..head1': ['src/a.ts'] });
    const finding = {
      kind: 'secret',
      description: '[secret] docs/readme.md:1 - added (no-prior-match)',
      file: 'docs/readme.md',
    };
    const r = await runWith({
      orders: [],
      git,
      guardrails: [red([finding])],
      recipePhase: () => {
        git.commit();
        return summary([], {
          ran: true,
          selectedRecipeTier: 1,
          records: [lintRecord('src/a.ts', 'head1')],
        });
      },
    });
    expect(r.outcome).toBe('guardrail-red');
    expect(git.reverts).toEqual([]);
    expect(r.containment?.refused).toContain("overlaps no kept order's envelope or committed");
    expect(r.note).toContain('Containment was attempted and refused');
    // A refused attempt leaves the tier's records as the phase recorded them.
    expect(r.recipes?.records[0].disposition).toBeUndefined();
  });

  it('an override-pin group with recorded per-order commits still drops as ONE unit on a red for one package', async () => {
    const git = fakeGit({
      'head0..head2': ['package.json', 'package-lock.json'],
      'head2..head3': ['src/a.ts'],
    });
    const finding = {
      kind: 'dep-vuln',
      description: '[dep-vuln] left-pad@1.0.0 · GHSA-test - added (no-prior-match)',
      package: 'left-pad',
    };
    const r = await runWith({
      orders: [floorOrder('floor-failure:a', 'src/')],
      git,
      guardrails: [red([finding]), GREEN],
      recipePhase: () => {
        git.commit();
        git.commit();
        return summary([floorOrder('floor-failure:a', 'src/')], {
          ran: true,
          selectedRecipeTier: 2,
          records: [pinRecord('left-pad', 'head1'), pinRecord('tmp', 'head2')],
        });
      },
    });
    expect(r.outcome).toBe('partially-landed');
    // One range for the whole group, both pins dropped, the group flipped.
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head0', 'head2']]);
    expect(r.containment?.dropped?.[0]).toEqual(
      expect.objectContaining({
        unit: 'recipe-group',
        orderIds: ['dep-advisory:left-pad', 'dep-advisory:tmp'],
      }),
    );
    expect(r.recipes?.groupVerification).toEqual({
      kind: 'dropped',
      step: 'guardrail',
      reason: expect.stringContaining('left-pad'),
      droppedOrderIds: ['dep-advisory:left-pad', 'dep-advisory:tmp'],
    });
    expect(r.recipes?.records.every((x) => x.disposition?.kind === 'dropped')).toBe(true);
    expect(r.ledger).toContain('override-pin: dropped 2 of 2 applied order(s); 0 land');
  });

  it('a mixed run (group recipe + order recipes + an agent order) chains from the base through every kept head', async () => {
    // head0..head1 pin (group), head1..head2 lint a, head2..head3 lint b,
    // head3..head4 agent. Red on lint b only.
    const git = fakeGit({
      'head0..head1': ['package.json', 'package-lock.json'],
      'head1..head2': ['src/a.ts'],
      'head2..head3': ['src/b.ts'],
      'head3..head4': ['src/agent.ts'],
    });
    const r = await runWith({
      orders: [floorOrder('floor-failure:agent', 'src/agent/')],
      git,
      guardrails: [red([lintRed('src/b.ts')]), GREEN],
      recipePhase: () => {
        git.commit();
        git.commit();
        git.commit();
        return summary([floorOrder('floor-failure:agent', 'src/agent/')], {
          ran: true,
          selectedRecipeTier: 3,
          records: [
            pinRecord('left-pad', 'head1'),
            lintRecord('src/a.ts', 'head2'),
            lintRecord('src/b.ts', 'head3'),
          ],
        });
      },
    });
    expect(r.outcome).toBe('partially-landed');
    expect(git.reverts.map((x) => [x.from, x.to])).toEqual([['head2', 'head3']]);
    expect((r.recipes?.records ?? []).map((x) => [x.orderId, x.disposition?.kind])).toEqual([
      ['dep-advisory:left-pad', 'kept'],
      ['lint-located:src/a.ts', 'kept'],
      ['lint-located:src/b.ts', 'dropped'],
    ]);
    expect(r.recipes?.groupVerification?.kind).toBe('kept');
    expect(r.orders?.records[0].disposition?.kind).toBe('kept');
  });

  describe('buildKeptUnits: the recipe tier as units (pure)', () => {
    const args = (records: RecipePhaseSummary['records'], head: string, git = fakeGit()) => ({
      git,
      baseHead: 'head0',
      agentBase: head,
      entryFloor: GREEN_FLOOR,
      runFloor: () => GREEN_FLOOR,
      recipes: summary([], { ran: true, records, groupVerification: { kind: 'kept', head } }),
      records: [],
      ordersById: new Map<string, WorkOrder>(),
      guardrail: GREEN,
      isManifestPath: () => false,
    });
    const shape = (units: KeptUnit[] | string) =>
      typeof units === 'string' ? units : units.map((u) => [u.unit, u.from, u.to, [...u.orderIds]]);

    it('one recipe-order unit per commit, sliced orders of one file sharing a commit share a unit', () => {
      const git = fakeGit();
      git.resetTo('head3');
      const res = buildKeptUnits(
        args(
          [
            lintRecord('src/a.ts', 'head1'),
            { ...lintRecord('src/big.ts', 'head2'), orderId: 'lint-located:src/big.ts#1' },
            { ...lintRecord('src/big.ts', 'head2'), orderId: 'lint-located:src/big.ts#2' },
            lintRecord('src/c.ts', 'head3'),
          ],
          'head3',
          git,
        ),
      );
      expect(shape(res)).toEqual([
        ['recipe-order', 'head0', 'head1', ['lint-located:src/a.ts']],
        [
          'recipe-order',
          'head1',
          'head2',
          ['lint-located:src/big.ts#1', 'lint-located:src/big.ts#2'],
        ],
        ['recipe-order', 'head2', 'head3', ['lint-located:src/c.ts']],
      ]);
    });

    it('group recipes fold into ONE unit up to their last commit; an order commit interleaved inside that range is absorbed, never split out', () => {
      const git = fakeGit();
      git.resetTo('head3');
      const res = buildKeptUnits(
        args(
          [
            lintRecord('src/a.ts', 'head1'),
            pinRecord('left-pad', 'head2'),
            lintRecord('src/c.ts', 'head3'),
          ],
          'head3',
          git,
        ),
      );
      expect(shape(res)).toEqual([
        ['recipe-group', 'head0', 'head2', ['lint-located:src/a.ts', 'dep-advisory:left-pad']],
        ['recipe-order', 'head2', 'head3', ['lint-located:src/c.ts']],
      ]);
    });

    it('an applied record with no recorded commit keeps the whole tier as the single group unit (the pre-4.4.8 shape)', () => {
      const git = fakeGit();
      git.resetTo('head2');
      const res = buildKeptUnits(
        args([lintRecord('src/a.ts', 'head1'), pinRecord('left-pad')], 'head2', git),
      );
      expect(shape(res)).toEqual([
        ['recipe-group', 'head0', 'head2', ['lint-located:src/a.ts', 'dep-advisory:left-pad']],
      ]);
    });

    it('a recipe chain that does not end at the verified group head refuses (never a range on a guess)', () => {
      const git = fakeGit();
      git.resetTo('head3');
      const res = buildKeptUnits(args([lintRecord('src/a.ts', 'head1')], 'head3', git));
      expect(typeof res).toBe('string');
      expect(res).toContain('per-order recipe ranges cannot be trusted');
    });

    it('reads the containment unit from the registry it is handed (a synthetic order-unit recipe splits per commit)', () => {
      const git = fakeGit();
      git.resetTo('head2');
      const records = [
        { ...lintRecord('src/a.ts', 'head1'), recipe: 'synthetic-fixer' },
        { ...lintRecord('src/b.ts', 'head2'), recipe: 'synthetic-fixer' },
      ];
      // Unknown to the built-in registry: the conservative group unit.
      expect(shape(buildKeptUnits(args(records, 'head2', git)))).toEqual([
        ['recipe-group', 'head0', 'head2', ['lint-located:src/a.ts', 'lint-located:src/b.ts']],
      ]);
      const registry = [
        {
          id: 'synthetic-fixer',
          class: 'lint-located' as const,
          containmentUnit: 'order' as const,
          summary: 't',
          implemented: false,
          matches: () => true,
        },
      ];
      expect(shape(buildKeptUnits({ ...args(records, 'head2', git), registry }))).toEqual([
        ['recipe-order', 'head0', 'head1', ['lint-located:src/a.ts']],
        ['recipe-order', 'head1', 'head2', ['lint-located:src/b.ts']],
      ]);
    });
  });
});
