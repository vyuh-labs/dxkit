---
name: dxkit-onboard
description: Walk a customer through setting up dxkit on a repo from scratch — checks state, installs, scaffolds, configures hooks, runs doctor, fixes any gaps, captures the first baseline, sets up branch protection + Codespaces prebuild. Also drives a DETERMINISTIC deep-configuration pass — it runs `vyuh-dxkit configure --plan`, which COMPUTES the config each capability should take from observable repo facts (not the agent's judgment, so the same repo yields the same plan every run), shows it, gets confirmation, then `configure --apply` merge-writes it into policy.json without clobbering existing settings. The plan is registry-driven, so new capabilities join it automatically as dxkit grows. Use when the user asks "set me up", "install dxkit on this repo", "I want to use dxkit", "walk me through dxkit setup", "help me get started with dxkit", "configure dxkit for this repo", "what should I set up", or anything about onboarding or fully configuring a repo. Asks for confirmation at each step with sensible defaults; hands off to dxkit-fix mid-flow when doctor surfaces gaps.
---

# dxkit-onboard

This skill drives the FULL new-customer journey end-to-end. It's the "I have nothing — set me up" surface (complement to `dxkit-update` for existing-install upgrades and `dxkit-fix` for repairs).

Unlike the other dxkit-* skills which are each scoped to a single domain (install / config / hooks / etc.), dxkit-onboard orchestrates across them. It dispatches into `dxkit-init` for flag choices, `dxkit-fix` for gap closure, `dxkit-hooks` for hook deep-dives — composing a single coherent customer conversation.

## When to use this skill

Use when:

- "Set me up"
- "Install dxkit on this repo"
- "I want to use dxkit"
- "Walk me through dxkit setup"
- "Help me get started with dxkit"
- "First time using dxkit"

Don't use when:

- Customer already has `.vyuh-dxkit.json` AND is asking about a specific task (use the focused skill — dxkit-reports, dxkit-action, etc.)
- Customer wants to UPGRADE an existing install (use `dxkit-update`)
- Something is broken (use `dxkit-fix`)

## The onboarding journey

```
[1] State check       → is dxkit installed? scaffold present? baseline captured? hooks active?
[2] Install if needed → npm init @vyuhlabs/dxkit OR npx vyuh-dxkit init --full --yes
                        (init auto-offers the UI→API integration gate when it
                         detects client calls + routes — pick a posture then)
[3] Doctor            → npx vyuh-dxkit doctor (parse summary.fixable[])
[4] Fix gaps          → dispatch through dxkit-fix for each fixable signal
[5] Capture baseline  → npx vyuh-dxkit baseline create (with explicit secrets-warning)
[6] Deep configure    → configure --plan → confirm → --apply (DETERMINISTIC; computed, not chosen)
[7] Pre-commit ASK    → opt-in based on repo size (>500 files: default no)
[8] Postinstall chain → opt-in to auto-activate hooks for teammates
[9] Branch protection → ASK to run vyuh-dxkit setup-branch-protection
[10] Codespaces prebuild → ASK to run vyuh-dxkit setup-prebuild (if customer uses Codespaces)
[11] Final verify     → re-run doctor; show green; surface any remaining gaps
```

Each step ASKS the customer with a sensible default — never silent execution. The customer can decline any step; default behavior shouldn't surprise them.

## Steps

### 1. State check

Before recommending anything, snapshot the customer's current state:

```bash
# Does the manifest exist?
test -f .vyuh-dxkit.json && echo "has-manifest" || echo "fresh"

# Is dxkit on PATH?
command -v vyuh-dxkit && echo "binary-on-path" || echo "binary-missing"

# Is the workspace a git repo?
git rev-parse --is-inside-work-tree 2>/dev/null && echo "git-ok" || echo "not-a-repo"
```

Branch the conversation on the result:

- **Fresh repo (no manifest)**: go to step 2 (install)
- **Manifest exists**: this customer already onboarded. Pivot: "Looks like dxkit is already installed. Are you trying to upgrade (→ dxkit-update) or fix something (→ dxkit-fix)?"
- **Not a git repo**: stop. "dxkit needs a git repo. Run `git init` first, then come back."

### 2. Install if needed

For a fresh install, the canonical command is:

```bash
npm init @vyuhlabs/dxkit
```

This runs `create-dxkit` which installs `@vyuhlabs/dxkit` as a devDep and then runs `npx vyuh-dxkit init --full --yes` (which scaffolds everything: skills, AGENTS.md, CLAUDE.md, devcontainer, hooks, CI workflows).

Before running, ASK:

- **"Full install (recommended)?"** — yes runs the above; no asks for flag choices and routes through `dxkit-init`'s decision tree.

Optional flags worth surfacing if the customer pushes back on "full":

- `--with-dxkit-agents` — just the dxkit-* skills (no hooks, no CI)
- `--with-hooks --with-dxkit-agents` — skills + pre-push hook
- `--with-precommit-hook` — also pre-commit (slow on large repos)

If the customer wants more granularity, hand off to `dxkit-init` for the full flag explanation.

### 3. Doctor

After install, run:

```bash
npx vyuh-dxkit doctor --json > /tmp/dxkit-onboard-doctor.json
```

Parse `summary.fixable[]`. Most fresh-install gaps will be operational (hooks not yet activated by postinstall trigger; baseline not captured yet; etc.) rather than scaffold-missing.

Also read `recommendations[]` — doctor's advisor mode surfaces capabilities this repo would benefit from but isn't using yet (each with a `reason` grounded in the repo and the `command` to run). Fold these into the walkthrough: they are how you propose the *right* next capabilities instead of a generic checklist. For the full menu of what dxkit can set up, read `npx vyuh-dxkit capabilities --json` (every capability + the dxkit-* skill that drives it) and offer the ones that fit.

### 4. Fix gaps

For each fixable signal in doctor's output, dispatch through `dxkit-fix`'s recovery loop. Most common fresh-install gaps:

- `git hooks active` not active → `npx vyuh-dxkit hooks activate`
- `baseline captured` missing → defer to step 5 (we'll handle that explicitly with the secrets warning)
- `vyuh-dxkit on PATH` missing → `npm install -g @vyuhlabs/dxkit` (a global install — it affects every Node project on the machine and may need elevated permissions; a project-local install or a Node version manager works too)
- `scanner toolchain` incomplete → `npx vyuh-dxkit tools install --yes`

Don't auto-execute baseline capture here — step 5 has a values-laden warning that needs explicit customer confirmation.

### 5. Capture baseline (carefully)

This is the step with permanent consequences. The baseline records the fingerprint of every finding currently in the repo and tells future scans "these are pre-existing — don't block on them."

Before running `baseline create` on a fresh customer, ASK about disclosure posture (the baseline file is committed to git):

> **About to capture the first baseline. One quick choice first — which posture fits this repo?**
>
> The baseline file lives at `.dxkit/baselines/main.json`. Three modes trade disclosure for diagnostic richness:
>
> - **`committed-full`** (default for private repos) — Rich entries with file paths, package names, advisory IDs. Best diagnostic quality. Fine when only your team reads the repo.
> - **`committed-sanitized`** (compliance-conscious private) — Stripped to fingerprint + kind only. Hides location detail; matching still works. Good when many people have repo read access.
> - **`ref-based`** (default for public repos) — No baseline file at all. Each guardrail check recomputes the prior side from a git ref (e.g. `origin/main`). Zero disclosure.
>
> Auto-pick: run `vyuh-dxkit baseline create` and dxkit picks the right default by probing `gh repo view`. Or pin explicitly via `--mode=<X>` or `.dxkit/policy.json`.

Then the standard "lock-in" warning:

> **About to capture the first baseline.**
>
> This locks in ALL current findings as "pre-existing" — they won't block future PRs. If your repo has real secrets, vulnerable deps, or other defects you'd want to fix FIRST, tell me and I'll show you what's flagged so we can triage before baseline.
>
> Capture baseline now if: codebase is known-messy brownfield and you want guardrails on FUTURE regressions specifically.
>
> Skip baseline now if: you have secrets in the repo, or you'd rather fix-as-you-go than accept the current state.

If they want to triage first, hand off to `dxkit-action` — that skill prioritizes findings before baseline lock-in. Come back to step 5 after triage.

If they confirm baseline (and they're happy with auto-picked mode):

```bash
npx vyuh-dxkit baseline create
git add .dxkit/baselines/   # only if mode wrote a file (committed-*)
git commit -m "chore: capture dxkit baseline"
```

**Multi-environment stacks (4.0):** if the repo's stack declares capabilities this machine cannot run (the flagship: a Windows-only `net*-windows` build — `baseline create` will say "not measurable in this environment" for those slices), that is expected, not a failure. The local capture records what THIS machine observed and records the rest as unobserved (never as "clean"); the generated `dxkit-baseline-refresh` workflow completes the picture on merge — its `capture-<host>` job runs the placed checks on the right runner and merges their slice into the committed baseline. Also tell the user to mark the generated `dxkit-gate-<host>` job a **required PR check** alongside `dxkit-guardrails` (branch-protection step). The old workaround of setting `correctness.surfaces.ci: false` for a non-Linux stack is obsolete — the floor now routes itself.

If they want to PIN the mode explicitly (so every developer + CI run agrees), write `.dxkit/policy.json`:

```bash
mkdir -p .dxkit
cat > .dxkit/policy.json <<'JSON'
{
  "baseline": {
    "mode": "ref-based",
    "ref": "origin/main"
  }
}
JSON
git add .dxkit/policy.json
git commit -m "chore: pin baseline mode in policy.json"
```

### 6. Deep configuration — the deterministic, registry-driven pass

Beyond the operational wiring above, dxkit has per-capability configuration —
what the guardrail blocks on, the loop posture, the flow-gate posture, the schema-gate posture, whether
the lint gate is on, and so on. The right value for each is not a matter of
taste; it follows from observable facts about the repo. So dxkit **computes**
it — the decision lives in code (`vyuh-dxkit configure`), not in your judgment
or mine. That is what makes this pass reproducible: **the same repo yields the
same plan on every run and in every environment.** Your job here is to drive
the plan → confirm → apply loop, not to decide the values.

**Why this matters (don't hand-configure policy.json instead):** if you were to
eyeball the repo and hand-pick, say, a baseline mode, two people (or the same
person on two days) could pick differently, and CI could disagree with a laptop.
The planner removes that: it reads the facts once and every consumer agrees.

Run the plan first — it writes nothing:

```bash
npx vyuh-dxkit configure --plan          # human-readable
npx vyuh-dxkit configure --plan --json   # machine-readable (for you to parse)
```

Each line of the plan carries the value, the reason, and the **evidence** — the
concrete fact(s) that forced it (e.g. `visibility=public`, `linter config
present, no lint policy yet`). Present the plan to the customer in plain terms:
"Based on this repo, dxkit will set X to Y because Z. Apply it?"

- **The registry drives it.** The plan walks every capability the registry
  exposes (`capabilities --json` is the same source), so as dxkit grows, new
  capabilities appear in the plan automatically — you never maintain a checklist.
- **It's a floor, not a ceiling.** The planner seeds each capability at its
  *safe* default (flow `warn`, schema `warn`, lint `warn-only`, the
  visibility-derived baseline mode). Stricter postures (flow `block`, schema
  `block`, lint `blocking`) are a deliberate later choice — hand off to the
  capability's own skill (dxkit-flow, dxkit-schema,
  dxkit-checks, dxkit-loop) when the customer wants to tighten one. Each plan
  item names its driving `skill` for exactly this.
- **Nothing to do is a valid outcome.** On a repo that's already configured (or
  has no signal), the plan is empty — say so and move on.

On confirmation, apply it. The write is a **merge** — every existing key in
`.dxkit/policy.json` is preserved (a hand-tuned severity block, a custom check
you already declared); only the planned sections are added:

```bash
npx vyuh-dxkit configure --apply
git add .dxkit/policy.json
git commit -m "chore: configure dxkit policy for this repo"
```

Apply is **idempotent** — re-running is a clean no-op, because each planner goes
silent once its section is pinned. Commit the file so every developer and CI
share the posture.

**Relay the computed values; don't reinterpret them.** The plan's value, reason,
and evidence come from code — present them as-is. Do not substitute your own
judgment for a computed value, soften it, or "improve" it in prose. Your role is
to relay the plan and carry the customer's *explicit* decisions (a deliberate
override, a declined section) — not to decide the values yourself. This is what
keeps the outcome model-independent: the same repo gets the same config whether
this conversation runs on one model or another, because neither model is choosing
the values.

**Never hand-edit policy.json to "configure" a capability the planner covers** —
run `configure` so the value stays computed and reproducible. Hand-editing is
for a deliberate override *after* the plan (e.g. bumping flow to `block`), and
even then the capability's own skill (dxkit-flow, dxkit-schema, dxkit-checks, dxkit-loop) is
the better path.

**Enforce it in CI.** `vyuh-dxkit configure check` exits non-zero when a
recommended section is missing from policy.json — so if any agent (on any model)
hand-edited around the planner and left a gap, or a newly-shipped capability
hasn't been configured, CI catches it. Offer to wire it into the guardrail
workflow for teams that want the invariant enforced, not just available.

### 7. Pre-commit ASK

Pre-commit is opt-in even under `--full` because it re-runs every analyzer on every commit (~1-3 min on 500+ file repos). Most teams skip it.

ASK:

> **Add pre-commit hook?** Default no. Pre-commit catches regressions before commit (vs pre-push catching them before push). Tradeoff: ~1-3 min wall-clock on every commit for a 500+ file repo. Most teams accept the pre-push-only model.

Default recommendation by repo size:
- `find . -type f -name "*.ts" -o -name "*.py" -o -name "*.go" 2>/dev/null | wc -l` < 200 → default Yes
- > 500 → default No
- In between → ask without a strong default

If yes, run `npx vyuh-dxkit init --with-precommit-hook --yes` to add the pre-commit hook.

### 8. Postinstall chain

If the customer's `package.json` already has a `postinstall` script (most non-trivial repos do — patch-package, husky, monorepo bootstrap), dxkit won't auto-chain its hook activation into it. Teammates who clone the repo and run `npm install` won't get hooks wired automatically.

ASK:

> **Chain dxkit-hooks-activate into your existing postinstall?** Default yes. Without this, teammates who clone won't get hooks wired automatically.
>
> Current postinstall: `<read from package.json>`
> Proposed: `<current> && vyuh-dxkit hooks activate`

If yes, hand off to `dxkit-hooks` for the actual edit (it knows the safe append pattern + how to deal with sidecar files).

### 9. Branch protection ASK

Local hooks are fast feedback; CI is the unbypassable enforcement. Branch protection wires CI as a required status check — without it, the dxkit-guardrails workflow is informational and PRs can merge even when it fails.

ASK:

> **Configure branch protection now?** Default yes. This **modifies your GitHub repository settings** — it adds `dxkit-guardrails` as a required status check on `<default branch>`, and so needs admin permission on the repo. Without it, the CI workflow is informational — PRs can merge even on guardrail failures.

If yes:

```bash
npx vyuh-dxkit setup-branch-protection
```

If the customer isn't a repo admin (HTTP 403), surface the manual UI path: Settings → Branches → Add rule → Require status checks → check `dxkit-guardrails`. Or ask their repo admin to run the command.

### 10. Codespaces prebuild ASK

Only relevant if the customer's team uses Codespaces. ASK:

> **Does your team use GitHub Codespaces?** [Y/N]
>
> If yes: configuring a prebuild drops cold-start from ~7 min to ~30s. Trivial to set up; storage costs ~$3-5/month per region.

If yes:

```bash
npx vyuh-dxkit setup-prebuild
```

Same admin-permission caveat as step 8.

### 11. Final verify

Re-run doctor:

```bash
npx vyuh-dxkit doctor
```

Report the results:

- **All green** → "You're fully set up. dxkit will guard your next push. Run `vyuh-dxkit health` whenever you want to see scores."
- **Remaining fixable gaps** → hand off to `dxkit-fix` for each one. Don't end with broken signals.

If the customer plans to run **autonomous Claude Code loops** (the agent works unattended until it decides to stop), mention the loop pack as an optional add-on: `npx vyuh-dxkit init --claude-loop` registers a Stop-gate that won't let a loop finish while it has introduced net-new findings. It's opt-in (it registers a hook that blocks the agent from stopping), so offer it rather than installing it by default — and hand off to **dxkit-loop** to set it up and pick a posture.

## What dxkit-onboard can NOT do

- **Auto-decide values-laden questions** — baseline lock-in (step 5), pre-commit opt-in (step 6), postinstall chaining (step 7), branch protection (step 8) all require explicit customer confirmation. Never silently execute these.
- **Fix repos that aren't git repos** — surface the "git init first" step and stop.
- **Triage code findings** — that's `dxkit-action`. Hand off when the customer wants to evaluate findings before baseline.
- **Install on a non-Node project** — dxkit can still scan non-Node projects but `npm init @vyuhlabs/dxkit` needs Node + npm. Surface the requirement; offer global install path as a fallback.

## Boundary with other lifecycle skills

| Customer state | Reach for |
|---|---|
| "I have nothing" | **dxkit-onboard (this skill)** |
| "I have working install, make it newer" | `dxkit-update` |
| "Doctor says X is broken" | `dxkit-fix` |
| "Run a report" | `dxkit-reports` |
| "Fix code findings" | `dxkit-action` |
| "Edit dxkit configuration" | `dxkit-config` |
| "Set up / troubleshoot hooks" | `dxkit-hooks` |
| "Explain dxkit concepts" | `dxkit-learn` |
| "Choose init flags" | `dxkit-init` |

When in doubt, dxkit-onboard handles the full first-install journey and delegates to focused skills for sub-decisions. After step 10, the customer should never need dxkit-onboard again — they'd reach for dxkit-update (newer dxkit), dxkit-fix (broken signal), or one of the work skills (reports/action/config/hooks).

## Final report

```
✓ Fresh dxkit install complete:
   • Binary: 2.5.X installed globally + project-local
   • Scaffold: dxkit-* skills, AGENTS.md, CLAUDE.md, devcontainer, hooks, CI workflows
   • Doctor: 14/14 (Reports + Agent DX + Operational health)
   • Baseline: N findings locked in (or "skipped — you're triaging first")
   • Pre-commit: yes/no (your choice)
   • Postinstall chain: yes/no (your choice)
   • Branch protection: configured / declined / failed (admin permission)
   • Codespaces prebuild: configured / declined / N/A
```

End with a one-line CTA: "Try it: edit a file, `git push`, and watch the hook fire. Or ask 'run health' to see your dxkit scores."
