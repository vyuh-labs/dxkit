---
name: dxkit-describe
description: Produce a shareable, honest snapshot of a repo — its stack, its HTTP flow spine (routes served, calls made, how they bind), and its data models — with every fact labeled observed / derived / inferred / unknown, plus a self-contained contract-map HTML you can screenshot. Use when the user says "describe this repo", "what does this codebase look like", "give me a map of the services / API", "show the integration seams", "make a repo card", or wants a visual/onboarding overview to share. Writes nothing to the repo unless the user asks to save the HTML.
---

# dxkit-describe

This skill turns a repo into a **shareable, honest picture**: what dxkit can
see about the stack and its HTTP contracts, and — the part that builds trust —
how *much* of it dxkit actually resolved versus inferred or could not see.

It is zero-write by default. Nothing lands in the repo unless the user
explicitly saves the HTML map with `--out`.

## The one command

```
vyuh-dxkit describe [path]            # terminal summary (zero-write)
vyuh-dxkit describe --json            # the versioned repo card (dxkit.repo-card.v1)
vyuh-dxkit describe --html            # the contract-map HTML to stdout
vyuh-dxkit describe --html --out map.html   # save the map (explicit opt-in write)
```

Everything is computed from the code (flow spine, seams, models) via the same
canonical analyzers the gate uses — no new heuristics, no second confidence
scale.

## What it produces

- A **repo card**: stack, routes, calls, bindings, and models, each count
  broken down by epistemic label:
  - **observed** — dxkit parsed the source itself,
  - **derived** — from a declared contract (a spec) dxkit trusts but didn't see,
  - **inferred** — a heuristic binding that carries a confidence and may be wrong,
  - **unknown** — the fact exists but can't be resolved (a runtime URL, a
    missing scanner).
- The **seams**, which a linter cannot see:
  - **unresolved calls** — client calls that reach no served route (integration
    gaps),
  - **unconsumed routes** — served routes nothing calls (dead-surface
    candidates).
- A **holistic contract-map HTML**: a self-contained, offline, light/dark page
  that joins dxkit's OWN call graph (deeper than graphify — it keeps the
  framework/stdlib calls graphify drops) to the HTTP contract layer, ACROSS
  repos. Swimlanes per repo, left→right callers → routes → handlers; seams
  (broken call / dead route) glow; cross-repo edges are distinct; each handler
  expands on click to its internal + framework calls (the depth graphify can't
  see). The honesty rides on the picture. When a `.dxkit/workspace.json` declares
  local-path participants, the map spans them (offline — it never fetches).

## How to use it

1. **Summarize** — run `vyuh-dxkit describe` and read the seam counts and the
   honesty notes back to the user. Lead with the seams; they are the signal.
2. **Share** — for a visual, run `vyuh-dxkit describe --html --out contract-map.html`
   and tell the user where it was saved (this is the only step that writes).
   For automation, `--json` emits the versioned `dxkit.repo-card.v1` card.
3. **Be honest** — never present an `inferred` or `unknown` count as fact. The
   notes explain what wasn't measured; surface them.

## Guardrails

- Default and `--json` / `--html`-to-stdout write nothing; only `--out` saves a
  file. Say "nothing was written to your repo" when you didn't pass `--out`.
- The picture is only as complete as what dxkit resolved. If the coverage note
  says calls were dynamic or a pack didn't resolve a spine, say so — the value
  of this artifact is that it doesn't overclaim.
