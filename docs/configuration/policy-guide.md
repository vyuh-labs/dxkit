# The policy guide — every knob, taught

This is the TEACHING companion to [policy.md](policy.md) (the reference).
Every `policy-guide#…` anchor in your scaffolded `.dxkit/policy.json` and in
the editor hover text lands on a section here. Each section follows one
template: what the knob does, its default and why, when you would change it,
per-parameter tuning, an example, and interactions.

Your policy file is JSONC: comments and trailing commas are welcome, and
dxkit's own tools preserve them. Uncommenting a scaffold stanza IS
activation. Knobs that shipped after your file was scaffolded appear with
`vyuh-dxkit policy sync` (dry-run; `--apply` appends them as commented
stanzas).

## Knob index

<!-- BEGIN GENERATED: knob-index (edit the registry, then: npm run build && npm run docs:policy-guide) -->

| Policy path                         | Guide section                                            |
| ----------------------------------- | -------------------------------------------------------- |
| `baseline.anchor`                   | [#baseline-anchor](#baseline-anchor)                     |
| `baseline.mode`                     | [#baseline-mode](#baseline-mode)                         |
| `baseline.refreshCadence`           | [#refresh-cadence](#refresh-cadence)                     |
| `checks`                            | [#custom-checks](#custom-checks)                         |
| `depBump.allowMajor`                | [#dep-bump](#dep-bump)                                   |
| `depBump.enabled`                   | [#dep-bump](#dep-bump)                                   |
| `depBump.schedule`                  | [#dep-bump](#dep-bump)                                   |
| `duplication.mode`                  | [#duplication-mode](#duplication-mode)                   |
| `expiryNotice.enabled`              | [#expiry-notice](#expiry-notice)                         |
| `extends`                           | [#policy-base](#policy-base)                             |
| `floor.required`                    | [#floor-required](#floor-required)                       |
| `flow.mode`                         | [#flow-mode](#flow-mode)                                 |
| `flow.sources`                      | [#flow-sources](#flow-sources)                           |
| `graph.refresh`                     | [#graph-refresh](#graph-refresh)                         |
| `licenses.prohibited`               | [#prohibited-licenses](#prohibited-licenses)             |
| `lint.blocking`                     | [#lint-gate](#lint-gate)                                 |
| `lint.enabled`                      | [#lint-gate](#lint-gate)                                 |
| `loop.preset`                       | [#loop-preset](#loop-preset)                             |
| `newAdvisories.blockSeverities`     | [#new-advisories](#new-advisories)                       |
| `newAdvisories.commentCommands`     | [#new-advisories](#new-advisories)                       |
| `pairedChecks`                      | [#paired-change-rules](#paired-change-rules)             |
| `remediate.agent.budget.maxMinutes` | [#remediate-budget](#remediate-budget)                   |
| `remediate.agent.budget.maxTurns`   | [#remediate-budget](#remediate-budget)                   |
| `remediate.agent.budget.maxUsd`     | [#remediate-budget](#remediate-budget)                   |
| `remediate.agent.driver`            | [#remediate-driver](#remediate-driver)                   |
| `remediate.agent.model`             | [#remediate-model](#remediate-model)                     |
| `remediate.enabled`                 | [#remediate](#remediate)                                 |
| `remediate.maxDispatchBudget`       | [#remediate-dispatch-budget](#remediate-dispatch-budget) |
| `remediate.maxSpendPerRun`          | [#remediate-spend-per-run](#remediate-spend-per-run)     |
| `remediate.resume`                  | [#remediate-resume](#remediate-resume)                   |
| `remediate.salvage`                 | [#remediate-salvage](#remediate-salvage)                 |
| `remediate.schedule`                | [#remediate-schedule](#remediate-schedule)               |
| `remediate.taskBudgets`             | [#remediate-task-budgets](#remediate-task-budgets)       |
| `remediate.tasks`                   | [#remediate-tasks](#remediate-tasks)                     |
| `reports.onMerge`                   | [#reports-on-merge](#reports-on-merge)                   |
| `schema.mode`                       | [#schema-mode](#schema-mode)                             |

<!-- END GENERATED: knob-index -->

## Policy base

**What it does.** `"extends"` names the posture this file REFINES:
`"security-only"`, `"full-debt"`, or `"default"` (the fully armed compiled
default). Your file's fields merge over that base — a three-line file with
`"extends": "security-only"` is a complete, predictable DoD.

**Default and why.** Absent means `"default"` — the pre-4.4.1 merge base,
kept so existing files resolve byte-identically. But absent is a footgun
for new files: a minimal policy silently inherits every armed rule of the
compiled default, including test-gap and quality blocking a security-posture
DoD never asked for. The scaffold writes the base explicitly; `doctor`
recommends pinning it when a committed file omits it.

**When you would change it.** Every hand-written file should declare it.
Embedding pipelines and agent-gate DoDs usually want `"security-only"`;
`"full-debt"` is the strict posture where any net-new finding blocks.

**Tuning.** An unknown value is a load ERROR, never a silent fallback — a
typo'd base changing which rules are armed is the exact class the field
exists to close. `vyuh-dxkit policy show` renders the resolved result with
per-rule provenance.

## Baseline mode

**What it does.** Pins how the guardrail finds its "before" side —
`committed-full` (a committed baseline file), `committed-sanitized`
(committed, secrets stripped), or `ref-based` (re-gathered from a git ref
per check).

**Default and why.** init resolves it from repo visibility: private repos
get `committed-full` (fast, offline, complete), public repos get
`ref-based` (nothing sensitive is committed). `committed-sanitized` is
never auto-picked — it is the explicit opt-in for compliance-conscious
private repos.

**When you would change it.** Moving a private repo public (switch to
`ref-based` or `committed-sanitized`); a monorepo whose ref-based gathers
are too slow (switch to committed).

**Tuning.** `baseline.ref` names the comparison ref in ref-based mode
(default: the default branch).

**Interactions.** Custom checks and lint gate only in committed modes — a
throwaway worktree lacks the toolchain, so ref-based mode would false-flag
the whole backlog.

## Refresh cadence

**What it does.** How often the baseline-refresh workflow runs:
`"weekly"`, `"daily"`, or a raw 5-field cron line.

**Default and why.** Weekly (Monday 06:00 UTC) — the refresh is an advisory
decision surface, not a gate; weekly keeps its PRs boring.

**When you would change it.** A repo under active dependency churn wants
`"daily"`; a quiet archive wants a monthly cron (`"0 6 1 * *"`).

**Tuning.** A malformed cron falls back to weekly, never breaks the
workflow. The same grammar drives [remediate schedule](#remediate-schedule).

## Baseline anchor

**What it does.** The transport the baseline anchor uses in CI (`tree`,
`cache`, …). Auto-derived from effective branch protection at publish time.

**When you would change it.** Almost never by hand — `baseline publish`
picks it. It is documented here so the value in your file is explicable,
not because it wants tuning.

## Flow mode

**What it does.** The UI-to-API integration gate: blocks a change that
breaks a route some consumer still calls (catch-all-aware, cross-repo
capable).

**Default and why.** The scaffold suggests `warn` — see the break reports
before letting them block. init may set `block` where the repo's flow
signals are strong.

**When you would change it.** Escalate to `block` once a week of warnings
shows no false positives. `off` only for a repo with no HTTP surface.

**Tuning.** `flow.specs` adds served contracts from OpenAPI files;
`flow.stripUrlPrefixes` normalizes gateway prefixes (the classic 3-line fix
that closes most false "unresolved call" reports); `flow.blockThreshold`
sets the confidence a break needs to block.

**Interactions.** `flow.onMergeRefresh` + `vyuh-dxkit update` installs the
contract-refresh workflow.

## Flow sources

**What it does.** Joins extension-declared call sources (your own
extractors, HAR captures, Postman collections) into the consumed side of
the flow model.

**When you would change it.** Your calls are built through a bespoke client
the built-in extractors cannot see — write or declare an extension (the
dxkit-extensions skill walks it) and list its id here.

## Schema mode

**What it does.** The data-model drift gate: blocks a model change that
breaks the declared wire contract (removed field, tightened optionality).

**Default and why.** `warn` first, same escalation logic as
[flow mode](#flow-mode).

**Tuning.** `schema.specs` points at OpenAPI / JSON Schema documents so
unmarked DTOs (or languages without a pack extractor) participate too.

## Duplication mode

**What it does.** Flags net-new copy-paste across the change (the seam
gate) — the block pair must clear `duplication.minScore` similarity.

**Default and why.** Off until opted in; `warn` is the recommended posture.
Copy-paste is a judgment call more often than a defect, so it should get a
reviewer's eye before it gets a blocker's teeth.

## Lint gate

**What it does.** Runs the pack-declared linter as a first-class gate
citizen: net-new lint errors surface on the PR while the pre-existing
backlog stays grandfathered.

**Default and why.** `enabled: true, blocking: false` in the scaffold —
visibility first. `lint.blocking: true` makes net-new errors block.

**When you would change it.** Turn `blocking` on once the team trusts the
signal. Never to enforce a NEW ruleset — land the ruleset change first, let
the backlog grandfather, then gate.

**Interactions.** The lint gate runs in committed baseline modes only (see
[baseline mode](#baseline-mode)). The agentic
[fix-lint task](#remediate-tasks) burns down the grandfathered backlog.

## Custom checks

**What it does.** Your own repo invariants as gate citizens — an
architecture script, a license audit, any command. Located (regex) parses
give per-finding identity so only NET-NEW failures block; binary (exit)
checks grandfather whole.

**Default and why.** Empty — a repo that configures nothing spawns nothing.

**When you would change it.** You have a repo rule you currently enforce by
review comment. Prefer `parse: { regex }` for linter-shaped output.

**Security.** Commands run from THIS committed file only — review edits to
`checks[].command` like CI config changes.

**Required observation.** `checks[].required: true` makes a check's
OBSERVATION part of the verdict contract: if the check did not run
(untrusted tree, missing toolchain, ref-based mode), the verdict is
`CANNOT GATE` with the cause and remedy named — never a disclosed skip
under a PASSED banner. Orthogonal to `blocking`, which decides what a
net-new FAILURE does once the check ran. Default false: an optional
check that cannot run keeps the skip-and-disclose behavior.

## Floor required

**What it does.** Makes the correctness floor ("does it compile, do its
tests pass") a verdict REQUIREMENT on the `gate` command family. When the
floor cannot run — the tree is untrusted and `--trusted` was not passed —
the gate answers `CANNOT GATE` (exit 2) instead of certifying a tree whose
compile and tests it never saw.

**Default and why.** `true` on the gate surface — the gate's product
promise is refusing to certify what it did not observe, and the one-shot
gate has no CI backstop behind it. The loop Stop-gate, pre-push, and CI
floor surfaces are NOT governed by this knob: they keep their declared
fail-open-on-infrastructure doctrine, because a slow or missing toolchain
must not wedge an unattended loop and CI is their backstop.

**When you would change it.** Set `"floor": { "required": false }` in an
embedding pipeline that gates untrusted trees on findings only and runs
the compile/test floor elsewhere — the skip stays disclosed in the verdict
either way.

## Paired change rules

**What it does.** "Changing X requires also changing Y" — a model change
must ship with its migration, an API change with its docs. Declarative over
the diff (deletions count); nothing is spawned, so it gates on every
surface including fork PRs.

**Default and why.** Empty — the if/then surfaces are repo conventions only
you know; dxkit inferring them would recommend wrong pairings confidently.

**Example.**

```jsonc
"pairedChecks": [
  { "name": "model-needs-migration",
    "if": ["src/models/**"], "then": ["migrations/**"],
    "message": "a data-model change ships with its migration" }
]
```

**Tuning.** For norms about NEW artifacts, use `ifAdded` instead of (or
beside) `if`: it triggers only when the change ADDED a matching file, so
editing an existing one never over-demands the companion. A rule needs at
least one of `if` / `ifAdded`, plus `then`.

```jsonc
"pairedChecks": [
  { "name": "component-needs-guide",
    "ifAdded": ["src/components/**"], "then": ["docs/guides/**"],
    "message": "a new component ships with a guide" }
]
```

When the added-file set cannot be computed for a run, an `ifAdded` clause
is not evaluated (it never fires blind) and the skip is disclosed in the
gate output.

## Prohibited licenses

**What it does.** Blocks a net-new dependency whose license matches a
prefix in `licenses.prohibited` (SPDX terms, compound expressions split).

**Default and why.** Empty. Which licenses your business prohibits is a
legal posture — dxkit never picks the list for you; the licenses report +
BOM give you the inventory to decide from.

## New advisories

**What it does.** Posture for advisories published AFTER your baseline was
captured — new knowledge about old code, so it gets its own tier instead of
reading as "you introduced this".

**Default and why.** `blockSeverities: ["critical", "high"]` — the default
tier is right regardless of repo shape; medium/low warn.

**Tuning.** `newAdvisories.commentCommands: true` lets reviewers defer an
advisory from the PR conversation (`/dxkit defer …`); enabling installs a
managed workflow — run `vyuh-dxkit update` after.

## Dep bump

**What it does.** The scheduled deterministic dependency-bump lane: fix
versions from the scanners themselves (no LLM, no key), applied with your
own package manager, verified by the correctness floor + guardrail, landed
as ONE standing PR (`dxkit/dep-bump`).

**Default and why.** Off. `depBump.enabled: true` + `vyuh-dxkit update`
installs the weekly workflow.

**Tuning.** `depBump.allowMajor: true` lets the lane cross major versions —
leave it off unless your suite is strong; a scheduled robot PR should be
boring to merge.

**Interactions.** What the bump lane cannot close (no fixed release,
breaking-not-allowed) is exactly the [remediate lane's](#remediate) input.

## Expiry notice

**What it does.** While the scheduled baseline refresh is running anyway, it
maintains ONE GitHub issue naming the allowlist suppressions whose windows
close within the next 14 days: the finding, its kind, the severity the
reviewer acknowledged, who accepted it (`addedBy`), the date, and the
countdown. One issue, updated in place — and closed automatically once
nothing is lapsing.

**Default and why.** Off. `expiryNotice.enabled: true` + `vyuh-dxkit update`
grants the refresh workflow `issues: write` and turns the lane on. It is the
only dxkit lane that opens an issue on its own initiative, so it is never
enabled for you.

**When you would turn it on.** The [lapse projection](#new-advisories) already
warns every author and reviewer on every guardrail check, which covers any
week somebody opens a PR. Turn this on if your repo can go quiet for days at a
time — that is the case where a deferral lapses with nobody watching and the
next PR author inherits findings they never touched.

**Tuning.** None. The horizon is the same 14 days
[`allowlist audit`](../reference/cli.md) uses, so the issue and the check never
disagree about which entries are in scope. If your
[refresh cadence](#refresh-cadence) is slower than 14 days, the first notice
can arrive late — the issue body says so rather than pretending otherwise.

**Interactions.** It never gates: no verdict, no exit code, no block. The
expiry remains the forcing function. Owners are NAMED from `addedBy`, never
assigned — `addedBy` is an email address, and guessing a GitHub login from an
email would put a stranger's name on someone else's deferral. If issues are
disabled or the token lacks the permission, the refresh reports why and carries
on; a notification that could not be posted must never fail a baseline capture.

## Reports on merge

**What it does.** Publishes report snapshots to the `dxkit-reports` ref on
every merge — the score-over-time series `vyuh-dxkit metrics` renders.

**Default and why.** Off; enabling installs a managed workflow (`update`).

## Graph refresh

**What it does.** The code-graph CI transport. Set to `cache`, `update`
installs the managed `dxkit-graph-refresh` workflow, which rebuilds
`graph.json` on a schedule and stores it in the Actions cache so gated
runs skip the rebuild. `off` (or absent) means rebuild-on-demand.

**Default and why.** Absent (rebuild-on-demand) — the transport changes no
finding, only CI wall-clock, so nothing recommends it proactively. Set it
with `vyuh-dxkit policy set graph.refresh cache` and run
`vyuh-dxkit update` to install the workflow.

## Loop preset

**What it does.** What blocks an autonomous coding loop from declaring
done: `security-only` (net-new secrets, crit/high security, reachable dep
vulns) or `full-debt` (all net-new debt).

**Default and why.** `security-only` — an unattended loop should be stopped
by real hazards, not style debt.

## Remediate

**What it does.** The scheduled agentic remediation lane: an agent works
the debt the deterministic lanes cannot close, INSIDE the verified frame —
entry-attributed correctness floor + guardrail run before any PR opens, and
the agent's own claim of success is never trusted. One standing PR per
task; the body is the verification ledger + the agent envelope (model,
turns, spend, outcome).

**Default and why.** Off. An agent that spends money is never silently
enabled — not by dxkit, not by `configure --apply`. Enable with
`remediate.enabled: true` + `vyuh-dxkit update`, then set the driver's
credential secret (see the [driver table](#remediate-driver)) — a scoped
key with a spend limit, never a personal key.

**When you would change it.** The baseline grandfathers a broken floor or
advisories the bump lane cannot version-solve, and you want a budgeted,
verified robot working the backlog on a schedule.

**Example.**

```jsonc
"remediate": {
  "enabled": true,
  "tasks": ["fix-vulns"],
  "schedule": "weekly",
  "agent": {
    "driver": "claude-code",
    "model": "auto",
    "budget": { "maxTurns": 80, "maxMinutes": 30, "maxUsd": 5 }
  }
}
```

**Interactions.** Local runs (`vyuh-dxkit remediate --task …`) work without
`enabled` — the knob gates the UNATTENDED workflow only. Preview everything
with `vyuh-dxkit remediate plan` (no key, no spend).

## Remediate tasks

**What it does.** Which registry tasks the scheduled lane works. Each task
is a dxkit-authored prompt (never free text in the managed lane) with a
declared capability tier.

<!-- BEGIN GENERATED: remediate-task-tiers (edit the registry, then: npm run build && npm run docs:policy-guide) -->

| Task            | Auto tier  | Why this tier                                                 |
| --------------- | ---------- | ------------------------------------------------------------- |
| `fix-build`     | `standard` | real diagnosis + repair across build config and test code     |
| `fix-vulns`     | `standard` | cross-file reasoning; majors can require real code changes    |
| `fix-lint`      | `light`    | mechanical, pattern-per-finding work                          |
| `improve-tests` | `standard` | design judgment about behavior worth pinning, not boilerplate |
| `write-docs`    | `standard` | grounded technical writing over real code, not boilerplate    |

<!-- END GENERATED: remediate-task-tiers -->

**Default and why.** `["fix-vulns"]` — the highest-value, best-verified
task. Add tasks one at a time; each gets its own standing PR.

## Remediate schedule

**What it does.** The managed workflow's cadence: `"weekly"`, `"daily"`, or
a 5-field cron — the same grammar as [refresh cadence](#refresh-cadence),
so "weekly" means the same thing on every scheduled surface.

**Default and why.** Weekly. An agent lane earns a faster cadence by
merging boring PRs, not by default.

## Remediate salvage

**What it does.** The fate of budget-cut or guardrail-blocked partial work.
Three accepted values:

- `"auto"` (default): decided PER TASK from its declared completion shape.
  Open-ended tasks (`write-docs`, `improve-tests`) have no completion test,
  so every run of theirs ends on a cap; they resolve to `draft-pr` so their
  verified work is not structurally thrown away. Bounded tasks (`fix-build`,
  `fix-vulns`, `fix-lint`) can genuinely finish, so they resolve to
  `discard`.
- `"discard"`: nothing lands for any task; the branch is left for
  inspection.
- `"draft-pr"`: for every task, VERIFIED partial work lands as a draft
  marked budget-bounded; a guardrail-blocked attempt lands as a red draft
  titled "do not merge", kept unmergeable by its own guardrail check.

**Default and why.** `auto`. A single default was wrong in one direction
or the other: `discard` threw away every open-ended run's gate-passing
work, `draft-pr` turned every bounded run's cut-off into review noise.
Pin one value only when you want the same fate for every task.

**Interactions.** `vyuh-dxkit remediate plan` prints the effective
salvage per task. [Resume](#remediate-resume) requires the effective
per-task salvage to be `draft-pr`.

## Remediate driver

**What it does.** Which agent CLI runs the task. Drivers are registry
entries; each declares its tier mapping, which budget caps it can enforce,
and the credential env var the workflow wires from repo secrets.

<!-- BEGIN GENERATED: remediate-drivers (edit the registry, then: npm run build && npm run docs:policy-guide) -->

| Driver        | light   | standard | deep   | Enforces                 | Credentials         |
| ------------- | ------- | -------- | ------ | ------------------------ | ------------------- |
| `claude-code` | `haiku` | `sonnet` | `opus` | turns, spend, wall-clock | `ANTHROPIC_API_KEY` |

<!-- END GENERATED: remediate-drivers -->

**Default and why.** `claude-code` — the one shipped driver. An unknown
driver id is a disclosed refusal naming the known drivers, never a silent
fallback.

## Remediate model

**What it does.** How the agent's model is chosen. Three accepted shapes:

- `"auto"` (default) — each task resolves its registry tier (see the
  [task table](#remediate-tasks)) through the driver's tier mapping.
- a tier name (`"light"` | `"standard"` | `"deep"`) — pins all tasks to
  that tier; portable across drivers. Nothing selects `deep` automatically;
  that spend decision is yours.
- anything else — a driver-native model id passed through verbatim, with a
  warning when unrecognized. A native pin is per-driver, and a dated id
  will eventually deprecate; prefer tiers.

**Which concrete model will a run use?** That is a runtime fact no document
can state honestly (vendors roll their aliases between dxkit releases):
`vyuh-dxkit remediate plan` shows your repo's exact resolution chain before
any spend, and the PR ledger records the concrete id each run actually
used.

## Remediate budget

**What it does.** The shared caps for every task, read by the runner,
never from the agent's self-report. Which caps a driver can actually
ENFORCE mid-run is a per-driver fact (the "Enforces" column of the
[driver table](#remediate-driver)); a cap the driver cannot enforce is
disclosed in the plan and the ledger, never silently assumed.

**Per parameter.**

- `maxTurns`: the agent iteration cap, passed to the driver when it
  supports one (the shipped driver enforces it). Symptom of too low:
  repeated `budget-exhausted` outcomes with verified partial work. Symptom
  of too high: long runs that wander past the task.
- `maxMinutes`: the wall-clock kill, enforced by the runner as the process
  timeout. Work the agent already COMMITTED is salvage territory (see
  [salvage](#remediate-salvage)); uncommitted work is swept into a
  loudly-labeled commit for inspection.
- `maxUsd`: the spend cap. Enforced only where the driver can stop a run
  on cost. The shipped driver REPORTS spend after the run and cannot stop
  mid-run, so there `maxUsd` is advisory: an overrun is disclosed and the
  attempt marked partial, and real spend is bounded by `maxTurns` and
  `maxMinutes` (which is why the dispatch authority clamps turns, see
  [dispatch budget](#remediate-dispatch-budget)). A driver that cannot
  report spend at all makes the cap unenforceable, and the ledger says so.

**Default and why.** `80 turns / 30 min / $5` — conservative on purpose.
Widen a cap only for a task that keeps producing verified-but-cut-short
work; the progression is conservative → confident, never the reverse.
Per-task headroom belongs in [task budgets](#remediate-task-budgets), not
in a wider shared cap.

## Remediate task budgets

**What it does.** `remediate.taskBudgets.<task-id>` is a partial
`{ maxTurns, maxMinutes, maxUsd }` merged over the shared
[agent budget](#remediate-budget) for that one task. Unset fields inherit;
a non-positive value is ignored, not zeroed. Only registered task ids take
an override; the `custom` dispatch task always runs on the shared budget.

**Default and why.** Empty: every task runs on the shared caps. Use it to
give a diagnosis-heavy task (`fix-build`) headroom without widening a
mechanical one (`fix-lint`).

**Example.**

```jsonc
"remediate": {
  "agent": { "budget": { "maxTurns": 60, "maxMinutes": 20, "maxUsd": 3 } },
  "taskBudgets": { "fix-build": { "maxTurns": 120, "maxUsd": 8 } }
}
```

**Interactions.** The per-task effective budget is what
[spend per run](#remediate-spend-per-run) sums and what
`vyuh-dxkit remediate plan` prints.

## Remediate spend per run

**What it does.** `remediate.maxSpendPerRun` is a run-level USD ceiling
over the per-task matrix: each enabled task is its own job with its own
cap, so one scheduled firing may spend the SUM of the effective per-task
`maxUsd` values. Tasks are admitted in declaration order while their caps
still fit under the ceiling; the rest are deferred to the next firing and
named in the run output, never silently dropped.

**Default and why.** `0` (no ceiling). The per-task caps already bound each
job; set a ceiling when the sum across tasks is what your budget owner
cares about. Because the sum uses the caps (not actual spend), a ceiling
below the first task's cap defers everything.

**Interactions.** Sums the effective per-task budget after
[task budgets](#remediate-task-budgets). The ceiling reads the `maxUsd`
CAPS, so it holds even where the driver cannot enforce spend mid-run.

## Remediate dispatch budget

**What it does.** `remediate.maxDispatchBudget` is the spend authority for
one-off `workflow_dispatch` campaigns: the most a dispatch override may
raise `maxUsd` to. The same authority clamps a `max_turns` override
proportionally against the policy budget, because turns are what bound
real spend when the driver only reports cost after the run (see
[budget](#remediate-budget)); an unclamped turn override would be a back
door around the ceiling.

**Default and why.** `0` (undeclared): a dispatch can LOWER budgets but
never raise them beyond the committed policy caps. Spend authority grows
only in a reviewed policy change, never in a workflow form field.

**Interactions.** Clamping is disclosed in the run output and the PR body
along with the dispatcher and the verbatim prompt.

## Remediate resume

**What it does.** With `remediate.resume: true` the next run of a task
CONTINUES from its prior salvage branch (a draft PR left by a
budget-bounded or guardrail-blocked attempt) instead of starting over. A
resumed attempt after a guardrail block gets the prior blocking findings
in its prompt. Attempts are capped at 2 per branch (the counter travels
with the branch, so a no-op resume still consumes one); at the cap the
task falls back to a fresh run. The entry floor still snapshots the
pristine default tree first, so a broken partial reads as net-new and can
never grandfather its own breakage.

**Default and why.** `false`. Resume only helps when the prior attempt
left verified, reviewable progress; on a run that sprawled, it re-anchors
on the sprawl. Enable it per repo once a task is producing partial drafts
worth continuing.

**Interactions.** Requires the effective per-task
[salvage](#remediate-salvage) to be `draft-pr` (the default for
open-ended tasks under `auto`); a task whose salvage is `discard` has no
branch to resume and starts fresh.

## Remediate work orders

**What it does.** `vyuh-dxkit remediate plan` cuts the finding sets dxkit
already computes (the entry floor's failures, deferred advisories inside
their window, the grandfathered lint backlog) into finite work orders and
lists them with their class, tier, budget, and done criterion. Today this is
a plan surface: the tasks still run their existing prompts. Task selection
over orders (each task working only the orders of its classes) arrives with
the executor unit, which consumes these same orders.

**Per parameter.**

- `maxSliceSize`: the largest number of findings one debt work order may
  carry. Lint debt is cut by file, then by rule, into slices of at most this
  size, and each slice's budget derives from its size. Symptom of too high:
  orders whose derived budget hits the task cap. Symptom of too low: many
  tiny orders, each paying the fixed cost of an agent turn-up.

**Default and why.** `25`: a slice one agent session closes with headroom
in the derived budget.
