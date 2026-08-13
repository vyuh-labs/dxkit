/**
 * The deterministic dependency-bump lane — `vyuh-dxkit deps bump`.
 *
 * No LLM anywhere: plan (tool-resolved fix versions only) → apply (the
 * repo's OWN package manager, argv-exec, section-preserving) → verify (the
 * correctness floor at FULL scope + the guardrail) → land (the one standing
 * branch `dxkit/dep-bump` via the shared refresh lander, one reviewable PR
 * whose body is a verification ledger). A dep-change PR is exactly the shape
 * that once passed every gate while breaking the build, so the lane leads
 * with the floor: a red floor after applying means NO PR — the failure is
 * reported, never shipped as "done".
 *
 * Everything not done is disclosed: skipped advisories (no fix / breaking /
 * other ecosystem / allowlisted) are named in the result and the ledger.
 *
 * SECURITY: applying executes the repo's package manager against the
 * checked-out tree. The runner takes the REQUIRED typed trust context and
 * refuses (`skipped-untrusted`) when repo execution is not allowed — the
 * lane runs on the default branch (local or the scheduled workflow), never
 * against an untrusted PR head. Package specs are passed as argv, never
 * through a shell.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { assembleLanePrBody } from '../pr/assemble';
import type { AnalysisTrustContext } from '../analysis-trust';
import type { DepVulnFinding } from '../languages/capabilities/types';
import { gatherDepVulns } from '../analyzers/security/gather';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../analyzers/correctness/run';
import {
  attributeFloorFailures,
  type AttributedFloorFailure,
  type FloorBaseCheck,
} from '../analyzers/correctness/attribution';
import { detectActiveLanguages } from '../languages';
import {
  detectPackageManager,
  upgradeArgv,
  type DependencySection,
  type PackageManager,
} from '../package-manager';
import { buildBumpPlan, type BumpPlan, type PlannedBump } from './plan';
import { renderFloorVerification, renderGuardrailVerdict } from '../lanes/verification-render';
import { appendLaneEvent, LANE_LEDGER_SCHEMA_VERSION } from '../lanes/ledger';
import { guardrailVerdictFor, toFloorBaseChecks } from '../lanes/verify';
import { landRefreshPaths, type LandRefreshResult } from '../land-refresh';
import { detectDefaultBranch } from '../ship-installers';

// The standing-branch name lives in the ONE leaf home the delivery
// prober also reads (`lanes/branches.ts`); re-exported for consumers.
export { DEP_BUMP_BRANCH } from '../lanes/branches';
import { DEP_BUMP_BRANCH } from '../lanes/branches';
import { describeDeliveryProbe, probeDeliveryPreconditions } from '../lanes/delivery-preconditions';

export interface AppliedBump extends PlannedBump {
  readonly applied: boolean;
  /** Tail of the package manager's output when the install failed. */
  readonly failure?: string;
}

export interface DepsBumpResult {
  /** 'planned' — dry run; 'applied' — bumps executed; 'landed' — the PR
   *  actually opened/updated; 'branch-pushed-no-pr' — the branch pushed but
   *  PR creation failed (repo settings / gh error; the manual remedy is in
   *  `note`); 'nothing-to-do' — empty plan; 'refused' — trust or
   *  environment refusal (disclosed in `note`); 'floor-red' — bumps applied
   *  but the floor failed, so nothing landed. */
  readonly outcome:
    | 'planned'
    | 'applied'
    | 'landed'
    | 'branch-pushed-no-pr'
    | 'nothing-to-do'
    | 'refused'
    | 'floor-red';
  readonly plan: BumpPlan;
  readonly applied: readonly AppliedBump[];
  readonly floor?: CorrectnessFloorResult;
  /** Post-apply floor failures attributed against the PRE-apply entry floor
   *  through the ONE comparator (`attributeFloorFailures`): only a NET-NEW
   *  failure blocks the lane; a repo whose floor was already red keeps its
   *  debt disclosed, never weaponized against the bump. */
  readonly floorAttribution?: readonly AttributedFloorFailure[];
  readonly guardrailVerdict?: string;
  readonly land?: LandRefreshResult;
  readonly note?: string;
  /** The verification ledger — the PR body / job summary markdown. */
  readonly ledger: string;
}

export interface DepsBumpOptions {
  readonly cwd: string;
  /** REQUIRED typed trust context — applying runs the package manager. */
  readonly trust: AnalysisTrustContext;
  /** Apply the plan (default: dry-run plan only). */
  readonly apply?: boolean;
  /** Include producer-classified major bumps. Default false. */
  readonly allowMajor?: boolean;
  /** 'pr' — land manifest+lockfile on the standing branch and open/update
   *  the PR; 'none' (default) — leave the working tree changed for the
   *  caller to commit. */
  readonly land?: 'pr' | 'none';
  /** Injected for tests: the bump-command executor. */
  readonly execBump?: (argv: readonly string[]) => { ok: boolean; output: string };
  /** Injected for tests: the floor runner. */
  readonly runFloor?: () => CorrectnessFloorResult;
  /** Injected for tests: the guardrail verdict word (e.g. 'PASSED'). */
  readonly runGuardrail?: () => Promise<string>;
  /** Injected for tests: the lander. */
  readonly landPaths?: typeof landRefreshPaths;
  /** Injected for tests: the findings source. */
  readonly gather?: (cwd: string) => Promise<{ findings: readonly DepVulnFinding[] }>;
  /** Injected for tests: the $0 landing preflight (#286). */
  readonly probeDelivery?: typeof probeDeliveryPreconditions;
}

/** package.json section a direct dependency lives in ('dependencies' when
 *  not found — the safe default for npm's own default behavior). */
function sectionFor(cwd: string, pkg: string): DependencySection {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      if (manifest[section] && pkg in manifest[section]!) return section;
    }
  } catch {
    // fall through — treated as a prod dependency
  }
  return 'dependencies';
}

/** The manifest + lockfile paths a bump touches for this PM — the exact set
 *  the lander commits (nothing else from the tree may ride along). */
export function bumpArtifactPaths(pm: PackageManager): string[] {
  const lock =
    pm === 'pnpm'
      ? ['pnpm-lock.yaml']
      : pm === 'yarn'
        ? ['yarn.lock']
        : pm === 'bun'
          ? ['bun.lockb', 'bun.lock']
          : ['package-lock.json'];
  return ['package.json', ...lock];
}

const SEVERITY_ICON: Record<string, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** The verification ledger — deterministic, identifier-free markdown. */
export function renderLedger(result: Omit<DepsBumpResult, 'ledger'>): string {
  const lines: string[] = ['## dxkit dependency bumps', ''];
  if (result.applied.length > 0) {
    lines.push('| Package | To | Severity | Advisories | Applied |');
    lines.push('|---|---|---|---|---|');
    for (const b of result.applied) {
      const from = b.fromVersion ? `${b.fromVersion} → ` : '';
      lines.push(
        `| \`${b.parent}\` | ${from}**${b.toVersion}**${b.breaking ? ' (major)' : ''} | ` +
          `${SEVERITY_ICON[b.maxSeverity] ?? b.maxSeverity} | ${b.advisories.join(', ')} | ` +
          `${b.applied ? 'yes' : `FAILED — ${b.failure ?? 'install error'}`} |`,
      );
    }
    lines.push('');
  } else if (result.plan.bumps.length > 0) {
    lines.push('Planned (dry run — nothing applied):', '');
    for (const b of result.plan.bumps) {
      lines.push(`- \`${b.parent}\` → ${b.toVersion} (${b.advisories.join(', ')})`);
    }
    lines.push('');
  }

  lines.push('### Verification', '');
  lines.push(
    ...renderFloorVerification(result.floor, result.floorAttribution, 'the pre-bump entry run'),
  );
  lines.push(...renderGuardrailVerdict(result.guardrailVerdict));

  if (result.plan.skipped.length > 0) {
    lines.push('### Not bumped (disclosed)', '');
    const byReason = new Map<string, string[]>();
    for (const s of result.plan.skipped) {
      const list = byReason.get(s.reason) ?? [];
      list.push(`\`${s.package}\` (${s.advisoryId})`);
      byReason.set(s.reason, list);
    }
    for (const [reason, items] of byReason) {
      lines.push(`- **${reason}**: ${items.join(', ')}`);
    }
    lines.push('');
  }
  lines.push(
    '_Deterministic bump lane: fix versions come from the dependency scanners, ' +
      'the floor + guardrail ran before this PR was opened, and everything not ' +
      'bumped is listed above._',
  );
  return lines.join('\n');
}

function defaultExecBump(cwd: string) {
  return (argv: readonly string[]): { ok: boolean; output: string } => {
    try {
      const out = execFileSync(argv[0], argv.slice(1), {
        cwd,
        encoding: 'utf8',
        timeout: 10 * 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, output: out.toString() };
    } catch (e) {
      const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
      const text = [err.stderr, err.stdout, err.message]
        .map((x) => (x == null ? '' : String(x)))
        .join('\n')
        .trim();
      return { ok: false, output: text.slice(-2000) };
    }
  };
}

export async function runDepsBump(opts: DepsBumpOptions): Promise<DepsBumpResult> {
  const cwd = opts.cwd;
  const gather = opts.gather ?? (async (dir: string) => gatherDepVulns(dir));
  const { findings } = await gather(cwd);
  const plan = buildBumpPlan(findings, {
    ...(opts.allowMajor !== undefined ? { allowMajor: opts.allowMajor } : {}),
  });

  const finish = (r: Omit<DepsBumpResult, 'ledger'>): DepsBumpResult => ({
    ...r,
    ledger: renderLedger(r),
  });

  if (plan.bumps.length === 0) {
    return finish({ outcome: 'nothing-to-do', plan, applied: [] });
  }
  if (!opts.apply) {
    return finish({ outcome: 'planned', plan, applied: [] });
  }

  // Trust boundary: applying spawns the package manager against this tree.
  if (!opts.trust.repoExecutionAllowed) {
    return finish({
      outcome: 'refused',
      plan,
      applied: [],
      note:
        'refused: repo execution is not allowed under this trust context ' +
        `(${opts.trust.source}) — the bump lane runs on the default branch only.`,
    });
  }
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    return finish({
      outcome: 'refused',
      plan,
      applied: [],
      note: 'refused: no package.json at the repo root — the apply lane is node-first.',
    });
  }

  // The $0 landing preflight (#286): when this run intends to LAND, probe
  // the standing branch's delivery preconditions BEFORE applying anything —
  // a branch-creation ruleset that will 403 the push is knowable from one
  // API read. Only POSITIVE refusal evidence refuses; an unanswerable probe
  // proceeds (the preflight never invents a refusal).
  if (opts.land === 'pr') {
    const preflight = (opts.probeDelivery ?? probeDeliveryPreconditions)(cwd, {
      branches: [DEP_BUMP_BRANCH],
    });
    const blocked = preflight.probes.find((p) => p.verdict === 'blocked');
    if (blocked) {
      return finish({
        outcome: 'refused',
        plan,
        applied: [],
        note:
          `landing-unavailable (preflight, $0 — nothing was applied): ` +
          `${describeDeliveryProbe(blocked)}`,
      });
    }
  }

  const pm = detectPackageManager(cwd);
  const execBump = opts.execBump ?? defaultExecBump(cwd);
  const runFloor =
    opts.runFloor ??
    (() =>
      runCorrectnessFloor({
        cwd,
        changedFiles: bumpArtifactPaths(pm),
        scope: 'full',
        packs: detectActiveLanguages(cwd),
      }));

  // ENTRY floor, captured on the PRISTINE tree before any bump: the base side
  // of the attribution comparator. A repo whose floor is already red must not
  // have that debt weaponized against the bump — only a NET-NEW failure
  // blocks (the loop Stop-gate's entry-snapshot doctrine, same comparator).
  const entryFloor = runFloor();

  const applied: AppliedBump[] = [];
  for (const bump of plan.bumps) {
    const argv = upgradeArgv(pm, bump.parent, bump.toVersion, sectionFor(cwd, bump.parent));
    let r = execBump(argv);
    // A repo whose tree only resolves under --legacy-peer-deps (a peer
    // conflict its own install already tolerates) must not fail the bump —
    // the same fallback doctrine as every shipped `npm ci || npm ci
    // --legacy-peer-deps` install step: the flag only skips the peer check
    // that rejects the tree, it never fabricates a different resolution.
    if (!r.ok && pm === 'npm' && /ERESOLVE|peer dep/i.test(r.output)) {
      r = execBump([...argv, '--legacy-peer-deps']);
    }
    applied.push({
      ...bump,
      applied: r.ok,
      // Single-line tail: this lands in a markdown table cell.
      ...(r.ok ? {} : { failure: r.output.slice(-300).replace(/\s+/g, ' ').trim() }),
    });
  }
  const anyApplied = applied.some((b) => b.applied);
  if (!anyApplied) {
    return finish({
      outcome: 'refused',
      plan,
      applied,
      note: 'every bump failed to apply — see per-bump failures.',
    });
  }

  // Verify: the floor at FULL scope (a dependency change alters resolution
  // for every file), attributed against the entry snapshot through the ONE
  // base-check projection (shared with the remediate lane).
  const floor = runFloor();
  const baseChecks: FloorBaseCheck[] = toFloorBaseChecks(entryFloor);
  const floorAttribution = attributeFloorFailures(floor, baseChecks, {
    // The entry floor always ran (just above), so an absent base check means
    // the check itself is NEW post-bump — treat as net-new (conservative).
    absentMeans: 'net-new',
  });
  const netNewFloorRed = floorAttribution.some((a) => a.attribution === 'net-new');

  // Guardrail via the one lane helper. This lane deliberately keeps its
  // shipped fail-OPEN posture on an unrunnable check (`ran: false` still
  // lands): the diff is manifest+lockfile only, and the PR's own required
  // dxkit-guardrails check is the backstop. The agent lane fails CLOSED —
  // the declared policy difference lives at each consumer.
  let guardrailVerdict: string | undefined;
  if (opts.runGuardrail) {
    guardrailVerdict = await opts.runGuardrail();
  } else {
    guardrailVerdict = (await guardrailVerdictFor(cwd, opts.trust)).verdict;
  }

  if (netNewFloorRed) {
    return finish({
      outcome: 'floor-red',
      plan,
      applied,
      floor,
      floorAttribution,
      ...(guardrailVerdict !== undefined ? { guardrailVerdict } : {}),
      note:
        'the correctness floor has NET-NEW failures after applying the bumps (the entry ' +
        'floor did not have them) — nothing was landed. A bump that breaks the build ' +
        'must be a human decision, not a robot PR.',
    });
  }

  if (opts.land !== 'pr') {
    return finish({
      outcome: 'applied',
      plan,
      applied,
      floor,
      floorAttribution,
      ...(guardrailVerdict !== undefined ? { guardrailVerdict } : {}),
    });
  }

  const partial = {
    outcome: 'applied' as const,
    plan,
    applied,
    floor,
    floorAttribution,
    ...(guardrailVerdict !== undefined ? { guardrailVerdict } : {}),
  };
  // The delivery-ledger event rides the SAME PR diff as the bumps, so it
  // reaches the default branch exactly when the PR merges — delivered means
  // MERGED, never "a PR was opened" (design §10; the ungameable-count rule).
  const advisoriesClosed = applied
    .filter((b) => b.applied)
    .reduce((n, b) => n + b.advisories.length, 0);
  const ledgerRel = appendLaneEvent(cwd, {
    schema_version: LANE_LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    lane: 'dep-bump',
    outcome: 'landed',
    findingsClosed: [{ kind: 'dep-vuln', count: advisoriesClosed }],
  });
  const defaultBranch = detectDefaultBranch(cwd);
  const land = (opts.landPaths ?? landRefreshPaths)({
    cwd,
    mode: 'pr',
    paths: [...bumpArtifactPaths(pm), ledgerRel],
    branchName: DEP_BUMP_BRANCH,
    defaultBranch,
    commitTitle: 'chore(deps): security bumps (dxkit)',
    prTitle: 'dxkit: dependency security bumps',
    // The ONE lane PR-body assembler (#288): labeled generated narrative on
    // top, the ledger verbatim below. The bump changes are UNCOMMITTED at
    // assembly time (the lander commits them), so today this renders
    // ledger-only via the fail-open path — the wiring keeps both landers on
    // the one assembler, and the ledger already itemizes every bump.
    prBody: assembleLanePrBody({ cwd, ledger: renderLedger(partial), base: defaultBranch }),
  });
  return finish({
    ...partial,
    outcome: outcomeFromLand(land),
    land,
    ...(land.note !== undefined ? { note: land.note } : {}),
  });
}

/**
 * The lane's top-level outcome derives from the LAND result — ONE derivation,
 * so the surface can never say "landed" over a disclosed non-delivery (the
 * false-"landed" class: branch pushed, PR creation refused by the repo's
 * Actions settings, job green, prUrl empty, remedy buried in unread JSON).
 */
function outcomeFromLand(land: LandRefreshResult): DepsBumpResult['outcome'] {
  switch (land.outcome) {
    case 'pr-opened':
    case 'pr-updated':
    case 'pushed':
      return 'landed';
    case 'branch-pushed-no-pr':
      return 'branch-pushed-no-pr';
    case 'clean':
      // Nothing to commit after an apply — defensively "applied", never a
      // delivery claim.
      return 'applied';
  }
}
