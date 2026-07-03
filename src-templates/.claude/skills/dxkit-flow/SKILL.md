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

Walk the `unresolved` tail and, per item, act on its `suggestion`: add the missing route, configure a participant (handshake mode), adopt a spec, or annotate an intentional external call.

### fix — repair a net-new broken integration ⭐

When a guardrail check (or the loop Stop-gate) reports a flow block, read it:

```
npx vyuh-dxkit guardrail check --json   → read `flowGate.findings[]`
```

Each finding is `{ method, path, file, line, reason, verdict }`. `reason` is `no-route` (a call to nothing) or `route-removed` (a served route the PR deleted, still consumed). For each:

1. Explain it in one line: which call, which route, what the PR changed.
2. Propose the **repair** — restore the removed route, update the consumer to the new route, or (only if genuinely intentional) add an explicit annotation / a per-finding allowlist entry that a human reviews.

**Load-bearing safety rule — repair, never suppress.** Fix the integration; do not clear the block by refreshing the baseline or silently allowlisting the finding. An intentional break requires an explicit, reviewed acceptance, never a quiet re-baseline. This mirrors the loop discipline (do NOT refresh the baseline to clear a block) and is what keeps the gate honest when an agent is the one clearing it.

### handshake — gate across repos

When the provider a call targets lives in another repo, the gate needs that repo's served contract. Two ways, both landing in `.dxkit/flow/served.json` (which the gate reads offline):

- **Committed counterpart** — the provider commits its own `served.json`; this repo vendors it. Fully offline, diff-reviewable.
- **Workspace participants** — declare the services in `.dxkit/workspace.json` (`participants[]` with a local `path` and optional `ref`), then:

  ```
  npx vyuh-dxkit flow publish   → unions every participant's served routes into this repo's served.json
  ```

  `flow refresh` writes just this repo's snapshots; `flow publish` unions the whole mesh so this repo resolves calls to services it does not co-locate. Commit the result.

## What lives where

| Artifact | Role |
|---|---|
| `.dxkit/policy.json:flow` | posture (`mode`) + URL strip-prefixes + specs |
| `.dxkit/workspace.json` | the participants (name, path, ref, base URLs) of a multi-repo system |
| `.dxkit/flow/served.json` / `consumed.json` | the committed contract snapshots the gate reads |

## Boundaries

- WHETHER to gate + posture → this skill (setup) or **dxkit-config**.
- A broken integration found during a PR → this skill (fix). If it surfaced through the loop Stop-gate, **dxkit-loop** explains the block; the repair is here.
- Do not use this skill to re-extract flow by hand or to write CSVs — that is the CLI's job.
