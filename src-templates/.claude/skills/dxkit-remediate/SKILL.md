---
name: dxkit-remediate
description: Set up and operate the agentic remediation lane — preview which model each task resolves to, run a task locally inside the verified frame, enable the scheduled workflow, read the outcome ledger, and tune the budget. Use when the user says "set up automated remediation", "have an agent fix the backlog", "why did the remediation run fail", "what will remediate cost", "the remediate PR is a draft, why", or anything about the scheduled agent lane. For deterministic dependency bumps (no agent), defer to the deps bump lane; for one-off interactive fixes, dxkit-action.
---

# dxkit remediate — the agentic remediation lane

An agent works the debt the deterministic lanes cannot close (the
grandfathered build/tests, advisories a version bump cannot fix, the lint
backlog, missing tests) INSIDE dxkit's verified frame: an entry-attributed
correctness floor and the guardrail run before any PR opens, and the agent's
own claim of success is never trusted. One standing PR per task; the PR body
is the verification ledger plus the agent envelope (model, turns, spend,
outcome).

## Preview before spending anything

```bash
vyuh-dxkit remediate plan
```

Shows, per configured task, the full model resolution chain (task → tier →
driver-native model), the budget caps and which ones the driver can enforce,
and whether the agent CLI resolves here. No key needed, no network, no spend.

Model settings (`remediate.agent.model`):
- `auto` (default) — each task uses its registry tier: light for mechanical
  work (fix-lint), standard for reasoning work (fix-build, fix-vulns,
  improve-tests). Tiers map to the driver's rolling aliases, so they never
  break when a model generation rolls over.
- a tier name (`light` | `standard` | `deep`) — pins all tasks; portable
  across drivers. `deep` is the most capable and most expensive; nothing
  selects it automatically.
- anything else — a driver-native model id passed through verbatim (a
  driver switch may invalidate it; a dated id will eventually deprecate).

## Run one task locally (human present)

```bash
vyuh-dxkit remediate --task fix-lint            # run + verify, no PR
vyuh-dxkit remediate --task fix-vulns --land pr # land the standing PR
```

Local runs work without `remediate.enabled` (that knob gates the SCHEDULED
workflow). With no API key in the environment, the claude-code driver uses
your `claude` subscription login.

## Enable the scheduled lane

1. In `.dxkit/policy.json`, uncomment / add the `remediate` stanza
   (`enabled: true`, pick `tasks`, `schedule`, budget).
2. `vyuh-dxkit update` — installs the `dxkit-remediate` workflow.
3. Set the `ANTHROPIC_API_KEY` repo secret — use a scoped workspace key
   with a spend limit, never a personal key.

The workflow triggers on schedule + manual dispatch ONLY, runs against the
default branch only, with dxkit-authored prompts only.

## Reading an outcome

- `verified` / a green PR — the diff passed the entry-attributed floor and
  the guardrail. Pre-existing debt listed in the ledger was already failing
  before the agent ran; it is disclosed, not the agent's doing.
- `no-op` — the agent ran and committed nothing; the job summary says so.
- `floor-red` — the agent's change introduced a net-new floor failure; no
  PR was opened, on purpose. The ledger names the failing checks.
- `guardrail-red` — the guardrail blocked, refused to gate, or could not
  run. Nothing lands (the agent lane fails CLOSED on verification: an
  agent-authored diff is never pushed unverified); the change stays local
  for inspection and the ledger says which case it was.
- `budget-exhausted`: a cap hit (wall-clock, turns, or spend). What
  lands follows the effective salvage for the task: `salvage` defaults to
  `auto`, which resolves open-ended tasks (`write-docs`, `improve-tests`)
  to `draft-pr` (verified partial work lands as a DRAFT marked
  budget-bounded) and bounded tasks (`fix-build`, `fix-vulns`, `fix-lint`)
  to `discard` (nothing lands; the branch stays for inspection). Pin
  `"discard"` or `"draft-pr"` in policy to force one fate for every task.
- `agent-never-ran` — infrastructure (auth, missing CLI); the reason is in
  the note. Fix the secret/install, re-dispatch.
- `sweep-failed` — the agent committed work, but the leftovers it left
  uncommitted could not be swept into a reviewable commit (a pre-commit
  hook, a signing requirement). Nothing lands: those files are staged, and
  landing would push them unreviewed. The note names the git error.
- `refused` — a trust or configuration refusal, with the remedy named.

## Tuning the budget

`remediate.agent.budget`: `maxTurns` caps agent iterations (enforced by the
shipped driver), `maxMinutes` is the wall-clock kill (enforced by the
runner; salvage applies), `maxUsd` is the spend cap. The shipped driver only
REPORTS spend after the run and cannot stop mid-run on cost, so there
`maxUsd` is advisory: an overrun is disclosed and the attempt marked
partial, and real spend is bounded by turns and wall-clock. `remediate plan`
lists which caps the configured driver cannot enforce. Start conservative
(the defaults), widen only for a task that keeps hitting `budget-exhausted`
while producing verified work; give one task headroom with
`remediate.taskBudgets.<id>` rather than widening the shared cap, and bound
a whole firing with `remediate.maxSpendPerRun`.
