---
name: dxkit-flow
description: Configure, diagnose, and repair the dxkit UI→API integration gate — set up flow gating, explain the flow-contract diagnosis, fix a net-new broken integration a guardrail flagged, and run the cross-repo handshake. Use when the user says "set up the flow gate", "why is this call unresolved", "the guardrail says I broke an integration", "a route was removed but something still calls it", "wire up flow across repos", "publish the flow contract", or anything about the UI→API integration gate.
---

# dxkit-flow

This skill owns the **UI→API integration gate**: dxkit statically reconstructs which client calls (`METHOD url`) bind to which server routes, and fails a PR that net-new breaks one — a frontend call to an endpoint no backend serves, or a removed route a consumer still calls.

It is **thin orchestration over the deterministic CLI.** It never re-implements extraction: it runs `init` / `doctor` / `guardrail check` / `flow publish`, reads their structured output, and supplies judgment + code edits. The determinism stays in the CLI; the agent supplies the reasoning.

## Modes

Pick the mode from what the user is doing. They share context — a fix often starts from a diagnose.

### setup — turn the gate on

Flow setup is folded into `init`; **there is no `flow init` command.**

- Fresh or re-run: `npx vyuh-dxkit init --flow` (forces `warn` posture, no prompt) or plain `npx vyuh-dxkit init` (interactive — it detects a UI→API surface and asks for the posture). If the repo has no client calls / routes, init stays silent; there is nothing to gate.
- The posture lives in `.dxkit/policy.json:flow.mode`:
  - `warn` — surfaces net-new breaks as warnings, never fails a build (the default; good for adoption).
  - `block` — fails the check on an exact break (confidence-gated: only fully-specified bindings block).
  - `off` — scaffold config only, do not gate.
- To change it later, edit `flow.mode` (or defer to **dxkit-config**).

### diagnose — read the contract's current state

`doctor` carries the flow diagnosis; **there is no `flow doctor` command.**

```
npx vyuh-dxkit doctor --json   → read the top-level `flow` field
```

`flow` (when the repo has a UI→API surface) contains:
- `topology` (monorepo / consumer-only / provider-only), `calls`, `routes`, `resolved`
- `unresolved[]` — each `{ method, path, reason, suggestion, file, line }`. `reason` is `no-route` / `external` / `placeholder-only`; `suggestion` is `add-route` / `configure-participant` / `adopt-spec` / `annotate`.
- `servedUnconsumed[]` — served routes no in-repo call hits (dead route, or a cross-repo consumer).
- `connection.rung` — how the served side is resolved (`monorepo` / `committed-counterpart` / `configured-participants` / `unresolved`).
- `contract` (when a committed `served.json` exists) — freshness of the snapshot: `generatedAt`, and per participant the commit its routes were gathered at (`sha`), its current `tip`, and `moved` (tri-state: `true` = the provider has shipped commits since this publish → recommend `flow publish` + commit; `false` = current; `null` = unknowable, e.g. offline — never treated as stale). `stale: true` only on a CONFIRMED move.

Walk the `unresolved` tail and, per item, act on its `suggestion`: add the missing route, configure a participant (handshake mode), or adopt the provider's spec so an external call resolves. There is no inline "ignore this line" marker — an intentional break is accepted per-finding via the allowlist once the gate surfaces it as a net-new breakage (see **fix** mode below), so the acceptance is reviewed and diff-tracked rather than a silent inline comment.

### fix — repair a net-new broken integration ⭐

When a guardrail check (or the loop Stop-gate) reports a flow block, read it:

```
npx vyuh-dxkit guardrail check --json   → read `flowGate.findings[]`
```

Each finding is `{ method, path, file, line, reason, verdict }`. `reason` is `no-route` (a call to nothing) or `route-removed` (a served route the PR deleted, still consumed). For each:

1. Explain it in one line: which call, which route, what the PR changed.
2. Propose the **repair** — restore the removed route, update the consumer to the new route, or (only if genuinely intentional) accept it with a reviewed per-finding allowlist entry (see "Accepting a genuinely-intentional break" below).

**Load-bearing safety rule — repair, never suppress.** Fix the integration; do not clear the block by refreshing the baseline or silently allowlisting the finding. An intentional break requires an explicit, reviewed acceptance, never a quiet re-baseline. This mirrors the loop discipline (do NOT refresh the baseline to clear a block) and is what keeps the gate honest when an agent is the one clearing it.

**Accepting a genuinely-intentional break.** A flow finding is a first-class finding: it carries a durable fingerprint (printed on the guardrail line and in the JSON `flowGate.findings[].id`), so the escape hatch is the same per-finding allowlist every other kind uses — not a separate flow-only config. When (and only when) a break is a reviewed, deliberate integration boundary (e.g. a route served by a third party dxkit can't see), accept it by fingerprint:

```
npx vyuh-dxkit allowlist add --fingerprint=<id> --kind=flow-binding \
  --category=false-positive --reason="served by <external system>, verified"
```

The gate then lists it under "suppressed by allowlist" (waived from the verdict, still surfaced for audit) and a reviewer sees the category + reason in the PR comment. Prefer `--category=accepted-risk` (with `--expires`) for a break you intend to fix later. This is a committed, diff-reviewable acceptance — never edit the baseline to make a flow block disappear.

### handshake — gate across repos

When the provider a call targets lives in another repo, the gate needs that repo's served contract. Two ways, both landing in `.dxkit/flow/served.json` (which the gate reads offline):

- **Committed counterpart** — the provider commits its own `served.json`; this repo vendors it. Fully offline, diff-reviewable.
- **Workspace participants** — declare the services in `.dxkit/workspace.json` (`participants[]`), then:

  ```
  npx vyuh-dxkit flow publish   → unions every participant's served routes into this repo's served.json
  ```

  Each participant is located by `path` (a local checkout / sibling dir) and/or `repo` (a remote clone URL — `https://…`, `git@host:owner/repo.git`, `ssh://…`), with an optional `ref` to pin a branch/tag/commit:

  ```jsonc
  { "name": "backend", "path": "../backend" }                                  // local sibling
  { "name": "billing", "repo": "https://github.com/acme/billing.git", "ref": "main" }  // remote, no checkout needed
  { "name": "auth",    "path": "../auth", "repo": "git@github.com:acme/auth.git", "ref": "main" }  // local when present, else clone
  ```

  A `repo:` participant is fetched (shallow, at `ref`) so services need not be locally checked out — e.g. in CI. When both `path` and `repo` are set, the local checkout is preferred when it exists (offline, fast) and the remote is the fallback. Remote fetch uses your ambient git credentials (SSH agent / credential helper) — dxkit never prompts, so a private repo needs its key/token already configured. `flow refresh` writes just this repo's snapshots; `flow publish` unions the whole mesh. Commit the result — the per-commit gate reads the committed `served.json` offline and never fetches.

  **Freshness is disclosed, not assumed.** `flow publish` records the commit each participant's routes were gathered at onto the snapshot (`participants[].sha`). `doctor` later compares that against each participant's current tip (a local `rev-parse`, or one bounded `ls-remote` for `repo:` participants — fail-open offline) and warns "served.json is BEHIND: <name> moved since publish" when a provider has shipped commits past the snapshot. The gate itself never probes the network; when its findings were resolved against a committed contract, it prints the snapshot's publish date so a reviewer knows which vintage judged them. A stale snapshot's usual symptom is a FALSE `no-route` on a call to a route the provider added recently — the fix is `flow publish` + commit, not an allowlist entry.

### console — an interactive HTML artifact a reviewer can exercise

Generate a self-contained HTML console of the flow — the UI→API map plus a request runner per endpoint — so an author or reviewer can *exercise* exactly what a change touched, not just read that it broke.

```
npx vyuh-dxkit flow console                 → full map → .dxkit/reports/flow-console.html
npx vyuh-dxkit flow console --diff <ref>    → PR-scoped: only endpoints the change touches,
                                              with any net-new broken integration flagged
npx vyuh-dxkit flow console --json           → { outPath, scope, broken, ... } for the agent to read
```

- **It is diff-scoped in `--diff` mode** (the reviewer sees the three integrations this PR moves, not the whole app), and the gate marks the ones this change net-new breaks — the same findings `guardrail check` reports, made tangible.
- **Safety is load-bearing and unconditional:** dxkit generates the document statically and makes **zero** HTTP calls. The request runner calls FROM THE BROWSER when the user opens the file and enters, at runtime, a Base URL (their dev/staging, never prod) and an auth token. That token lives only in the open tab — it is never committed, logged, baked into the artifact, or seen by dxkit or CI. Point it at a dev/staging origin that allows the page's origin (CORS).
- In CI the console is generated diff-scoped, uploaded as a build artifact, and linked from the guardrail PR comment — no server, no required infra. It complements the gate (enforcement); it is a reviewer-ergonomics aid, not itself a gate.

## What lives where

| Artifact | Role |
|---|---|
| `.dxkit/policy.json:flow` | posture (`mode`) + URL strip-prefixes + specs |
| `.dxkit/reports/flow-console.html` | the generated interactive console (git-ignored output) |
| `.dxkit/workspace.json` | the participants (name, path, ref, base URLs) of a multi-repo system |
| `.dxkit/flow/served.json` / `consumed.json` | the committed contract snapshots the gate reads |

## Boundaries

- WHETHER to gate + posture → this skill (setup) or **dxkit-config**.
- A broken integration found during a PR → this skill (fix). If it surfaced through the loop Stop-gate, **dxkit-loop** explains the block; the repair is here.
- Do not use this skill to re-extract flow by hand or to write CSVs — that is the CLI's job.
