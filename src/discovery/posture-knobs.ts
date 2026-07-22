/**
 * The posture-knob discovery registry (CLAUDE.md Rule 16 — the config-knob
 * layer). Rule 16's command-scoped enforcement (cli.ts ↔ COMMANDS parity +
 * user-facing field completeness) guarantees a COMMAND is discoverable, but NOT
 * that an opt-in CONFIG KNOB a command gates is reachable through the discovery
 * surfaces — `configure` (via `planConfig`) and `doctor` / `capabilities` (via
 * `whenToRecommend`). That gap shipped the seam gate's `duplication.mode`
 * discovery-invisible until it was caught by hand (fixed in `b5a4db4`).
 *
 * A discovery-invisible knob is not a cosmetic miss: an agent onboarding a repo
 * via `capabilities --json` never learns the gate exists, so `configure --apply`
 * omits it and the repo is silently under-initialized — the exact failure the
 * "five minutes to trust" funnel cannot afford.
 *
 * So this registry names every posture / opt-in knob and declares — per knob —
 * which discovery probes its owning command MUST carry. `checkPostureKnobCoverage`
 * turns that into a mechanical assertion (pinned by
 * `test/discovery-posture-playbook.test.ts`, synthetic-injection-guarded), so a
 * new gate cannot ship discovery-invisible on human DoD alone. A knob that
 * deliberately carries no probe is a DECLARED exemption with a reason (mirror of
 * Rule 16's `internal` audience and Rule 10's `DEFERRED_KINDS`), never a silent
 * omission.
 */
import { userCommands } from './commands';
import type { CapabilityDescriptor } from './command-types';

/**
 * One opt-in / posture config knob and the discovery contract its owning
 * command must satisfy. `requiresPlan` / `requiresRecommend` say which probes
 * are REQUIRED (a knob must be reachable through at least one surface, or carry
 * an `exemptionReason`). `note` documents a deliberate partial choice (e.g. a
 * knob recommend-able but not auto-plannable) — informational, not enforced.
 */
export interface PostureKnob {
  /** The policy path the knob lives at (e.g. `duplication.mode`) — audit +
   *  documentation anchor. */
  readonly path: string;
  /** The owning user-facing command id (must be a registered `user` command). */
  readonly command: string;
  /** Must the owning command expose a `planConfig` (reachable via `configure`)? */
  readonly requiresPlan: boolean;
  /** Must the owning command expose a `whenToRecommend` (surfaced by `doctor`
   *  + `capabilities`)? */
  readonly requiresRecommend: boolean;
  /** REQUIRED when the knob requires neither probe: why it is a deliberate
   *  exemption, not a discovery gap. */
  readonly exemptionReason?: string;
  /** Optional rationale for a partial contract (e.g. recommend-only, no plan). */
  readonly note?: string;
}

/**
 * THE registry. One entry per opt-in / posture knob. Guardrail-TUNING fields
 * (`confidence`, `blockRules`, `addedRequiresChangedLines`, `largeFileThreshold`)
 * are intentionally absent — they refine an already-adopted gate's behavior,
 * they are not capabilities a repo opts INTO, so they carry no onboarding
 * discovery contract.
 */
export const POSTURE_KNOBS: readonly PostureKnob[] = [
  {
    path: 'duplication.mode',
    command: 'quality',
    requiresPlan: true,
    requiresRecommend: true,
  },
  { path: 'flow.mode', command: 'flow', requiresPlan: true, requiresRecommend: true },
  { path: 'flow.sources', command: 'extensions', requiresPlan: true, requiresRecommend: true },
  { path: 'schema.mode', command: 'schema', requiresPlan: true, requiresRecommend: true },
  { path: 'lint', command: 'checks', requiresPlan: true, requiresRecommend: true },
  {
    path: 'checks',
    command: 'checks',
    requiresPlan: false,
    requiresRecommend: true,
    note: 'user invariants are repo-specific — dxkit cannot author a check command for the user, so no planConfig; recommendChecks surfaces wiring a detected linter into the gate.',
  },
  { path: 'baseline.mode', command: 'baseline', requiresPlan: true, requiresRecommend: true },
  {
    path: 'baseline.anchor',
    command: 'baseline',
    requiresPlan: false,
    requiresRecommend: false,
    exemptionReason:
      'the anchor transport auto-derives from effective branch protection (classifyEnforcement) at publish time — not a user posture dxkit plans or recommends; documented under "Anchor transport" in policy.md.',
  },
  { path: 'loop.preset', command: 'loop', requiresPlan: true, requiresRecommend: true },
  {
    path: 'newAdvisories.blockSeverities',
    command: 'guardrail',
    requiresPlan: false,
    requiresRecommend: true,
    note:
      'the default tier (critical/high block, medium/low warn) is right regardless of any ' +
      'repo-observable fact, so a planConfig would only ever emit the default — no plan; ' +
      'recommendNewAdvisoryTier surfaces the knob once a run has concretely blocked a newly ' +
      'published advisory.',
  },
  {
    path: 'reports.onMerge',
    command: 'report',
    requiresPlan: false,
    requiresRecommend: true,
    note: 'enabling installs the dxkit-reports-refresh managed workflow, which configure’s policy-only merge-write cannot place — so no planConfig; recommendReportsOnMerge surfaces it once the repo is actively gating.',
  },
  {
    path: 'graph.refresh',
    command: 'update',
    requiresPlan: false,
    requiresRecommend: false,
    exemptionReason:
      'a CI-performance transport (graph.json Actions-cache), not a gate/posture — rebuild-on-demand is the correct default and changes no finding, so there is no behavioral difference to recommend. Installed by init/update when set to "cache"; documented in policy.md.',
  },
  {
    path: 'deepSast',
    command: 'ingest',
    requiresPlan: false,
    requiresRecommend: false,
    exemptionReason:
      'a manual pull requiring an external engine + token — dxkit never selects an engine or token for the user, so it is not an auto-plannable posture. The ingest command + dxkit-ingest skill own setup.',
  },
];

/** A knob whose owning command does not satisfy its declared discovery contract. */
export interface KnobCoverageGap {
  readonly path: string;
  readonly command: string;
  readonly problem: string;
}

/**
 * Assert every posture knob's owning command carries the probes the knob
 * requires. Pure over its inputs (registry injectable for the synthetic-injection
 * test). Returns the gaps; an empty array means full coverage.
 */
export function checkPostureKnobCoverage(
  knobs: readonly PostureKnob[] = POSTURE_KNOBS,
  registry: readonly CapabilityDescriptor[] = userCommands(),
): KnobCoverageGap[] {
  const gaps: KnobCoverageGap[] = [];
  const byId = new Map(registry.map((c) => [c.id, c]));
  for (const knob of knobs) {
    const cmd = byId.get(knob.command);
    if (!cmd) {
      gaps.push({
        path: knob.path,
        command: knob.command,
        problem: `owning command '${knob.command}' is not a registered user-facing command`,
      });
      continue;
    }
    if (knob.requiresPlan && !cmd.planConfig) {
      gaps.push({
        path: knob.path,
        command: knob.command,
        problem: `requires a planConfig probe (reachable via 'configure') but command '${knob.command}' has none`,
      });
    }
    if (knob.requiresRecommend && !cmd.whenToRecommend) {
      gaps.push({
        path: knob.path,
        command: knob.command,
        problem: `requires a whenToRecommend probe (surfaced by 'doctor'/'capabilities') but command '${knob.command}' has none`,
      });
    }
    if (!knob.requiresPlan && !knob.requiresRecommend && !knob.exemptionReason?.trim()) {
      gaps.push({
        path: knob.path,
        command: knob.command,
        problem:
          'requires neither probe but declares no exemptionReason — a fully-exempt knob must justify why it is invisible, not omit silently',
      });
    }
  }
  return gaps;
}
