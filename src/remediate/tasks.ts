/**
 * The remediate task registry — dxkit-authored prompts ONLY (the managed
 * lane never runs user-supplied free text; that is the comment-defer trust
 * analysis applied one level up). Ported from the production remediation
 * script's task menu, with its scars kept: the baseline-refresh ban, the
 * budget economy rules, the stop-and-write-notes escape hatch.
 *
 * Each task declares its `tier` BESIDE its prompt (one registry — a new task
 * cannot ship without declaring what capability it needs), in dxkit's
 * driver-neutral vocabulary. Nothing declares `deep`: that spend decision is
 * the repo's, made explicitly by pinning `agent.model`.
 */
import type { ModelTier } from './driver';
import { dxkitCli } from '../self-invocation';

/** How a prompt tells the agent to invoke dxkit inside the TARGET repo:
 *  the local install first, the canonical binary invocation as fallback
 *  (built from the one Rule 14 helper, never a scattered literal). */
function dxkitInRepo(subcommand: string): string {
  return `\`./node_modules/.bin/vyuh-dxkit ${subcommand}\` (fall back to \`${dxkitCli(subcommand)}\`)`;
}

export type RemediateTaskId =
  | 'fix-build'
  | 'fix-vulns'
  | 'fix-lint'
  | 'improve-tests'
  | 'write-docs';

/** Health dimensions a score hinge may reference (the report's keys). */
export type HingeDimension =
  | 'testing'
  | 'quality'
  | 'documentation'
  | 'security'
  | 'maintainability'
  | 'developerExperience';

export interface RemediateTask {
  readonly id: RemediateTaskId;
  readonly summary: string;
  /** Auto model tier (driver-neutral) + the reason, rendered into the guide
   *  table at docs-generation time (E5) — never hand-copied. */
  readonly tier: ModelTier;
  readonly tierWhy: string;
  /** The dxkit-authored agent prompt. A constant, never interpolated with
   *  user input. */
  readonly prompt: string;
  /** Which verification the outcome hinges on (both always run; this names
   *  the primary signal for the ledger). */
  readonly verify: 'floor' | 'guardrail';
  /**
   * OPTIONAL deterministic score hinge (4.3.4). The lane's law is that a task
   * ships only when "done" is re-verifiable without reading prose — and for
   * work whose whole point is a dimension moving (docs), the floor and
   * guardrail are necessary but prove nothing about the goal. A hinge makes
   * the goal itself part of the verified frame: the `improve` dimension's
   * score must END STRICTLY HIGHER than the pristine-tree entry score, and
   * every `holdSteady` dimension must not drop — else the outcome is
   * `score-red` and nothing lands. Both sides are computed by the same
   * deterministic scorer in the same environment, so the delta is fair even
   * where absolute scores are degraded (a missing scanner degrades both
   * sides equally).
   */
  readonly scoreHinge?: {
    readonly improve: HingeDimension;
    readonly holdSteady: readonly HingeDimension[];
  };
}

/** Ground rules appended to every task prompt — the non-negotiables. */
export const SHARED_RULES = `
Ground rules (non-negotiable):
- Work ONLY on this task. Do not fix unrelated debt, do not refactor beyond
  what the task needs, do not touch CI/workflow files.
- NEVER run \`vyuh-dxkit baseline create\` or edit \`.dxkit/baselines/\` — the
  gate must attribute your work honestly, and refreshing the baseline to
  clear a block is forbidden.
- Commit your work in logical units with clear messages. Leave the working
  tree CLEAN (everything committed) when you finish.
- Use the repo's local dxkit CLI (./node_modules/.bin/vyuh-dxkit, or npx
  vyuh-dxkit) to check your progress as you go.
- Be economical with your budget: the debt inventory already tells you WHERE
  the problems are — read the files it names instead of exploring broadly,
  and re-run the single failing command, not the whole suite, while
  iterating (one full confirmation run at the end is enough).
- If the task turns out to be impossible or unsafe (e.g. a fix requires a
  credential or a product decision), STOP, commit nothing further, and write
  docs/DXKIT-REMEDIATION-NOTES.md explaining exactly what a human must decide.
`;

export const REMEDIATE_TASKS: readonly RemediateTask[] = [
  {
    id: 'fix-build',
    summary: 'fix the grandfathered broken build / failing tests (floor debt)',
    tier: 'standard',
    tierWhy: 'real diagnosis + repair across build config and test code',
    verify: 'floor',
    prompt:
      `Run ${dxkitInRepo('debt --json')}.
Your task is the CORRECTNESS FLOOR section only: make the failing checks pass.
Fix the build first (nothing else is measurable until it compiles), then the
failing tests. Use each check's \`command\` to reproduce and its \`output\` to
diagnose. Fix code/config for real — do not skip, delete, or weaken tests to
make them pass; if a test is genuinely obsolete, explain why in its commit
message. When you believe you are done, re-run the failing commands and then
\`vyuh-dxkit debt\` to confirm the floor section is clean.` + SHARED_RULES,
  },
  {
    id: 'fix-vulns',
    summary: 'remediate baselined dependency vulnerabilities the bump lane could not close',
    tier: 'standard',
    tierWhy: 'cross-file reasoning; majors can require real code changes',
    verify: 'guardrail',
    prompt:
      `Run \`./node_modules/.bin/vyuh-dxkit debt --json\` and \`vyuh-dxkit vulnerabilities\`.
Your task is the dependency-vulnerability findings: upgrade or patch the
affected dependencies, preferring the smallest safe version bumps. After each
bump, run the repo's install and its tests (or the affected subset) to prove
no behavior broke. Prefer fixing reachable + high/critical advisories first.
If an advisory has no fixed release, note it in docs/DXKIT-REMEDIATION-NOTES.md
instead of forcing a major upgrade.
Resolution-tree guard (a dependency change can break files you never touched):
run the repo's production build (or its closest compile step) BEFORE your first
change and again after your last one, and compare the module-resolution errors
- your change must add NONE. Overrides and dedupe can un-hoist a package that
source files import without declaring (a phantom dependency); if you find one,
declare it explicitly in the manifest. Note both build outputs (or their diff)
in docs/DXKIT-REMEDIATION-NOTES.md so the reviewer sees what was compared.` + SHARED_RULES,
  },
  {
    id: 'fix-lint',
    summary: 'burn down the grandfathered lint backlog, oldest and highest-signal first',
    tier: 'light',
    tierWhy: 'mechanical, pattern-per-finding work',
    verify: 'guardrail',
    prompt:
      `Run \`./node_modules/.bin/vyuh-dxkit debt --json\` (fall back to \`npx
vyuh-dxkit debt --json\`) and review the custom-check (lint) findings — the
repo's grandfathered lint backlog. Fix the underlying code, file by file:
NEVER disable a rule, add an inline suppression, or edit the lint config to
make a finding disappear — if a rule is genuinely wrong for this repo, write
the case in docs/DXKIT-REMEDIATION-NOTES.md for a human to decide. Re-run the
repo's lint command after each file to confirm the count only goes down, and
run the affected tests before you finish — a lint fix that changes behavior
is a bug, not a cleanup.` + SHARED_RULES,
  },
  {
    id: 'improve-tests',
    summary: 'add real behavioral tests for the highest-risk untested surfaces',
    tier: 'standard',
    tierWhy: 'design judgment about behavior worth pinning, not boilerplate',
    verify: 'floor',
    prompt:
      `Run ${dxkitInRepo('test-gaps --json')}. Work the CRITICAL bucket top-down, then
HIGH as budget allows: for each listed file, READ it first, then write tests
that pin its observable behavior — real inputs, real assertions on outputs and
error paths, not snapshot padding or trivial "renders without crashing" fill.
A test suite that exists but is empty or always-green is debt, not coverage:
give the empty/broken suites real tests or delete them with the reason in the
commit message. Every test you add must pass, and the suite must run clean
before you finish (\`vyuh-dxkit debt\` floor section stays clean). Do NOT lower
coverage thresholds or edit test configuration to inflate numbers.` + SHARED_RULES,
  },
  {
    id: 'write-docs',
    summary: 'write the documentation the repo is missing, verified by the score',
    tier: 'standard',
    tierWhy: 'grounded technical writing over real code, not boilerplate',
    verify: 'guardrail',
    scoreHinge: { improve: 'documentation', holdSteady: ['quality'] },
    prompt:
      `Run ${dxkitInRepo('health --json')} and read the Documentation dimension's
deductions — they name exactly what is missing (README sections, docstring
coverage, architecture notes). Work the largest deductions first. READ the
real code before documenting it, then write documentation that is TRUE of
this codebase: a README whose commands and layout match reality, docstrings
that say what a function does and WHY it exists (never a restatement of the
signature), architecture notes grounded in the actual module structure. No
filler prose and no generated-sounding padding — the Quality dimension's
slop metrics are part of your verification, and vague boilerplate fails it.
Never document behavior you have not read. Verification is deterministic:
the Documentation score must END HIGHER than it started while Quality does
not drop — cosmetic edits that move nothing are rejected, not landed.` + SHARED_RULES,
  },
];

const byId = new Map(REMEDIATE_TASKS.map((t) => [t.id, t]));

export function remediateTaskById(id: string): RemediateTask | undefined {
  return byId.get(id as RemediateTaskId);
}

export function knownTaskIds(): readonly string[] {
  return REMEDIATE_TASKS.map((t) => t.id);
}
