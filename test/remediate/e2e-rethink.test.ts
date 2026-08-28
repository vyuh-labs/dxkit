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
 *      reads them back with matching environment stamps;
 *   d. the LIVE SHAPE (4.4.6): a recipe pin applies, then an agent order
 *      edits the manifest AND hand-edits the lockfile. The frame's
 *      invariant step replaces the hand edit with the pack's own resync
 *      (the order lands, the lockfile is the tool's truth), or, when the
 *      resync cannot re-establish the tree, drops THAT order with the
 *      reason while the pin still lands (`partially-landed`, the rows
 *      naming the dropped order's step).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';

// The recipes' Rule 20 gate probes the REAL machine (`currentEnvironment`
// is not an injected seam), and the go scenario must land on hosts without
// a Go toolchain (every spawn here is faked anyway). The mock reports every
// toolchain present and healthy; the gate's own both-direction behavior is
// pinned by the execution-platform and recipe-playbook tests.
vi.mock('../../src/execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/execution')>();
  return {
    ...actual,
    currentEnvironment: () => ({
      host: 'linux' as const,
      hasToolchain: () => true,
      toolchainProblem: () => null,
    }),
  };
});
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
  /** The active packs (defaults to the node estate's typescript pack). */
  readonly packs?: typeof TS_PACKS;
  readonly driver: ReturnType<typeof stubDriver>['driver'];
  readonly entryFloor?: CorrectnessFloorResult;
  readonly scan?: DepVulnFinding[];
  readonly gather?: Partial<GatherWorkOrderOptions>;
  readonly explicitDispatch?: boolean;
  readonly exec?: ReturnType<typeof fakeExec>;
  /** The exec the frame's invariant step uses after an AGENT order
   *  (defaults to the same fake as the recipe tier). */
  readonly frameExec?: ReturnType<typeof fakeExec>;
}

/** Drive `runRemediateTask` through the REAL recipe phase (real planner,
 *  real recipes, real git) with the edges above injected. The entry floor
 *  arrives through the runner's declared `entryFloor` seam; the floor runs
 *  the verification pays are stubbed green. Order history defaults to an
 *  injected empty list so no test spawns `git ls-remote` by accident; the
 *  real-ledger scenario overrides it deliberately. */
async function runOnEstate(o: EstateRun): Promise<RemediateResult> {
  const exec = o.exec ?? lockWritingExec(o.repo);
  const packs = o.packs ?? TS_PACKS;
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
    // The frame's invariant step runs the REAL collector over the real
    // node pack on the estate; only the package manager is faked.
    frameInvariants: { packs, exec: (o.frameExec ?? exec).exec },
    runRecipePhase: (phase: RecipePhaseOptions) =>
      runRecipePhaseForTask({
        ...phase,
        git: realRecipeGit(o.repo),
        exec: exec.exec,
        queryOsv: async () => [],
        auditDepVulns: async () => [],
        gather: {
          packs,
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
// a2. The recipe tier is language-parametric (4.4.7 V2): the same recipe-only
//     $0 landing on a NON-JS repo, the matrix discipline (a fix that only
//     works for one stack fails here). The driver still throws on contact.
// ---------------------------------------------------------------------------

const PY_PACKS = [getLanguage('python')!];

const PY_PYPROJECT = `[project]
name = "fixture"
version = "1.0.0"
dependencies = [
    "requests>=2.31",
]
`;

/** A python (uv) estate: pyproject + uv.lock, remediate enabled, the same
 *  committed baseline + deferred allowlist shape as the node estate. */
function pyEstate(): string {
  return fixtureRepo({
    'pyproject.toml': PY_PYPROJECT,
    'uv.lock': 'version = 1\n',
    'app.py': 'print("hello")\n',
    '.dxkit/policy.json': policyJson(),
    '.dxkit/baselines/main.json': baselineJson(),
    '.dxkit/allowlist.json': DEFERRED_ALLOWLIST,
  });
}

/** The python estate's exec fake: `uv sync` (the pack's declared resync)
 *  rewrites the lockfile; `uv lock --check` (the declared sync check)
 *  passes cleanly. */
function uvLockWritingExec(repo: string): ReturnType<typeof fakeExec> {
  return fakeExec((cmd, execCwd) => {
    if (cmd.bin === 'uv' && cmd.args[0] === 'sync') {
      fs.appendFileSync(path.join(execCwd ?? repo, 'uv.lock'), '\n');
    }
  });
}

describe('e2e a2: a recipe-only plan lands verified at $0 on a python repo', () => {
  it('deferred advisory with a fixed version: the uv override pin applies, resyncs, commits; the driver is never touched', async () => {
    const repo = pyEstate();
    const { driver, runs } = stubDriver(); // throws on contact
    const exec = uvLockWritingExec(repo);
    const r = await runOnEstate({
      repo,
      packs: PY_PACKS,
      taskId: 'fix-vulns',
      driver,
      exec,
      scan: [
        {
          id: 'GHSA-py',
          package: 'urllib3',
          installedVersion: '2.0.7',
          tool: 'osv-scanner',
          packId: 'python',
          severity: 'high',
          reachable: true,
          fingerprint: 'dead000011112222',
          fixedVersion: '2.5.0',
        },
      ],
    });

    expect(runs).toHaveLength(0);
    expect(r.outcome).toBe('verified');
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['dep-advisory:urllib3', 'applied'],
    ]);
    expect(r.envelope).toBeUndefined(); // nothing was spent
    // The fix is REAL: the override landed in pyproject.toml in a commit
    // made by the recipe, and the resync ran through uv, never npm.
    const manifest = git(repo, ['show', 'HEAD:pyproject.toml']);
    expect(manifest).toContain('[tool.uv]');
    expect(manifest).toContain('override-dependencies = ["urllib3==2.5.0"]');
    expect(exec.calls.some((c) => c.cmd.bin === 'uv' && c.cmd.args[0] === 'sync')).toBe(true);
    expect(exec.calls.every((c) => c.cmd.bin !== 'npm')).toBe(true);
    expect(git(repo, ['log', '--oneline'])).toContain('override-pin recipe');
  });

  it('stale uv lockfile: lockfile-sync resyncs with uv, verifies with the pack sync check, commits; zero driver invocations', async () => {
    const repo = pyEstate();
    const { driver, runs } = stubDriver();
    const staleEntry: CorrectnessFloorResult = {
      ran: true,
      blocks: true,
      checks: [
        {
          pack: 'python',
          label: LOCKFILE_SYNC_LABEL,
          bin: 'uv',
          args: ['lock', '--check'],
          status: 'fail',
          output: 'The lockfile at `uv.lock` needs to be updated',
        },
      ],
    };
    const exec = uvLockWritingExec(repo);
    const r = await runOnEstate({
      repo,
      packs: PY_PACKS,
      taskId: 'fix-build',
      driver,
      entryFloor: staleEntry,
      exec,
    });

    expect(runs).toHaveLength(0);
    expect(r.outcome).toBe('verified');
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['stale-lockfile:python', 'applied'],
    ]);
    // The resync AND the verify both went through the python pack's
    // declared commands (uv sync, then uv lock --check).
    const uvCalls = exec.calls.filter((c) => c.cmd.bin === 'uv').map((c) => c.cmd.args[0]);
    expect(uvCalls).toContain('sync');
    expect(uvCalls).toContain('lock');
    expect(git(repo, ['log', '--oneline'])).toContain('lockfile-sync recipe');
    expect(r.ledger).toContain('stale-lockfile:python');
  });
});

// ---------------------------------------------------------------------------
// a3. The compiled-language proof (4.4.7 V3): the same recipe-only $0
//     landing on a GO repo through the seam's COMMAND plan shape (go owns
//     go.mod/go.sum, so the pin is `go get`, not a manifest edit). The
//     driver still throws on contact; every spawn goes through go.
// ---------------------------------------------------------------------------

const GO_PACKS = [getLanguage('go')!];

const GO_MOD_FIXTURE = `module example.com/app

go 1.22

require golang.org/x/text v0.3.7 // indirect
`;

/** A go estate: go.mod + go.sum, remediate enabled, the same committed
 *  baseline + deferred allowlist shape as the node estate. */
function goEstate(): string {
  return fixtureRepo({
    'go.mod': GO_MOD_FIXTURE,
    'go.sum': 'golang.org/x/text v0.3.7/go.mod h1:aaaa\n',
    'main.go': 'package main\n\nfunc main() {}\n',
    '.dxkit/policy.json': policyJson(),
    '.dxkit/baselines/main.json': baselineJson(),
    '.dxkit/allowlist.json': DEFERRED_ALLOWLIST,
  });
}

/** The go estate's exec fake: `go get` rewrites go.mod + go.sum (the tool
 *  owns both files, one command); `go mod tidy` rewrites go.sum; the
 *  `go mod tidy -diff` verify passes cleanly. */
function goToolExec(repo: string): ReturnType<typeof fakeExec> {
  return fakeExec((cmd, execCwd) => {
    const root = execCwd ?? repo;
    if (cmd.bin !== 'go') return;
    if (cmd.args[0] === 'get') {
      fs.appendFileSync(
        path.join(root, 'go.mod'),
        'require golang.org/x/text v0.3.8 // indirect\n',
      );
      fs.appendFileSync(path.join(root, 'go.sum'), 'golang.org/x/text v0.3.8/go.mod h1:bbbb\n');
    }
    if (cmd.args[0] === 'mod' && cmd.args[1] === 'tidy' && !cmd.args.includes('-diff')) {
      fs.appendFileSync(path.join(root, 'go.sum'), '\n');
    }
  });
}

describe('e2e a3: a recipe-only plan lands verified at $0 on a go repo (the command-plan shape)', () => {
  it('deferred advisory with a fixed version: the go tool applies its own pin, commits; no resync, no driver', async () => {
    const repo = goEstate();
    const { driver, runs } = stubDriver(); // throws on contact
    const exec = goToolExec(repo);
    const r = await runOnEstate({
      repo,
      packs: GO_PACKS,
      taskId: 'fix-vulns',
      driver,
      exec,
      scan: [
        {
          id: 'GO-2026-0001',
          package: 'golang.org/x/text',
          installedVersion: '0.3.7',
          tool: 'osv-scanner',
          packId: 'go',
          severity: 'high',
          reachable: true,
          fingerprint: 'dead000011112222',
          fixedVersion: '0.3.8',
        },
      ],
    });

    expect(runs).toHaveLength(0);
    expect(r.outcome).toBe('verified');
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['dep-advisory:golang.org/x/text', 'applied'],
    ]);
    expect(r.envelope).toBeUndefined(); // nothing was spent
    // The fix is REAL and TOOL-OWNED: one `go get` rewrote both module
    // files in a commit made by the recipe; no separate resync install ran
    // and nothing ever spawned npm.
    const goArgs = exec.calls.filter((c) => c.cmd.bin === 'go').map((c) => c.cmd.args.join(' '));
    expect(goArgs[0]).toBe('get golang.org/x/text@v0.3.8');
    // No lock-writing resync followed the pin (the frame's invariant step
    // may run the non-writing tidy -diff CHECK; a plain tidy never runs).
    expect(goArgs).not.toContain('mod tidy');
    expect(exec.calls.every((c) => c.cmd.bin === 'go')).toBe(true);
    expect(git(repo, ['show', 'HEAD:go.mod'])).toContain('golang.org/x/text v0.3.8');
    expect(git(repo, ['show', 'HEAD:go.sum'])).toContain('v0.3.8/go.mod');
    expect(git(repo, ['log', '--oneline'])).toContain('override-pin recipe');
  });

  it('stale go.sum: lockfile-sync resyncs with go mod tidy, verifies with tidy -diff, commits; zero driver invocations', async () => {
    const repo = goEstate();
    const { driver, runs } = stubDriver();
    const staleEntry: CorrectnessFloorResult = {
      ran: true,
      blocks: true,
      checks: [
        {
          pack: 'go',
          label: LOCKFILE_SYNC_LABEL,
          bin: 'go',
          args: ['mod', 'tidy', '-diff'],
          status: 'fail',
          output: 'go.mod and go.sum need updates',
        },
      ],
    };
    const exec = goToolExec(repo);
    const r = await runOnEstate({
      repo,
      packs: GO_PACKS,
      taskId: 'fix-build',
      driver,
      entryFloor: staleEntry,
      exec,
    });

    expect(runs).toHaveLength(0);
    expect(r.outcome).toBe('verified');
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['stale-lockfile:go', 'applied'],
    ]);
    // The resync AND the verify both went through the go pack's declared
    // commands (go mod tidy, then go mod tidy -diff).
    const goArgs = exec.calls.filter((c) => c.cmd.bin === 'go').map((c) => c.cmd.args.join(' '));
    expect(goArgs).toContain('mod tidy');
    expect(goArgs).toContain('mod tidy -diff');
    expect(git(repo, ['log', '--oneline'])).toContain('lockfile-sync recipe');
    expect(r.ledger).toContain('stale-lockfile:go');
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
// d. The live shape: pins land, a hand-edited lockfile is repaired or dropped
// ---------------------------------------------------------------------------

const HAND_EDIT = '{"lockfileVersion":3,"HAND-EDITED":true}\n';
const TOOL_TRUTH = '{"lockfileVersion":3,"resynced":true}\n';

/** A second deferred advisory with NO fixed version, so its order tiers
 *  agent while the js-yaml one tiers recipe: one run, both tiers. */
const TWO_DEFERRED_ALLOWLIST = JSON.stringify({
  ...(JSON.parse(DEFERRED_ALLOWLIST) as { entries: unknown[] }),
  entries: [
    ...(JSON.parse(DEFERRED_ALLOWLIST) as { entries: unknown[] }).entries,
    {
      fingerprint: 'dead000033334444',
      kind: 'dep-vuln',
      category: 'deferred',
      reason: 'lane will fix',
      addedBy: 't',
      addedAt: '2026-08-01',
      expiresAt: '2026-09-15',
    },
  ],
});

const LODASH: DepVulnFinding = {
  id: 'GHSA-2',
  package: 'lodash',
  installedVersion: '4.17.20',
  tool: 'osv-scanner',
  packId: 'typescript',
  severity: 'high',
  reachable: true,
  fingerprint: 'dead000033334444',
};

/** The agent of the live run: it pins lodash in the manifest and, with
 *  installs denied, hand-edits the lockfile to "update" it. */
function handEditingDriver(): ReturnType<typeof stubDriver> {
  return stubDriver((opts) => {
    const manifestPath = path.join(opts.cwd, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.overrides = { ...(manifest.overrides as object), lodash: '4.17.21' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(opts.cwd, 'package-lock.json'), HAND_EDIT);
    return { turns: 4, costUsd: 0.3 };
  });
}

/** The package manager of the live run: the frozen dry-run refuses a
 *  hand-edited lockfile; the resync rewrites it to the tool's truth (or,
 *  when `resyncFails`, cannot resolve the manifest at all). */
function liveExec(repo: string, resyncFails: boolean): ReturnType<typeof fakeExec> {
  return fakeExec((cmd, execCwd) => {
    if (cmd.bin !== 'npm') return undefined;
    const lock = path.join(execCwd ?? repo, 'package-lock.json');
    const content = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : '';
    if (cmd.args[0] === 'ci' && cmd.args.includes('--dry-run')) {
      return content.includes('HAND-EDITED')
        ? {
            code: 1,
            output: 'npm error code EUSAGE\nnpm error Missing: lodash@4.17.21 from lock file',
          }
        : undefined;
    }
    if (cmd.args[0] === 'install') {
      if (resyncFails) return { code: 1, output: 'npm error code E404 lodash@4.17.21 not found' };
      fs.writeFileSync(lock, TOOL_TRUTH);
      return undefined;
    }
    return undefined;
  });
}

/** The live 4.4.6 defect estate: a PRE-EXISTING peer conflict fails the
 *  bare dry-run (ERESOLVE) before it ever validates the lock; only the
 *  dry-run under --legacy-peer-deps can see drift (EUSAGE on a
 *  hand-edited lock). The pre-fix check passed on the ERESOLVE match
 *  alone and reported "already consistent" over the drift. */
function peerConflictExec(repo: string): ReturnType<typeof fakeExec> {
  return fakeExec((cmd, execCwd) => {
    if (cmd.bin !== 'npm') return undefined;
    const lock = path.join(execCwd ?? repo, 'package-lock.json');
    const content = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : '';
    if (cmd.args[0] === 'ci' && cmd.args.includes('--dry-run')) {
      if (!cmd.args.includes('--legacy-peer-deps')) {
        return {
          code: 1,
          output: 'npm error code ERESOLVE\nnpm error ERESOLVE could not resolve peer react@^18',
        };
      }
      return content.includes('HAND-EDITED')
        ? {
            code: 1,
            output: 'npm error code EUSAGE\nnpm error Missing: lodash@4.17.21 from lock file',
          }
        : undefined;
    }
    if (cmd.args[0] === 'install') {
      fs.writeFileSync(lock, TOOL_TRUTH);
      return undefined;
    }
    return undefined;
  });
}

describe('e2e d: the live shape, nine pins then a hand-edited lockfile', () => {
  it("the frame replaces the hand edit with the resync: pin and agent order both land, the lockfile is the tool's truth", async () => {
    const repo = estate({ '.dxkit/allowlist.json': TWO_DEFERRED_ALLOWLIST });
    const { driver, runs } = handEditingDriver();
    const exec = liveExec(repo, false);
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding('4.1.0'), LODASH],
      exec,
      frameExec: exec,
    });

    expect(runs).toHaveLength(1);
    // R2: the agent was told the contract in the order prompt.
    expect(runs[0].prompt).toContain('do not edit package-lock.json or run installs');
    expect(runs[0].prompt).toContain('change package.json and stop');
    // The recipe pin applied and was verified as a group before the agent.
    expect(r.recipes?.records.map((rec) => [rec.orderId, rec.outcome.kind])).toEqual([
      ['dep-advisory:js-yaml', 'applied'],
    ]);
    expect(r.recipes?.groupVerification?.kind).toBe('kept');
    // R1: the invariant step re-established lockfile-sync after the agent.
    const rec = r.orders?.records[0];
    expect(rec?.invariants?.map((o) => [o.id, o.status])).toEqual([
      ['lockfile-sync', 'reestablished'],
    ]);
    expect(rec?.disposition?.kind).toBe('kept');
    expect(exec.calls.map((c) => [c.cmd.bin, ...c.cmd.args].join(' '))).toContain(
      'npm install --no-audit --no-fund',
    );
    expect(r.outcome).toBe('verified');
    // The landed lockfile is the tool's, not the agent's hand edit.
    expect(git(repo, ['show', 'HEAD:package-lock.json'])).toContain('resynced');
    expect(git(repo, ['show', 'HEAD:package-lock.json'])).not.toContain('HAND-EDITED');
    expect(git(repo, ['log', '--oneline'])).toContain('re-establish lockfile-sync');
    const manifest = JSON.parse(git(repo, ['show', 'HEAD:package.json'])) as Record<
      string,
      Record<string, string>
    >;
    expect(manifest.overrides).toEqual({ 'js-yaml': '4.1.0', lodash: '4.17.21' });
    expect(r.ledger).toContain('RE-ESTABLISHED');
  });

  it('the live 4.4.6 defect shape: a tolerated peer conflict never masks drift — the invariant verify FAILS through the fallback dry-run, the resync repairs the lock, the order lands', async () => {
    const repo = estate({ '.dxkit/allowlist.json': TWO_DEFERRED_ALLOWLIST });
    const { driver, runs } = handEditingDriver();
    const exec = peerConflictExec(repo);
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver,
      scan: [scanFinding('4.1.0'), LODASH],
      exec,
      frameExec: exec,
    });

    expect(runs).toHaveLength(1);
    // The confirming dry-run under the fallback RAN (the pre-fix executor
    // never spawned it, and reported "already consistent" over the drift).
    const dryRuns = exec.calls
      .map((c) => [c.cmd.bin, ...c.cmd.args].join(' '))
      .filter((c) => c.includes('--dry-run'));
    expect(dryRuns.some((c) => c.includes('--legacy-peer-deps'))).toBe(true);
    // The invariant saw the drift, resynced, and re-verified through the
    // tolerance: the order is KEPT and the landed lock is the tool's.
    const rec = r.orders?.records[0];
    expect(rec?.invariants?.map((o) => [o.id, o.status])).toEqual([
      ['lockfile-sync', 'reestablished'],
    ]);
    expect(rec?.disposition?.kind).toBe('kept');
    expect(r.outcome).toBe('verified');
    expect(git(repo, ['show', 'HEAD:package-lock.json'])).toContain('resynced');
    expect(git(repo, ['show', 'HEAD:package-lock.json'])).not.toContain('HAND-EDITED');
    expect(git(repo, ['log', '--oneline'])).toContain('re-establish lockfile-sync');
    const manifest = JSON.parse(git(repo, ['show', 'HEAD:package.json'])) as Record<
      string,
      Record<string, string>
    >;
    expect(manifest.overrides).toEqual({ 'js-yaml': '4.1.0', lodash: '4.17.21' });
    // The tolerance is disclosed on the re-verification, never silent.
    expect(r.ledger).toContain('RE-ESTABLISHED');
    expect(r.ledger).toContain('--legacy-peer-deps');
  });

  it('the resync cannot re-establish the tree: the pin lands, the agent order is dropped at tree-invariants, partially-landed', async () => {
    const repo = estate({ '.dxkit/allowlist.json': TWO_DEFERRED_ALLOWLIST });
    const { driver, runs } = handEditingDriver();
    // The recipe tier's own install must still succeed (the pin resyncs
    // itself); only the agent order's re-establishment fails.
    let agentPhase = false;
    const recipeExec = liveExec(repo, false);
    const frameExec = fakeExec((cmd, execCwd) => {
      if (!agentPhase) return recipeExec.exec(cmd, execCwd);
      return liveExec(repo, true).exec(cmd, execCwd);
    });
    const r = await runOnEstate({
      repo,
      taskId: 'fix-vulns',
      driver: {
        ...driver,
        run: async (opts) => {
          agentPhase = true;
          return driver.run(opts);
        },
      },
      scan: [scanFinding('4.1.0'), LODASH],
      exec: recipeExec,
      frameExec,
    });

    expect(runs).toHaveLength(1);
    expect(r.outcome).toBe('partially-landed');
    expect(r.recipes?.records[0].disposition?.kind).toBe('kept');
    const rec = r.orders?.records[0];
    expect(rec?.disposition).toEqual({
      kind: 'dropped',
      step: 'tree-invariants',
      reason: expect.stringContaining('E404'),
    });
    expect(rec?.invariants?.[0]?.status).toBe('could-not-reestablish');
    // The landed head carries the pin and NOT the agent's manifest edit or
    // its hand-edited lockfile.
    const manifest = JSON.parse(git(repo, ['show', 'HEAD:package.json'])) as Record<
      string,
      Record<string, string>
    >;
    expect(manifest.overrides).toEqual({ 'js-yaml': '4.1.0' });
    expect(git(repo, ['show', 'HEAD:package-lock.json'])).not.toContain('HAND-EDITED');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    // The ledger names the dropped order as still open; the rows count its
    // class on the invariant step, and the pin's class on the landing.
    expect(r.ledger).toContain('DROPPED at tree-invariants');
    expect(r.note).toContain('dep-advisory:lodash');
    const rows = orderOutcomeRows(r, 'fix-vulns', {
      timestamp: '2026-08-27T00:00:00Z',
      stamp: remediateStamp(repo),
    });
    expect(rows.map((row) => [row.orderId, row.outcome])).toEqual([
      ['dep-advisory:js-yaml', 'verified'],
      ['dep-advisory:lodash', 'invariant-failed'],
    ]);
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
