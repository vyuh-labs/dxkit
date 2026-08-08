/**
 * The gate-vs-guardrail parity harness (4.4.0 WP0).
 *
 * # Why this exists (written BEFORE the engine extraction, on purpose)
 *
 * 4.4.0 extracts the guardrail-check orchestration into one engine
 * (`src/gate/engine.ts`) and adds a second consumer surface (`gate <dir>`).
 * That is exactly the shape CLAUDE.md Rule 2.30 warns about: one concept
 * (judge a subject against a prior under a policy) about to gain two
 * consumers holding different data shapes. The only net that catches
 * semantic divergence between them is a parity test that runs BOTH
 * surfaces on shared fixtures and asserts they agree — so the net is
 * written first, freezing today's `runGuardrailCheck` behavior as the
 * reference, and the `gate` surface joins the SAME scenario matrix when
 * it lands (WP2).
 *
 * # What a surface is
 *
 * A `GateSurface` turns a built scenario (a repo with a known base state
 * and a known current state) into a `VerdictProjection` — the comparable
 * core of a verdict: the verdict word + exit code (derived ONLY through
 * `verdictCounts`, never `blocks ? 1 : 0`), the blocking finding set with
 * durable identities, the disclosure surfaces (not-observed, ref-excluded
 * kinds, attribution gaps), and the additive-gate outcomes. Two surfaces
 * agree when `compareProjections` returns no diffs.
 *
 * Identity fields (`id`) are environment-independent by construction
 * (Rule 9), which is what makes cross-surface comparison sound.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck } from '../../src/baseline/check';
import type { GuardrailCheckResult } from '../../src/baseline/check';
import { verdictCounts } from '../../src/baseline/check-renderers';
import { trustedLocalContext } from '../../src/analysis-trust';
import { runGate } from '../../src/gate/engine';
import { resolveGateMode } from '../../src/baseline/modes';
import { resolvePolicy } from '../../src/baseline/policy';

/** The tag every scenario stamps on its base state. Ref-shaped surfaces
 *  (guardrail ref-based today, gate tree-baseline later) resolve the prior
 *  from it; committed-mode surfaces have already captured a baseline file
 *  at the same state. */
export const PARITY_BASE_REF = 'parity-base';

/** One finding that counts toward the verdict, projected to its durable,
 *  surface-independent core. */
export interface ProjectedFinding {
  readonly kind: string;
  readonly file?: string;
  /** Canonical fingerprint (Rule 9) — the durable identity both surfaces
   *  must mint identically for the same finding on the same tree. */
  readonly id?: string;
}

/** The comparable core of one surface's verdict over one scenario. */
export interface VerdictProjection {
  readonly surface: string;
  readonly verdict: string;
  readonly exitCode: 0 | 1;
  /** Pair-level blocking findings, sorted by (kind, file, id). Additive-gate
   *  blocks are counted in `blockingCount` (via `verdictCounts`) and shown
   *  per-gate in `gates`. */
  readonly blocking: ReadonlyArray<ProjectedFinding>;
  /** Total blocking tally exactly as the verdict layer counts it. */
  readonly blockingCount: number;
  readonly warningCount: number;
  readonly unattributable: number;
  /** Rule 19 removed-direction disclosures, projected to kind+count. */
  readonly notObserved: ReadonlyArray<{ readonly kind: string; readonly count: number }>;
  /** Kinds structurally excluded from a ref-based diff (with the dropped
   *  current-side count) — a DECLARED difference between surfaces, so it is
   *  part of the projection: a surface that silently drops a kind instead
   *  of disclosing it must NOT compare equal to one that disclosed. */
  readonly refExcludedKinds: ReadonlyArray<{
    readonly kind: string;
    readonly currentCount: number;
  }>;
  /** Additive-gate outcomes, one summary word per gate. */
  readonly gates: {
    readonly flow: string;
    readonly schema: string;
    readonly dup: string;
    readonly paired: string;
  };
}

/** Summarize an additive gate outcome into one comparable word. */
function gateWord(
  g: { ran?: boolean; skipped?: string; blocks?: boolean; warns?: boolean } | undefined,
): string {
  if (!g) return 'absent';
  if (g.blocks) return 'blocks';
  if (g.warns) return 'warns';
  if (g.ran === false) return `skip:${g.skipped ?? 'unknown'}`;
  return 'ran-clean';
}

/** Project a `GuardrailCheckResult` onto the comparable core. */
export function projectGuardrailResult(
  surface: string,
  result: GuardrailCheckResult,
): VerdictProjection {
  const counts = verdictCounts(result);
  const blocking = result.pairs
    .filter((p) => p.classification.blocks)
    .map((p) => ({
      kind: p.kind as string,
      file: p.file,
      id: p.pair.currentId ?? p.pair.priorId,
    }))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.file ?? '').localeCompare(b.file ?? '') ||
        (a.id ?? '').localeCompare(b.id ?? ''),
    );
  return {
    surface,
    verdict: counts.verdict,
    exitCode: counts.exitCode,
    blocking,
    blockingCount: counts.blocking,
    warningCount: counts.warning,
    unattributable: counts.unattributable,
    notObserved: result.notObserved
      .map((n) => ({ kind: n.kind as string, count: n.count }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    refExcludedKinds: result.refExcludedKinds
      .map((e) => ({ kind: e.kind as string, currentCount: e.currentCount }))
      .sort((a, b) => a.kind.localeCompare(b.kind)),
    gates: {
      flow: gateWord(result.flowGate),
      schema: gateWord(result.schemaDriftGate),
      dup: gateWord(result.dupGate),
      paired: gateWord(result.pairedGate),
    },
  };
}

/**
 * Compare two projections field by field. Empty array = the surfaces agree.
 * Each diff names the field and both values so a parity failure reads as a
 * diagnosis, not a blob diff. The `surface` label itself is NOT compared.
 */
export function compareProjections(a: VerdictProjection, b: VerdictProjection): string[] {
  const diffs: string[] = [];
  const scalar = (field: string, av: unknown, bv: unknown) => {
    if (av !== bv) diffs.push(`${field}: ${a.surface}=${String(av)} vs ${b.surface}=${String(bv)}`);
  };
  scalar('verdict', a.verdict, b.verdict);
  scalar('exitCode', a.exitCode, b.exitCode);
  scalar('blockingCount', a.blockingCount, b.blockingCount);
  scalar('warningCount', a.warningCount, b.warningCount);
  scalar('unattributable', a.unattributable, b.unattributable);
  const list = (field: string, av: ReadonlyArray<unknown>, bv: ReadonlyArray<unknown>) => {
    const as = JSON.stringify(av);
    const bs = JSON.stringify(bv);
    if (as !== bs) diffs.push(`${field}: ${a.surface}=${as} vs ${b.surface}=${bs}`);
  };
  list('blocking', a.blocking, b.blocking);
  list('notObserved', a.notObserved, b.notObserved);
  list('refExcludedKinds', a.refExcludedKinds, b.refExcludedKinds);
  scalar('gates.flow', a.gates.flow, b.gates.flow);
  scalar('gates.schema', a.gates.schema, b.gates.schema);
  scalar('gates.dup', a.gates.dup, b.gates.dup);
  scalar('gates.paired', a.gates.paired, b.gates.paired);
  return diffs;
}

/** A built scenario: one repo whose base state is tagged `PARITY_BASE_REF`
 *  (and captured as a committed baseline) and whose current state is HEAD. */
export interface BuiltScenario {
  readonly name: string;
  readonly dir: string;
  readonly baseRef: string;
}

/** One way of judging a scenario. `guardrail check` modes today; the
 *  `gate` surface joins in WP2 with NO change to the scenario matrix. */
export interface GateSurface {
  readonly name: string;
  run(scenario: BuiltScenario): Promise<VerdictProjection>;
}

/** Committed-full guardrail check — the baseline file captured at base. */
export const guardrailCommittedSurface: GateSurface = {
  name: 'guardrail-committed',
  async run(scenario) {
    const result = await runGuardrailCheck({ cwd: scenario.dir, trust: trustedLocalContext() });
    return projectGuardrailResult(this.name, result);
  },
};

/** Ref-based guardrail check — the prior gathered from the base tag. */
export const guardrailRefBasedSurface: GateSurface = {
  name: 'guardrail-ref-based',
  async run(scenario) {
    const result = await runGuardrailCheck({
      cwd: scenario.dir,
      trust: trustedLocalContext(),
      cliMode: 'ref-based',
      cliRef: scenario.baseRef,
    });
    return projectGuardrailResult(this.name, result);
  },
};

/** Materialize the scenario's base tag as a bare directory (what a
 *  consumer would hand `gate --baseline`): `git archive` — read-only,
 *  no worktree (that primitive stays in ref-baseline.ts). */
export function materializeBaseTree(scenario: BuiltScenario): string {
  const out = mkdtempSync(join(tmpdir(), 'dxkit-parity-base-'));
  execFileSync(
    'bash',
    ['-c', `git -C '${scenario.dir}' archive ${scenario.baseRef} | tar -x -C '${out}'`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out;
}

/**
 * The gate surface (WP2): subject = the scenario's working tree judged
 * as a bare TREE, prior = the base tag materialized to a directory
 * (`tree-baseline`). This is the surface WP0 reserved the seam for —
 * the engine judging the same (prior, current) pair through the
 * dir-shaped prior arm instead of the git ref arm.
 */
export const gateTreeBaselineSurface: GateSurface = {
  name: 'gate-tree-baseline',
  async run(scenario) {
    const baseDir = materializeBaseTree(scenario);
    try {
      const result = await runGate(
        { kind: 'tree', dir: scenario.dir },
        resolveGateMode({ baselineDir: baseDir }),
        resolvePolicy(undefined, scenario.dir),
        { trust: trustedLocalContext() },
      );
      return projectGuardrailResult(this.name, result);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
};

/**
 * Run every surface over the scenario and assert pairwise agreement.
 * Throws with the full diff list on the first disagreement — the parity
 * failure IS the test failure. Returns the projections so callers can
 * additionally pin characterization expectations against them.
 */
export async function assertSurfacesAgree(
  scenario: BuiltScenario,
  surfaces: ReadonlyArray<GateSurface>,
): Promise<VerdictProjection[]> {
  const projections: VerdictProjection[] = [];
  for (const surface of surfaces) {
    projections.push(await surface.run(scenario));
  }
  for (let i = 1; i < projections.length; i++) {
    const diffs = compareProjections(projections[0], projections[i]);
    if (diffs.length > 0) {
      throw new Error(
        `parity violation on scenario '${scenario.name}' between ` +
          `${projections[0].surface} and ${projections[i].surface}:\n  ${diffs.join('\n  ')}`,
      );
    }
  }
  return projections;
}

// ---------------------------------------------------------------------------
// Scenario builders. Each produces a temp git repo whose base state carries
// BOTH prior representations (a committed baseline file AND the base tag),
// so every surface judges the same (prior, current) pair.
// ---------------------------------------------------------------------------

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-parity-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

async function sealBaseState(dir: string): Promise<void> {
  // Capture the committed-mode prior FIRST, then commit the artifacts it
  // wrote (.dxkit/baselines) so the tagged base tree is exactly the tree
  // the baseline describes.
  await createBaseline({ cwd: dir });
  commitAll(dir, 'baseline capture');
  execFileSync('git', ['tag', PARITY_BASE_REF], { cwd: dir });
}

/** Base == current, nothing seeded. Expected: PASSED everywhere. */
export async function buildCleanScenario(): Promise<BuiltScenario> {
  const dir = initRepo();
  writeFileSync(join(dir, 'README.md'), '# parity fixture\n');
  writeFileSync(join(dir, 'index.ts'), "export const greeting = 'hello';\n");
  commitAll(dir, 'base');
  await sealBaseState(dir);
  return { name: 'clean', dir, baseRef: PARITY_BASE_REF };
}

/** A credential-shaped literal added AFTER the base state. Expected:
 *  BLOCKED with one net-new secret finding under the default preset. */
export async function buildNetNewSecretScenario(): Promise<BuiltScenario> {
  const dir = initRepo();
  writeFileSync(join(dir, 'README.md'), '# parity fixture\n');
  writeFileSync(join(dir, 'index.ts'), "export const greeting = 'hello';\n");
  commitAll(dir, 'base');
  await sealBaseState(dir);
  // Built at runtime so THIS repo's own guardrail never sees a credential
  // literal in the harness source (same discipline as grep-secrets.test.ts).
  const secretValue = ['hunter', '22', 'live', 'value'].join('-');
  writeFileSync(
    join(dir, 'config.ts'),
    `const password = '${secretValue}';\nexport { password };\n`,
  );
  commitAll(dir, 'introduce credential');
  return { name: 'net-new-secret', dir, baseRef: PARITY_BASE_REF };
}

/** A user custom check failing at base AND current. Expected: persisted
 *  (grandfathered) in committed mode; structurally excluded + DISCLOSED in
 *  ref-based mode (REF_UNRELIABLE_KINDS) — a declared surface difference,
 *  characterized per surface rather than asserted identical. */
export async function buildPersistedCheckScenario(): Promise<BuiltScenario> {
  const dir = initRepo();
  writeFileSync(join(dir, 'README.md'), '# parity fixture\n');
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(
    join(dir, '.dxkit', 'policy.json'),
    JSON.stringify(
      {
        checks: [{ name: 'custom:always-fail', command: ['node', '-e', 'process.exit(1)'] }],
      },
      null,
      2,
    ),
  );
  commitAll(dir, 'base');
  await sealBaseState(dir);
  return { name: 'persisted-custom-check', dir, baseRef: PARITY_BASE_REF };
}
