# `vyuh-dxkit context`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Hand a coding agent (or yourself) a slim, token-budgeted structural
slice for a query — the relevant symbols, where they live, what calls
them, and the module they belong to — read from the code graph at
`.dxkit/reports/graph.json`. The point is to navigate by graph instead
of repeated whole-file reads: the same orientation at a fraction of the
tokens. It's a navigation aid, not a substitute for reading the code
you're about to change.

## Usage

```bash
vyuh-dxkit context <query>      [--budget N] [--depth N] [--substring] [--json]
vyuh-dxkit context <file:line>  [--budget N] [--json]
```

`vyuh-dxkit context …` is a top-level alias for
`vyuh-dxkit explore context …`. The argument shape selects the mode:
a `path:line` resolves to the **location** surface (below); anything
else is a **keyword query**.

## What it returns

A budget-bounded subgraph, breadth-first from the symbols matching the
query:

- **Anchor** — the highest-in-degree match ("if you read one thing,
  read this").
- **Selection** — relevant symbols, seeds first, then their callers /
  callees, grouped by module. The walk stops once the running token
  estimate fills the budget, so the most relevant symbols survive
  truncation (reported honestly as "+N more").
- **Blast radius** — how many distinct callers / caller files a change
  to the matched symbols would touch.

On no match it returns "did you mean" suggestions instead of an empty
result.

## Locating by `file:line`

```bash
vyuh-dxkit context src/payments/checkout.ts:142
```

Given a location, `context` returns the **focused source chunk around
that line** — roughly the enclosing symbol rather than the whole file —
plus its structural neighborhood:

- **Enclosing symbol** — the declaration nearest at-or-above the line,
  with its in/out call counts. A heuristic: graph nodes carry only a
  declaration line (no end line), so the symbol boundary is
  declaration-to-next-declaration — confirm it before editing.
- **Source chunk** — the actual lines, read from disk and line-numbered,
  carved to `--budget` and **centered on the requested line** (so the
  line you asked about is always shown, even when the symbol is larger
  than the budget). A `Showing lines X–Y of the N-line span` note appears
  when the budget truncated the window.
- **Module + blast radius** — the community the file belongs to and how
  many caller files a change would touch (suppressed as `n/a` for
  languages whose call graph can't be resolved — never read a blank as
  "0 callers").
- **Callers / callees** — the symbols that reach this one and the ones it
  calls out to.

This is the "agent ingests 500 focused lines, not the 15k-line file"
surface. It degrades in layers: a file absent from the graph still
returns a centered raw-line window (no structural context); an
unreadable path exits non-zero with a clear message.

`--budget` bounds the source chunk; `--depth` / `--substring` apply only
to the keyword form.

## Flags

- `--budget N` — soft token ceiling on the rendered slice / source chunk (default 2000). Lower it for tighter context windows.
- `--depth N` — hard cap on BFS hops (default: budget-bounded, adaptive — a hot symbol fills the budget at hop 1, a cold one reaches further).
- `--substring` — match symbols whose name _contains_ the query, not just exact matches (broader, noisier).
- `--json` — machine-readable envelope for scripts and hooks.

## The PreToolUse hook

`--with-dxkit-agents` installs a fail-open Claude Code PreToolUse hook
(`context-hook`) on `Grep` / `Glob`. When an agent is about to search
the codebase, the hook injects the matching structural slice as
`additionalContext`, so the agent needs fewer follow-up whole-file
reads.

The hook is **additive and fail-open**: it only ever _adds_ context,
never blocks a tool, and is a silent no-op when the graph is missing,
stale, or doesn't match — so the editor behaves exactly as it does
today whenever the hook can't help. It's pure upside.

## Relationship to `--graph-context`

`context` is a _query_ surface ("tell me about X"). The
`--graph-context` flag on [`vulnerabilities`](vulnerabilities.md),
[`test-gaps`](test-gaps.md), and [`quality`](quality.md) is the
_finding_ surface: it attaches each finding's module + blast radius
straight into the detailed report, so a fixing agent gets the
structural map per finding without running `context` itself.

## Notes

- Reduction is a **navigation-phase** win (discovery / orientation),
  not a universal multiplier — the edit phase still reads real code.
- Coverage tracks the graph: reliable on TypeScript / Python / Go;
  conservative where a language's call graph can't be fully resolved
  (C#).

## See also

- [`explore`](explore.md) — the broader query surface over the same graph
- [`vulnerabilities`](vulnerabilities.md) / [`test-gaps`](test-gaps.md) / [`quality`](quality.md) — `--graph-context` per-finding enrichment
