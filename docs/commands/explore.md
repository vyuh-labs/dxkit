# `vyuh-dxkit explore`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Ask the codebase structural questions — what it does, where a feature
lives, which files everything depends on. Every subcommand reads the
same deterministic code graph at `.dxkit/reports/graph.json` (symbols,
call edges, and Louvain-clustered modules, extracted by graphify). It
doesn't run analysis; it queries the graph the analyzers already built.

## Usage

```bash
vyuh-dxkit explore <subcommand> [args] [--json] [--limit N] [--refresh]
```

If no graph artifact exists yet, run `vyuh-dxkit health` once (it writes
`graph.json` as a side effect), or pass `--refresh` to rebuild it.

## Subcommands

| Subcommand          | Question it answers                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- |
| `entry-points`      | "What does this repo do?" — high-fan-out symbols in route / primary-component paths |
| `hot-files`         | "What's the foundational layer?" — files the most other files depend on             |
| `communities`       | "What are the natural modules?" — Louvain clusters with their dominant directory    |
| `file <path>`       | "What is this file, and who depends on it?" — symbols, callers, callees, imports    |
| `feature <keyword>` | "Where is X implemented?" — clusters of symbols matching a keyword                  |
| `api-surface`       | "What's the public API / what's dead?" — exported symbols with no internal callers  |
| `context <query>`   | Slim, token-budgeted structural slice for an LLM — see [`context`](context.md)      |

## Examples

```bash
vyuh-dxkit explore entry-points          # top entry points by call out-degree
vyuh-dxkit explore hot-files --limit 30  # 30 most-depended-on files
vyuh-dxkit explore feature auth          # where "auth" is implemented
vyuh-dxkit explore feature jwt --substring   # broader (noisier) keyword match
vyuh-dxkit explore file src/server.ts    # one file's structural neighborhood
vyuh-dxkit explore communities --json    # natural modules, machine-readable
```

## Flags

- `--json` — emit a stable envelope (`command` / `args` / `meta` / `results`) for scripts and skills.
- `--limit N` — cap the number of rows (per-subcommand default; e.g. hot-files 20, communities 8).
- `--substring` — `feature` only: also match symbols whose name _contains_ the keyword (off by default; false-positive-prone for short keywords).
- `--refresh` — rebuild `graph.json` before querying instead of reading the existing artifact.

## Notes

- **Language coverage varies.** graphify resolves call edges well for
  TypeScript / Python / Go; for languages whose call graph it can't
  fully resolve (C#), the symbol and module data are present but
  caller-based answers (`hot-files`, `api-surface`) are conservative.
- The graph carries no absolute paths — source files are
  project-relative throughout, so the artifact is safe to share.

## See also

- [`context`](context.md) — token-budgeted structural slice for LLMs + the PreToolUse hook
- [`dashboard`](dashboard.md) — the graph also renders as an interactive tab in the HTML dashboard
- [`health`](health.md) — writes `graph.json` as a side effect
