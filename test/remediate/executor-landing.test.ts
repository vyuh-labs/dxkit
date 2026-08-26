/**
 * The executor's landing layer (#273) — pinned through the executor seams.
 *
 * The live class: a push ruleset refused the landing push (403/GH006 on a
 * `.github/**` path restriction) and the frame CRASHED — no attempt record
 * (never written), no ledger rendered, the workflow's evidence artifact
 * empty, 18 minutes of verified work lost. The class exists on every GitHub
 * repo (GITHUB_TOKEN refuses `.github/workflows/**` pushes without the
 * `workflows` permission), not only where a ruleset restricts paths.
 *
 * Two invariants, both directions:
 *   - evidence BEFORE delivery: the attempt record (with the commit range
 *     the patch-artifact fallback reads) exists before the push runs;
 *   - a landing failure is a DISCLOSED outcome (cause + remedy when it is
 *     rules/permissions-shaped), never a crash.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeTask, type ExecutorSeams } from '../../src/remediate/cli';
import { DEFAULT_REMEDIATE_BUDGET, type RemediateConfig } from '../../src/remediate/config';
import type { RemediateResult } from '../../src/remediate/run';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-exec-'));
  dirs.push(dir);
  return dir;
}

function config(salvage: RemediateConfig['salvage'] = 'discard'): RemediateConfig {
  return {
    enabled: true,
    tasks: ['write-docs'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage,
    agent: { driver: 'claude-code', model: 'auto', budget: DEFAULT_REMEDIATE_BUDGET },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    maxOrdersPerRun: 0,
    resume: false,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
  };
}

function verifiedResult(): RemediateResult {
  return {
    outcome: 'verified',
    task: 'write-docs',
    ledger: 'THE VERIFICATION LEDGER',
    baseHead: 'aaaa1111',
    head: 'bbbb2222',
  };
}

/** The ruleset refusal git actually prints (web-client's "Push to Path
 *  block" ruleset, trimmed) — stderr rides the thrown exec error. */
const RULESET_STDERR =
  'remote: error: GH013: Repository rule violations found for refs/heads/dxkit/remediate-write-docs.\n' +
  'remote: - Push to Path block\n' +
  "remote:   Paths must not match: '.github/**/*'\n" +
  '! [remote rejected] HEAD -> dxkit/remediate-write-docs (push declined due to repository rule violations)';

function seams(overrides: Partial<ExecutorSeams> = {}): ExecutorSeams {
  return {
    runTask: async () => verifiedResult(),
    branch: () => 'main',
    defaultBranch: () => 'main',
    landHead: () => ({
      outcome: 'pr-opened' as const,
      mode: 'pr' as const,
      prUrl: 'https://example.test/pr/1',
    }),
    // A clean $0 preflight by default (#286) — tests never shell gh.
    probeDelivery: () => ({ probes: [], anyBlocked: false, unverifiable: false }),
    ...overrides,
  };
}

function readRecord(cwd: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, '.dxkit', 'cache', 'remediate-write-docs.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('executeTask $0 landing preflight (#286)', () => {
  it('positive refusal evidence refuses BEFORE any agent spawns, with the remedy named', async () => {
    const cwd = tempRepo();
    let agentSpawned = false;
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        runTask: async () => {
          agentSpawned = true;
          return verifiedResult();
        },
        probeDelivery: () => ({
          probes: [
            {
              branch: 'dxkit/remediate-write-docs',
              verdict: 'blocked' as const,
              evidence: 'an active branch-creation ruleset covers "dxkit/remediate-write-docs"',
              remedy: 'add "refs/heads/dxkit/**" to its exclusion patterns',
            },
          ],
          anyBlocked: true,
          unverifiable: false,
        }),
      }),
    );
    expect(agentSpawned).toBe(false); // the whole point: $0, no spend
    expect(run.result.outcome).toBe('refused');
    expect(run.result.note).toContain('landing-unavailable');
    expect(run.result.note).toContain('refs/heads/dxkit/**');
    expect(run.clean).toBe(false);
  });

  it('an unverifiable probe PROCEEDS — the preflight never invents a refusal', async () => {
    const cwd = tempRepo();
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        probeDelivery: () => ({
          probes: [
            {
              branch: 'dxkit/remediate-write-docs',
              verdict: 'unknown' as const,
              evidence: 'could not verify: API unreachable',
            },
          ],
          anyBlocked: false,
          unverifiable: true,
        }),
      }),
    );
    expect(run.result.outcome).toBe('verified');
    expect(run.landed).toBe(true);
  });
});

describe('executeTask provisional record (#289)', () => {
  it('the record exists BEFORE the agent phase — a SIGKILLed frame still leaves evidence', async () => {
    const cwd = tempRepo();
    let recordAtAgentTime: Record<string, unknown> | undefined;
    await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        runTask: async () => {
          recordAtAgentTime = readRecord(cwd);
          return verifiedResult();
        },
      }),
    );
    expect(recordAtAgentTime).toBeDefined();
    expect(recordAtAgentTime!.phase).toBe('agent');
    expect(recordAtAgentTime!.landed).toBe(false);
    expect(recordAtAgentTime!.outcome).toBe('provisional');
    // Finalize overwrites it on the normal path.
    const final = readRecord(cwd);
    expect(final.phase).toBe('final');
    expect(final.outcome).toBe('verified');
  });
});

describe('executeTask landing layer (#273)', () => {
  it('a rules-shaped push refusal is a DISCLOSED outcome with the git stderr and the remedy', async () => {
    const cwd = tempRepo();
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        landHead: () => {
          throw Object.assign(new Error('git push exited 1'), { stderr: RULESET_STDERR });
        },
      }),
    );
    expect(run.landed).toBe(false);
    expect(run.clean).toBe(false);
    // The evidence: git's own words, not a paraphrase.
    expect(run.landingBlocked).toContain('GH013');
    expect(run.landingBlocked).toContain('Push to Path block');
    // The remedy, named (rules/permissions-shaped refusal).
    expect(run.landingBlocked).toContain('ruleset bypass');
    expect(run.landingBlocked).toContain('workflows');
    // The ledger survived — the runner's result is intact for the step summary.
    expect(run.result.ledger).toBe('THE VERIFICATION LEDGER');
  });

  it('the attempt record exists BEFORE the push, with the commit range (evidence before delivery)', async () => {
    const cwd = tempRepo();
    let recordAtPushTime: Record<string, unknown> | undefined;
    await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        landHead: () => {
          recordAtPushTime = readRecord(cwd);
          throw Object.assign(new Error('git push exited 1'), { stderr: RULESET_STDERR });
        },
      }),
    );
    // The pre-push record already carries what the patch-artifact fallback
    // needs — the crash-shaped alternative left it unwritten.
    expect(recordAtPushTime).toBeDefined();
    expect(recordAtPushTime!.landed).toBe(false);
    expect(recordAtPushTime!.baseHead).toBe('aaaa1111');
    expect(recordAtPushTime!.head).toBe('bbbb2222');
    // And the final record discloses the refusal.
    const final = readRecord(cwd);
    expect(final.landed).toBe(false);
    expect(String(final.landingBlocked)).toContain('GH013');
  });

  it('a non-rules failure is disclosed WITHOUT inventing a rules remedy', async () => {
    const cwd = tempRepo();
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({
        landHead: () => {
          throw new Error('fatal: unable to access remote: Could not resolve host');
        },
      }),
    );
    expect(run.landingBlocked).toContain('Could not resolve host');
    expect(run.landingBlocked).not.toContain('Remedies');
  });

  it('a successful landing flips the record to landed:true with the PR url', async () => {
    const cwd = tempRepo();
    const run = await executeTask(cwd, config(), 'write-docs', 'pr', seams());
    expect(run.landed).toBe(true);
    expect(run.clean).toBe(true);
    expect(run.prUrl).toBe('https://example.test/pr/1');
    const record = readRecord(cwd);
    expect(record.landed).toBe(true);
    expect(record.prUrl).toBe('https://example.test/pr/1');
  });

  it("custom's salvage decision reaches the runner AND lands as a draft (#274, executor level)", async () => {
    // The live bug sat exactly here: the executor's registry-lookup guard
    // baked 'discard' into the runner's config for 'custom' before the one
    // resolver ever saw it. Now pinned at the wiring layer: under
    // salvage 'auto', custom resolves open-ended → draft-pr, the runner
    // receives that decision, and a budget-exhausted custom outcome lands
    // as a DRAFT instead of being thrown away.
    const cwd = tempRepo();
    let salvageSeenByRunner: string | undefined;
    let draftSeenByLander: boolean | undefined;
    const run = await executeTask(
      cwd,
      config('auto'),
      'custom',
      'pr',
      seams({
        runTask: async (opts) => {
          salvageSeenByRunner = opts.config.salvage;
          return {
            outcome: 'budget-exhausted',
            task: 'custom',
            ledger: 'THE VERIFICATION LEDGER',
            baseHead: 'aaaa1111',
            head: 'bbbb2222',
          };
        },
        landHead: (opts) => {
          draftSeenByLander = opts.draft;
          return { outcome: 'pr-opened', mode: 'pr', prUrl: 'https://example.test/pr/2' };
        },
      }),
    );
    expect(salvageSeenByRunner).toBe('draft-pr');
    expect(draftSeenByLander).toBe(true);
    expect(run.landed).toBe(true);
    expect(run.clean).toBe(true); // a landed budget-bounded draft is the clean outcome
  });

  it('the branch guard still refuses a feature-branch landing (unchanged behavior)', async () => {
    const cwd = tempRepo();
    const run = await executeTask(
      cwd,
      config(),
      'write-docs',
      'pr',
      seams({ branch: () => 'feat/x' }),
    );
    expect(run.landed).toBe(false);
    expect(run.landRefused).toContain("HEAD is on 'feat/x'");
    expect(run.landingBlocked).toBeUndefined();
  });
});
