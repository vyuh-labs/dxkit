# `vyuh-dxkit describe`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

A shareable snapshot of what dxkit sees in a repository: the whole code
graph (every function, what it calls, and what calls it), joined to the
HTTP contract when one exists (routes served, calls made, and how they
bind). It reads the same deterministic analysis the gate uses and adds
no new heuristics.

`describe` is read-only. It prints a terminal summary and writes nothing
to your repository unless you pass `--out`.

## Usage

```bash
vyuh-dxkit describe [path] [--json] [--html] [--out <file>]
```

With no flags it prints a terminal summary. Every count it reports is
labeled `observed` / `derived` / `inferred` / `unknown`, so the picture
is honest about what was read directly versus resolved.

## Flags

| Flag           | Effect                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `--json`       | Emit the versioned repo card (`dxkit.repo-card.v1`) to stdout, for tooling |
| `--html`       | Emit a self-contained, interactive contract-map HTML page to stdout        |
| `--out <file>` | Write the output (HTML or JSON) to a file instead of stdout                |
| `path`         | Repository to describe (defaults to the current directory)                 |

## The contract map

`--html` produces one self-contained file: no server, no API key, no
external assets. Open it in a browser and it renders a live, force-directed
map with three views:

| View            | Shows                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| Full code graph | The whole code graph: functions sized by fan-out, with the contract overlaid |
| Request paths   | Each route to its handler to the internal functions it fans out to           |
| Seam            | Every endpoint as a color-coded tile, laid out for a health scan at a glance |

The map lights up the **seams**, where code connects and where it does not:

- **dead route**: an endpoint nothing calls,
- **broken call**: a client call that reaches no route,
- **cross-repo contract**: a call served by another repository in your workspace.

Drag nodes to explore, hover to highlight a neighborhood, click to trace a
path, and double-click a route (or a function) to drill one level deeper.

## Examples

```bash
vyuh-dxkit describe                          # terminal summary of this repo
vyuh-dxkit describe --json                   # the versioned repo card, for tooling
vyuh-dxkit describe --html --out map.html    # the interactive contract map
vyuh-dxkit describe ../other-service --html --out other.html
```

A repository with no HTTP surface (a CLI or a library) still renders its
full code graph; the contract layer is simply empty.

## Related

- [`explore`](explore.md) queries the same code graph from the terminal.
- [`flow`](../commands/guardrail.md) and the integration gate act on the
  contract seams `describe` visualizes.
