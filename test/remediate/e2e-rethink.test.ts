/**
 * END-TO-END PROOF of the remediate rethink (4.4.5): the permanent "prove
 * the value" gate, not a one-off. Each scenario stages a small fixture repo
 * (a real git repo with a committed baseline, allowlist, and policy) and
 * drives the ONE public entry point `runRemediateTask` through the REAL
 * planner, recipe phase, order dispatch, envelope enforcement, git
 * operations, and ledger. Stubbed (named precisely, they are more than the
 * spawnable edges): the recipe/floor command exec, the agent driver, the
 * entry floor and the verification floor/guardrail results, the
 * verification worktree + install seams, and every standing-branch network
 * read (order history defaults to an empty injected list; the real-ledger
 * scenario reads the JSONL the runs themselves wrote, with only the remote
 * probe offline). No network, no real package manager, no real agent.
 *
 * The claims this pins, per the release's own acceptance list:
 *   a. a recipe-only plan (stale lockfile; deferred advisory with a fixed
 *      version) lands VERIFIED with ZERO driver invocations, the ledger
 *      carrying per-order applied outcomes ($0 by construction: the driver
 *      here throws on contact);
 *   b. an agent-tier order reaches the driver as the RENDERED ORDER (the
 *      attribution split, the envelope, the done command are in the prompt)
 *      under the exact budget the derivation formula gives its finding set
 *      (lower than the legacy default), and an out-of-envelope edit the
 *      agent makes is DROPPED WITH DISCLOSURE while the in-envelope fix
 *      lands;
 *   c. two consecutive failed firings for a class PAUSE it (the next run
 *      spends $0 and names the unpause conditions); an explicit dispatch
 *      overrides the pause and the work lands. Proven twice: once with
 *      injected history rows (fast), and once through the real persistence
 *      seam, where two failing runs write real JSONL ledger rows (the
 *      order-outcomes path the executor uses) and the third run's breaker
 *      reads them back with matching environment stamps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
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
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import { LOCKFILE_SYNC_LABEL } from '../../src/languages/capabilities/correctness';
import { getLanguage } from '../../src/languages';
import type { DepVulnFinding } from '../../src/languages/capabilities/types';
import {
  ORDER_LEDGER_SCHEMA_VERSION,
  orderLedgerPath,
  parseOrderRows,
  type OrderLedgerExec,
  type OrderOutcomeRow,
} from '../../src/lanes/order-ledger';
import { orderOutcomeRows, writeLocalOrderLedger } from '../../src/remediate/order-outcomes';
import { remediateStamp } from '../../src/remediate/work-orders/breaker';
import { BUDGET_DERIVATION } from '../../src/remediate/work-orders/shared';
import type { GatherWorkOrderOptions } from '../../src/remediate/work-orders/gather';
import { trustedLocalContext } from '../../src/analysis-trust';
import { GREEN_FLOOR, stubDriver } from './helpers';
import { fakeExec, tempRepo, type ExecScript } from './recipes/helpers';

const TS_PACKS = [getLanguage('typescript')!];
const NOW = new Date('2026-08-25T00:00:00Z');

// ---------------------------------------------------------------------------
// Fixture estate
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterEach(() => {
  // Per-dir try/catch: one EBUSY must not leak every other fixture.
  for (const dir of cleanups.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the OS temp reaper owns the stragglers
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real committed git repo staged from a file map (`tempRepo` + git).
 *  Signing is disabled repo-locally so a global `commit.gpgsign true`
 *  cannot break the fixture commits, including the ones `realRecipeGit`
 *  and `realGit` make during the run. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = tempRepo(files);
  cleanups.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgsign', 'false']);
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
// Injected edges
// ---------------------------------------------------------------------------

/** The recipe tier's exec, on the shared recording fake: every
 *  package-manager install "writes" the lockfile (so the recipe's diff is
 *  real and committable); everything else succeeds cleanly. */
function lockWritingExec(repo: string): ReturnType<typeof fakeExec> {
  return fakeExec((cmd, execCwd) => {
    if (cmd.bin === 'npm' && cmd.args.some((a) => a === 'install' || a === 'ci')) {
      fs.appendFileSync(path.join(execCwd ?? repo, 'package-lock.json'), '\n');
    }
  });
}

/** An offline ledger exec: every git spawn (ls-remote, fetch) fails, so
 *  branch reads fall open to "local file only" with a disclosure. */
const offlineLedgerExec: OrderLedgerExec = () => {
  throw new Error('offline: this fixture has no remote');
};

interface EstateRun {
  readonly repo: string;
  readonly taskId: string;
  readonly driver: ReturnType<typeof stubDriver>['driver'];
  readonly entryFloor?: CorrectnessFloorResult;
  readonly scan?: DepVulnFinding[];
  readonly gather?: Partial<GatherWorkOrderOptions>;
  readonly explicitDispatch?: boolean;
  readonly exec?: ReturnType<typeof fakeExec>;
}

/** Drive `runRemediateTask` through the REAL recipe phase (real planner,
 *  real recipes, real git) with the edges above injected. The entry floor
 *  arrives through the runner's declared `entryFloor` seam; the floor runs
 *  the verification pays are stubbed green. Order history defaults to an
 *  injected empty list so no test spawns `git ls-remote` by accident; the
 *  real-ledger scenario overrides it deliberately. */
async function runOnEstate(o: EstateRun): Promise<RemediateResult> {
  const exec = o.exec ?? lockWritingExec(o.repo);
  const opts: RemediateRunOptions = {
    cwd: o.repo,
    trust: trustedLocalContext(),
    taskId: o.taskId,
    config: resolveRemediateConfig(o.repo),
    drivers: [o.driver],
    git: realGit(o.repo),
    entryFloor: o.entryFloor ?? GREEN_FLOOR,
    runFloor: () => GREEN_FLOOR,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    verifySeams: {
      worktree: async (_o, fn) => fn(o.repo),
      install: () => ({ status: 'no-provision-declared', packs: [] }) as const,
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
          history: [],
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
    const { driver, runs } = stubDriver(); // throws on contact
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
    const { driver, runs } = stubDriver();
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
    const exec = lockWritingExec(repo);
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
    expect(exec.calls.some((c) => c.cmd.bin === 'npm')).toBe(true);
    expect(git(repo, ['log', '--oneline'])).toContain('lockfile-sync recipe');
    expect(r.ledger).toContain('stale-lockfile:typescript');
  });
});

// ---------------------------------------------------------------------------
// b. The scoped agent: rendered order, derived budget, enforced envelope
// ---------------------------------------------------------------------------

describe('e2e b: an agent-tier order is dispatched scoped and enforced', () => {
  it('the driver gets the rendered order (attribution split, envelope, done command) under the derived budget; out-of-envelope edits are dropped with disclosure, the in-envelope fix lands', async () => {
    const repo = estate();
    // No fixed version: override-pin cannot serve it, so the order tiers
    // agent and reaches the driver.
    const { driver, runs } = stubDriver((opts) => {
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
    // The budget IS the derivation formula's answer for ONE finding, so a
    // regression back to a flat cap fails here; it also sits far below the
    // legacy default, and the derivation is disclosed.
    const derivedForOneFinding = BUDGET_DERIVATION.baseTurns + BUDGET_DERIVATION.perFindingTurns;
    expect(runs[0].budget.maxTurns).toBe(derivedForOneFinding);
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
    schema_version: ORDER_LEDGER_SCHEMA_VERSION,
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
    const { driver, runs } = stubDriver(); // throws on contact
    const exec = lockWritingExec(repo);
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
    const { driver, runs } = stubDriver();
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

  it('the real persistence seam: two failing runs write JSONL ledger rows, and the third run reads them back and pauses', async () => {
    // In-run agent dispatch off so a failed recipe order dead-ends the run
    // (recipes-refused) instead of reaching the driver: the failing firing
    // stays $0 and the driver stub can keep throwing on contact.
    const repo = estate({}, { maxOrdersPerRun: 0 });
    const failingExec: ExecScript = (cmd) =>
      cmd.bin === 'npm' ? { code: 1, output: 'npm error install exploded' } : undefined;
    const stamp = remediateStamp(repo);

    // Two failing firings, each recorded the way the executor records them
    // (the order-outcomes projection + the landing-path ledger write, with
    // only the remote probe offline).
    for (const timestamp of ['2026-08-18T00:00:00.000Z', '2026-08-19T00:00:00.000Z']) {
      const { driver } = stubDriver();
      const r = await runOnEstate({
        repo,
        taskId: 'fix-vulns',
        driver,
        scan: [scanFinding('4.1.0')],
        exec: fakeExec(failingExec),
      });
      expect(r.outcome).toBe('recipes-refused');
      const rows = orderOutcomeRows(r, 'fix-vulns', { timestamp, stamp });
      expect(rows.map((row) => row.outcome)).toEqual(['failed-recipe']);
      expect(writeLocalOrderLedger(repo, 'fix-vulns', rows, offlineLedgerExec)).toBe(
        orderLedgerPath('remediate', 'fix-vulns'),
      );
    }

    // The JSONL file the runs wrote exists and carries the environment
    // stamps the breaker compares against.
    const ledgerAbs = path.join(repo, orderLedgerPath('remediate', 'fix-vulns'));
    expect(fs.existsSync(ledgerAbs)).toBe(true);
    const persisted = parseOrderRows(fs.readFileSync(ledgerAbs, 'utf8'));
    expect(persisted).toHaveLength(2);
    for (const row of persisted) {
      expect(row.schema_version).toBe(ORDER_LEDGER_SCHEMA_VERSION);
      expect(row.outcome).toBe('failed-recipe');
      expect(row.dxkitVersion).toBe(stamp.dxkitVersion);
      expect(row.policyHash).toBe(stamp.policyHash);
    }

    // Third run: NO injected history, so the breaker's default read walks
    // the real path (the local JSONL plus the standing-branch probe, which
    // is offline here and discloses itself) and pauses the class.
    const { driver, runs } = stubDriver();
    const exec = fakeExec(failingExec);
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding('4.1.0')],
      exec,
      gather: { history: undefined, historyExec: offlineLedgerExec },
    });
    expect(runs).toHaveLength(0);
    expect(exec.calls).toHaveLength(0);
    expect(r.outcome).toBe('no-op');
    expect(r.note).toContain('PAUSED');
    expect((r.recipes?.paused ?? []).map((p) => p.class)).toEqual(['dep-advisory']);
    // The offline standing-branch probe is a disclosure, never an error.
    expect((r.recipes?.disclosures ?? []).join('\n')).toContain('no remote reachable');
  });
});
