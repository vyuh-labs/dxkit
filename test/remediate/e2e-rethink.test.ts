/**
 * END-TO-END PROOF of the remediate rethink (4.4.5) — the permanent "prove
 * the value" gate, not a one-off. Each scenario stages a small fixture repo
 * (a real git repo with a committed baseline, allowlist, and policy) and
 * drives the ONE public entry point `runRemediateTask` through the REAL
 * planner, recipe phase, order dispatch, envelope enforcement, and ledger,
 * with only the spawnable edges injected (exec, driver, floor, guardrail,
 * verification worktree). No network, no real package manager, no real agent.
 *
 * The three claims this pins, per the release's own acceptance list:
 *   a. a recipe-only plan (stale lockfile; deferred advisory with a fixed
 *      version) lands VERIFIED with ZERO driver invocations, the ledger
 *      carrying per-order applied outcomes ($0 by construction — the driver
 *      here throws on contact);
 *   b. an agent-tier order reaches the driver as the RENDERED ORDER (the
 *      attribution split, the envelope, the done command are in the prompt)
 *      under a budget DERIVED from the finding set (lower than the legacy
 *      default), and an out-of-envelope edit the agent makes is DROPPED
 *      WITH DISCLOSURE while the in-envelope fix lands;
 *   c. two consecutive failed firings for a class PAUSE it (the next run
 *      spends $0 and names the unpause conditions); an explicit dispatch
 *      overrides the pause and the work lands.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runRemediateTask } from '../../src/remediate/run';
import type { RemediateResult, RemediateRunOptions } from '../../src/remediate/run';
import { realGit } from '../../src/remediate/git-ops';
import { realRecipeGit } from '../../src/remediate/recipes/git';
import {
  runRecipePhaseForTask,
  type RecipePhaseOptions,
} from '../../src/remediate/recipes/run-recipes';
import { resolveRemediateConfig, DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import { LOCKFILE_SYNC_LABEL } from '../../src/languages/capabilities/correctness';
import { getLanguage } from '../../src/languages';
import type { DepVulnFinding } from '../../src/languages/capabilities/types';
import type { OrderOutcomeRow } from '../../src/lanes/order-ledger';
import type { GatherWorkOrderOptions } from '../../src/remediate/work-orders/gather';
import { trustedLocalContext } from '../../src/analysis-trust';
import type { CommandOutcome, RunnableCommand } from '../../src/analyzers/tools/bounded-exec';

const TS_PACKS = [getLanguage('typescript')!];
const NOW = new Date('2026-08-25T00:00:00Z');
const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, blocks: false, checks: [] };

// ---------------------------------------------------------------------------
// Fixture estate
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real committed git repo staged from a file map. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-e2e-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture base']);
  return dir;
}

function baselineJson(floorDebt?: object): string {
  return JSON.stringify({
    schemaVersion: 'dxkit-baseline/v1',
    name: 'main',
    createdAt: '2026-08-01T00:00:00.000Z',
    repo: { commitSha: 'base', branch: 'main', dirty: false },
    analysis: { dxkitVersion: 'test', toolchainHash: 'x' },
    tools: {},
    saltMode: 'none',
    findings: [],
    ...(floorDebt ? { floorDebt } : {}),
  });
}

const DEFERRED_ALLOWLIST = JSON.stringify({
  schemaVersion: 'dxkit-allowlist/v1',
  mode: 'full',
  identityScheme: 'v3',
  entries: [
    {
      fingerprint: 'dead000011112222',
      kind: 'dep-vuln',
      category: 'deferred',
      reason: 'lane will fix',
      addedBy: 't',
      addedAt: '2026-08-01',
      expiresAt: '2026-09-15',
    },
  ],
});

/** The deferred advisory as a dependency scan reports it. With a concrete
 *  fixed version the order tiers `recipe` (override-pin); without one it
 *  tiers `agent`. */
function scanFinding(fixedVersion?: string): DepVulnFinding {
  return {
    id: 'GHSA-1',
    package: 'js-yaml',
    installedVersion: '3.13.0',
    tool: 'osv-scanner',
    packId: 'typescript',
    severity: 'high',
    reachable: true,
    fingerprint: 'dead000011112222',
    ...(fixedVersion !== undefined ? { fixedVersion } : {}),
  };
}

function policyJson(extra: object = {}): string {
  return JSON.stringify({
    remediate: {
      enabled: true,
      tasks: ['fix-vulns', 'fix-build'],
      agent: { driver: 'fake-agent' },
      ...extra,
    },
  });
}

/** Base fixture: a node repo (package.json + lockfile), remediate enabled,
 *  a committed baseline and a deferred dep-vuln allowlist entry. */
function estate(extraFiles: Record<string, string> = {}, policyExtra: object = {}): string {
  return fixtureRepo({
    'package.json': JSON.stringify(
      { name: 'fixture', version: '1.0.0', dependencies: { 'left-pad': '^1.0.0' } },
      null,
      2,
    ),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'src/index.ts': 'export const answer = 42;\n',
    '.dxkit/policy.json': policyJson(policyExtra),
    '.dxkit/baselines/main.json': baselineJson(),
    '.dxkit/allowlist.json': DEFERRED_ALLOWLIST,
    ...extraFiles,
  });
}

// ---------------------------------------------------------------------------
// Injected edges (everything spawnable)
// ---------------------------------------------------------------------------

/** A recording fake exec for the recipe tier: every package-manager install
 *  "writes" the lockfile (so the recipe's diff is real and committable);
 *  everything else succeeds cleanly. */
function recipesExec(cwd: string): {
  exec: (cmd: RunnableCommand, execCwd: string) => CommandOutcome;
  calls: RunnableCommand[];
} {
  const calls: RunnableCommand[] = [];
  return {
    calls,
    exec: (cmd, execCwd) => {
      calls.push(cmd);
      if (cmd.bin === 'npm' && cmd.args.some((a) => a === 'install' || a === 'ci')) {
        fs.appendFileSync(path.join(execCwd ?? cwd, 'package-lock.json'), '\n');
      }
      return { available: true, code: 0, output: '' };
    },
  };
}

/** A driver that records every run and, unless given work to do, throws on
 *  contact — the $0 proof for recipe-only and paused plans. */
function driverStub(work?: (opts: Parameters<AgentDriver['run']>[0]) => Partial<AgentRunResult>): {
  driver: AgentDriver;
  runs: Parameters<AgentDriver['run']>[0][];
} {
  const runs: Parameters<AgentDriver['run']>[0][] = [];
  const driver: AgentDriver = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async (opts) => {
      runs.push(opts);
      if (!work) throw new Error('the driver must never be invoked on this run ($0 contract)');
      return { completed: true, timedOut: false, transcriptTail: '', ...work(opts) };
    },
  };
  return { driver, runs };
}

interface EstateRun {
  readonly repo: string;
  readonly taskId: string;
  readonly driver: AgentDriver;
  readonly entryFloor?: CorrectnessFloorResult;
  readonly scan?: DepVulnFinding[];
  readonly gather?: Partial<GatherWorkOrderOptions>;
  readonly explicitDispatch?: boolean;
  readonly exec?: ReturnType<typeof recipesExec>;
}

/** Drive `runRemediateTask` through the REAL recipe phase (real planner,
 *  real recipes, real git) with the spawnable edges injected. */
async function runOnEstate(o: EstateRun): Promise<RemediateResult> {
  const entry = o.entryFloor ?? GREEN_FLOOR;
  let floorCalls = 0;
  const runFloor = () => {
    floorCalls += 1;
    // First call is the entry snapshot on the pristine tree; verification
    // floors run after the fix landed, so they read green.
    return floorCalls === 1 ? entry : GREEN_FLOOR;
  };
  const exec = o.exec ?? recipesExec(o.repo);
  const opts: RemediateRunOptions = {
    cwd: o.repo,
    trust: trustedLocalContext(),
    taskId: o.taskId,
    config: resolveRemediateConfig(o.repo),
    drivers: [o.driver],
    git: realGit(o.repo),
    runFloor,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    verifySeams: {
      worktree: async (_o, fn) => fn(o.repo),
      install: () => ({ status: 'nothing-to-install' }) as const,
      changedFiles: () => ['package.json'],
    },
    armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
    ...(o.explicitDispatch ? { explicitDispatch: true } : {}),
    runRecipePhase: (phase: RecipePhaseOptions) =>
      runRecipePhaseForTask({
        ...phase,
        git: realRecipeGit(o.repo),
        exec: exec.exec,
        queryOsv: async () => [],
        auditDepVulns: async () => [],
        gather: {
          packs: TS_PACKS,
          scanDepVulns: async () => o.scan ?? [],
          now: NOW,
          ...o.gather,
          // The frame's own gather flags (the dispatch override) win.
          ...phase.gather,
        },
      }),
  };
  return runRemediateTask(opts);
}

// ---------------------------------------------------------------------------
// a. Recipe-only plans land verified with ZERO driver invocations
// ---------------------------------------------------------------------------

describe('e2e a: a recipe-only plan lands verified at $0', () => {
  it('deferred advisory with a fixed version: override-pin applies, commits, verifies; the driver is never touched', async () => {
    const repo = estate();
    const { driver, runs } = driverStub(); // throws on contact
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding('4.1.0')],
    });

    expect(runs).toHaveLength(0);
    expect(r.outcome).toBe('verified');
    // The ledger shows the per-order applied outcome.
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['dep-advisory:js-yaml', 'applied'],
    ]);
    expect(r.ledger).toContain('dep-advisory:js-yaml');
    expect(r.ledger).toContain('applied');
    // No agent envelope: nothing was spent.
    expect(r.envelope).toBeUndefined();
    // The fix is REAL: the override landed in a commit made by the recipe.
    const manifest = JSON.parse(git(repo, ['show', 'HEAD:package.json'])) as Record<
      string,
      Record<string, string>
    >;
    expect(manifest.overrides?.['js-yaml']).toBe('4.1.0');
    expect(git(repo, ['log', '--oneline'])).toContain('override-pin recipe');
  });

  it('stale lockfile: lockfile-sync resyncs with the repo pm, verifies with the frozen dry-run, commits; zero driver invocations', async () => {
    const repo = estate();
    const { driver, runs } = driverStub();
    const staleEntry: CorrectnessFloorResult = {
      ran: true,
      blocks: true,
      checks: [
        {
          pack: 'typescript',
          label: LOCKFILE_SYNC_LABEL,
          bin: 'npm',
          args: ['ci', '--dry-run'],
          status: 'fail',
          output: 'npm error Missing: js-yaml@4.1.0 from lock file',
        },
      ],
    };
    const exec = recipesExec(repo);
    const r = await runOnEstate({
      repo,
      taskId: 'fix-build',
      driver,
      entryFloor: staleEntry,
      exec,
    });

    expect(runs).toHaveLength(0);
    expect(r.outcome).toBe('verified');
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['stale-lockfile:typescript', 'applied'],
    ]);
    // The resync actually ran through the injected exec and the lockfile
    // change was committed by the recipe.
    expect(exec.calls.some((c) => c.bin === 'npm')).toBe(true);
    expect(git(repo, ['log', '--oneline'])).toContain('lockfile-sync recipe');
    expect(r.ledger).toContain('stale-lockfile:typescript');
  });
});

// ---------------------------------------------------------------------------
// b. The scoped agent: rendered order, derived budget, enforced envelope
// ---------------------------------------------------------------------------

describe('e2e b: an agent-tier order is dispatched scoped and enforced', () => {
  it('the driver gets the rendered order (attribution split, envelope, done command) under a derived budget; out-of-envelope edits are dropped with disclosure, the in-envelope fix lands', async () => {
    const repo = estate();
    // No fixed version: override-pin cannot serve it, so the order tiers
    // agent and reaches the driver.
    const { driver, runs } = driverStub((opts) => {
      // The "agent" fixes the manifest (inside the envelope) and also
      // sprawls outside it; the sweep commits both, enforcement drops one.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(opts.cwd, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      manifest.overrides = { 'js-yaml': '4.1.0' };
      fs.writeFileSync(path.join(opts.cwd, 'package.json'), JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(opts.cwd, 'src/sprawl.ts'), 'export const oops = 1;\n');
      return { turns: 3, costUsd: 0.2 };
    });
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding()],
    });

    expect(runs).toHaveLength(1);
    const prompt = runs[0].prompt;
    // The rendered work order, not the legacy open-ended task prompt.
    expect(prompt).toContain('Work order dep-advisory:js-yaml');
    // The attribution split.
    expect(prompt).toContain('Attribution:');
    expect(prompt).toContain('deferred findings that re-block on their expiry date');
    expect(prompt).toContain('Everything else in the repo is grandfathered');
    // The envelope.
    expect(prompt).toContain('Envelope (the only paths you may change):');
    expect(prompt).toContain('package.json');
    // The done command.
    expect(prompt).toContain('Done when: every id above is absent');
    expect(prompt).toContain('Check with:');
    // The budget is DERIVED from the finding set: one finding derives far
    // below the legacy default cap, and the derivation is disclosed.
    expect(runs[0].budget.maxTurns).toBeLessThan(DEFAULT_REMEDIATE_BUDGET.maxTurns);
    expect(r.orders?.records[0]?.budget.derivation).toContain('turns');

    // Envelope enforcement: the sprawl was dropped WITH disclosure, the
    // in-envelope fix survived to the verified head.
    expect(r.outcome).toBe('verified');
    expect(r.orders?.records[0]?.droppedPaths).toContain('src/sprawl.ts');
    expect(r.ledger).toContain('src/sprawl.ts');
    const headFiles = git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(headFiles).not.toContain('src/sprawl.ts');
    const manifest = JSON.parse(git(repo, ['show', 'HEAD:package.json'])) as Record<
      string,
      Record<string, string>
    >;
    expect(manifest.overrides?.['js-yaml']).toBe('4.1.0');
  });
});

// ---------------------------------------------------------------------------
// c. The circuit breaker: pause after failures, unpause on explicit dispatch
// ---------------------------------------------------------------------------

const STAMP = { dxkitVersion: 'stamp-v', policyHash: 'stamp-h' };

function failedRow(timestamp: string): OrderOutcomeRow {
  return {
    schema_version: 1,
    timestamp,
    lane: 'remediate',
    task: 'fix-vulns',
    orderId: 'dep-advisory:js-yaml',
    class: 'dep-advisory',
    tier: 'recipe',
    outcome: 'guardrail-red',
    ...STAMP,
  };
}

describe('e2e c: the circuit breaker pauses a failing class and an explicit dispatch unpauses it', () => {
  const history = [failedRow('2026-08-11T00:00:00Z'), failedRow('2026-08-18T00:00:00Z')];

  it('two consecutive failed firings pause the class: the next run spends $0, marks the orders paused, and names the unpause conditions', async () => {
    const repo = estate();
    const { driver, runs } = driverStub(); // throws on contact
    const exec = recipesExec(repo);
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding('4.1.0')],
      exec,
      gather: { history, stamp: STAMP },
    });

    expect(runs).toHaveLength(0);
    expect(exec.calls).toHaveLength(0); // no recipe spawned either
    expect(r.outcome).toBe('no-op');
    expect(r.note).toContain('PAUSED');
    expect(r.note).toContain('dep-advisory');
    // The plan marks the orders paused with the unpause conditions.
    const paused = r.recipes?.paused ?? [];
    expect(paused.map((p) => [p.orderId, p.class])).toEqual([
      ['dep-advisory:js-yaml', 'dep-advisory'],
    ]);
    expect(paused[0].reason).toContain('failures');
    expect(paused[0].unpause).toContain('policy changes');
    expect(paused[0].unpause).toContain('--dispatch-override');
    expect(r.ledger).toContain('PAUSED');
  });

  it('an explicit dispatch overrides the pause (disclosed) and the recipe lands the fix', async () => {
    const repo = estate();
    const { driver, runs } = driverStub();
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding('4.1.0')],
      gather: { history, stamp: STAMP },
      explicitDispatch: true,
    });

    expect(runs).toHaveLength(0); // still recipe-tier: $0
    expect(r.outcome).toBe('verified');
    expect(r.recipes?.paused ?? []).toHaveLength(0);
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['dep-advisory:js-yaml', 'applied'],
    ]);
    // The override is disclosed, never silent.
    expect((r.recipes?.disclosures ?? []).join('\n')).toContain('dispatched explicitly');
  });
});
