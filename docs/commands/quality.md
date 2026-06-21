# `vyuh-dxkit quality`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Code quality + slop detection. Lint summary, duplicate code (jscpd),
structural metrics (graphify), and a "slop score" composite.

## Usage

```bash
vyuh-dxkit quality [path] [options]
```

## What it surfaces

- **Lint counts** — errors + warnings, summed across every active
  language pack's linter (eslint, ruff, golangci-lint, clippy,
  dotnet-format, detekt, pmd, rubocop). Multi-stack repos sum
  contributions and the tool label lists each.
- **Duplication** — jscpd-detected duplicated lines + percentage +
  top-10 clones with file/line attribution.
- **Structural** — graphify-derived metrics: max functions in a file,
  average cohesion, community count, function count, dead imports,
  orphan modules.
- **Hygiene markers** — TODO / FIXME / HACK / console.log counts
  across the staged source tree.
- **Comment ratio** — code-to-comment ratio (filtered to
  pack-declared "source code" languages, not markup/data files).
- **Slop score** — composite 0-100 metric that weights all of the
  above into one signal.

## Options

| Option            | Effect                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--detailed`      | Write detailed report (top-10 duplicate clones, top hygiene offenders, slop breakdown)                                                 |
| `--json`          | Stdout JSON                                                                                                                            |
| `--no-save`       | Skip files                                                                                                                             |
| `--graph-context` | Attach each offender file's module + blast radius to the detailed report (fail-open — see [`context`](context.md))                     |
| `--attribute`     | Attach a "Who to ask" column (each offender file's current owner, via the active-owner model). Opt-in; names + @handles, never emails. |

## Output

```markdown
## Slop score: 38/100 (lower is better)

| Metric             |        Count |
| ------------------ | -----------: |
| Lint errors        |            2 |
| Lint warnings      |           17 |
| Duplicated lines   | 1,308 (4.2%) |
| TODO/FIXME/HACK    |   27 / 4 / 1 |
| Console.log family |           87 |
| Max functions/file |           56 |
| Avg cohesion       |         0.71 |
| Dead imports       |            0 |
| Orphan modules     |           12 |
```

The detailed report lists clones with file/line ranges, top-offender
files, and remediation actions.

## Performance

`quality` is the slowest single command on JS-heavy repos because of
`jscpd`. Expect 5-15 minutes on a large web codebase (lots of `.js`
and `.jsx` files to compare). Smaller codebases finish in 30-90 sec.

## See also

- [`health`](health.md) — Quality dimension summary
- [`dashboard`](dashboard.md) — single HTML view including quality
