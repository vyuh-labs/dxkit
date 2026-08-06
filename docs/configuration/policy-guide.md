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

| Policy path                         | Guide section                                |
| ----------------------------------- | -------------------------------------------- |
| `baseline.anchor`                   | [#baseline-anchor](#baseline-anchor)         |
| `baseline.mode`                     | [#baseline-mode](#baseline-mode)             |
| `baseline.refreshCadence`           | [#refresh-cadence](#refresh-cadence)         |
| `checks`                            | [#custom-checks](#custom-checks)             |
| `depBump.allowMajor`                | [#dep-bump](#dep-bump)                       |
| `depBump.enabled`                   | [#dep-bump](#dep-bump)                       |
| `depBump.schedule`                  | [#dep-bump](#dep-bump)                       |
| `duplication.mode`                  | [#duplication-mode](#duplication-mode)       |
| `expiryNotice.enabled`              | [#expiry-notice](#expiry-notice)             |
| `flow.mode`                         | [#flow-mode](#flow-mode)                     |
| `flow.sources`                      | [#flow-sources](#flow-sources)               |
| `graph.refresh`                     | [#graph-refresh](#graph-refresh)             |
| `licenses.prohibited`               | [#prohibited-licenses](#prohibited-licenses) |
| `lint.blocking`                     | [#lint-gate](#lint-gate)                     |
| `lint.enabled`                      | [#lint-gate](#lint-gate)                     |
| `loop.preset`                       | [#loop-preset](#loop-preset)                 |
| `newAdvisories.blockSeverities`     | [#new-advisories](#new-advisories)           |
| `newAdvisories.commentCommands`     | [#new-advisories](#new-advisories)           |
| `pairedChecks`                      | [#paired-change-rules](#paired-change-rules) |
| `remediate.agent.budget.maxMinutes` | [#remediate-budget](#remediate-budget)       |
| `remediate.agent.budget.maxTurns`   | [#remediate-budget](#remediate-budget)       |
| `remediate.agent.budget.maxUsd`     | [#remediate-budget](#remediate-budget)       |
| `remediate.agent.driver`            | [#remediate-driver](#remediate-driver)       |
| `remediate.agent.model`             | [#remediate-model](#remediate-model)         |
| `remediate.enabled`                 | [#remediate](#remediate)                     |
| `remediate.salvage`                 | [#remediate-salvage](#remediate-salvage)     |
| `remediate.schedule`                | [#remediate-schedule](#remediate-schedule)   |
| `remediate.tasks`                   | [#remediate-tasks](#remediate-tasks)         |
| `reports.onMerge`                   | [#reports-on-merge](#reports-on-merge)       |
| `schema.mode`                       | [#schema-mode](#schema-mode)                 |

<!-- END GENERATED: knob-index -->

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

**What it does.** The fate of budget-cut partial work: `"discard"` (the
default — nothing lands; the branch is left for inspection) or
`"draft-pr"` (the VERIFIED partial work lands as a draft marked
budget-bounded).

**Default and why.** `discard`. Production experience: partial drafts were
useful once and noise once — exactly a default-off opt-in.

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

**What it does.** Hard caps, all enforced by the runner, never the agent's
self-report.

**Per parameter.**

- `maxTurns` — the agent iteration cap (passed to the driver when it
  supports one). Symptom of too low: repeated `budget-exhausted` outcomes
  with verified partial work. Symptom of too high: long runs that wander
  past the task.
- `maxMinutes` — the wall-clock kill. Work the agent already COMMITTED is
  salvage territory (see [salvage](#remediate-salvage)); uncommitted work
  is swept into a loudly-labeled commit for inspection.
- `maxUsd` — the spend cap, read from the run's spend envelope. A driver
  that cannot report spend makes this cap unenforceable — the ledger says
  so explicitly rather than pretending.

**Default and why.** `80 turns / 30 min / $5` — conservative on purpose.
Widen a cap only for a task that keeps producing verified-but-cut-short
work; the progression is conservative → confident, never the reverse.
