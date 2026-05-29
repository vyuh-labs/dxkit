# `vyuh-dxkit health`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

The flagship report. Produces a 6-dimension 0-100 health score with
per-dimension metrics and ranked remediation actions.

## Usage

```bash
vyuh-dxkit health [path] [options]
```

`path` defaults to the current working directory. Pass an absolute or
relative path to analyze a different repo without `cd`.

## Options

| Option            | Effect                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--detailed`      | Also write `<name>-detailed.md` + `.json` with full evidence and ranked actions                                                                         |
| `--with-coverage` | Materialize real coverage data via per-pack test runs before scoring (slow but authoritative — line-coverage truth instead of filename-match heuristic) |
| `--json`          | Print the full report as JSON to stdout (suitable for piping)                                                                                           |
| `--no-save`       | Don't write any files — useful for CI gates that just want the exit status                                                                              |
| `--verbose`       | Per-tool timing emitted to stderr                                                                                                                       |

## What it measures

| Dimension                | Examples of what feeds the score                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Testing**              | Test file count, source-file ratio, coverage data when available (Istanbul, coverage.py, JaCoCo, SimpleCov, gocov, …) |
| **Code Quality**         | Lint errors/warnings, files-over-500-lines, console.log/`: any`/eval counts, doc-comment ratio                        |
| **Documentation**        | README, CONTRIBUTING, CHANGELOG, ARCHITECTURE, API docs (OpenAPI), doc-comment density                                |
| **Security**             | Hardcoded secrets, dependency CVEs, TLS-bypass idioms, eval() usage, `.env` tracked in git, private key files         |
| **Maintainability**      | Source-file count, directory count, controllers/models density, max file size, architectural communities (graphify)   |
| **Developer Experience** | CI configs, Docker, pre-commit hooks, Makefile, `.env.example`, coverage configuration files                          |

Each dimension is normalized to 0-100 with thresholds documented per
metric. The overall score is a weighted average.

## Output

Two files are written by default:

- `.dxkit/reports/health-audit-<date>.md` — short summary (the
  dimension table + headline metrics)
- `.dxkit/reports/health-audit-<date>-detailed.md` — every metric,
  per-dimension prose, ranked remediation actions
- `.dxkit/reports/health-audit-<date>-detailed.json` — machine
  readable

`health` also writes `.dxkit/reports/graph.json` as a side effect (the
code graph graphify builds for the Maintainability dimension). That
artifact powers [`explore`](explore.md), [`context`](context.md), the
dashboard Graph tab, and the `--graph-context` finding enrichment — so
running `health` once is the simplest way to populate the graph.

## Reading the short report

```markdown
## Overall: 73/100 (Grade: C)

| Dimension            |   Score | Status    |
| -------------------- | ------: | --------- |
| Testing              |  55/100 | fair      |
| Code Quality         |  80/100 | excellent |
| Documentation        |  45/100 | fair      |
| Security             |  90/100 | excellent |
| Maintainability      |  70/100 | good      |
| Developer Experience | 100/100 | excellent |

### Code Quality (80/100)

2 lint errors, 5 warnings (eslint). 4 files exceed 500 lines.
Largest file: src/services/data.ts (847 lines). 12 console/debug
statements. Densest file: 56 functions.
```

## Reading the detailed report

The detailed file adds, per dimension:

- A `Metrics` table with every input that fed the score
- A `Recommendations` section with ranked + scored actions
  (`PROPOSAL: <change> → estimated +X to dimension`)

The JSON shape is documented in the schema at the top of the JSON file
itself (`schemaVersion`).

## `--with-coverage` — when to use it

Without `--with-coverage`, the Testing dimension uses a **filename
match** heuristic: a `users.controller.ts` is "tested" if a
`users.controller.test.ts` exists. This is fast but inaccurate — a
200-line file with a 5-line test passes.

With `--with-coverage`, dxkit runs each active pack's test command
with coverage instrumentation, then reads real line-coverage data
(Istanbul JSON, coverage.py XML, JaCoCo XML, etc.). Slower (you're
running your tests) but authoritative.

The Testing-dimension report banner shows which mode you're in via
the `coverageFidelity` tier:

- `line-coverage` — real coverage data was found
- `import-graph` — heuristic enriched by import-graph analysis
- `filename-match` — pure filename heuristic

## Exit codes

- `0` — report generated successfully (regardless of score)
- `1` — fatal error (config missing, repo invalid, etc.)

If you want the exit code to fail when the score drops below a
threshold, parse the JSON output and act on it in your CI script.
That's intentionally not a dxkit flag yet — scoring thresholds vary
too much across teams.

## Performance

| Repo size                     | Approx. runtime |
| ----------------------------- | --------------- |
| Small (< 1K files)            | 30-60 sec       |
| Medium (1K-10K files)         | 1-3 min         |
| Large (10K+ files, mostly JS) | 3-8 min         |

The graphify (Python structural analysis) phase scales with file
count; the jscpd phase is included in `quality` (not `health`).

## See also

- [`vyuh-dxkit coverage`](coverage.md) — materialize coverage artifacts ahead of time
- [`vyuh-dxkit dashboard`](dashboard.md) — HTML view that includes health
- [`vyuh-dxkit doctor`](doctor.md) — diagnose if a metric reads "n/a" or "unavailable"
