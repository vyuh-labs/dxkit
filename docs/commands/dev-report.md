# `vyuh-dxkit dev-report`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Developer activity report. Per-author commit + line stats, per-week
velocity, and a hot-files ranking.

## Usage

```bash
vyuh-dxkit dev-report [path] [options]
```

## Options

| Option               | Effect                                                   |
| -------------------- | -------------------------------------------------------- |
| `--since YYYY-MM-DD` | Start of the analysis window. Defaults to ~90 days back. |
| `--detailed`         | Write detailed report + JSON                             |
| `--json`             | Stdout JSON                                              |
| `--no-save`          | Skip files                                               |

## What it shows

| Section                 | Source                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Per-author summary      | `git log --author=*` aggregation: commits, insertions, deletions, files touched, first/last commit date                     |
| Weekly velocity         | Commits + lines changed per ISO week. Empty weeks are filled with zeros so the trend is readable.                           |
| Hot files               | Top files by commit count in the window, with autogen-file filtering applied (no more `Form.Designer.cs` topping the list). |
| Authoring concentration | bus-factor estimate per file                                                                                                |

## Output

```markdown
## Authors (4)

| Author            | Commits |     + |     - | First      | Last       |
| ----------------- | ------: | ----: | ----: | ---------- | ---------- |
| alice@example.com |      42 | 1,832 | 1,201 | 2026-02-14 | 2026-05-13 |
| bob@example.com   |      28 |   903 |   612 | 2026-02-20 | 2026-05-12 |

## Weekly velocity

| Week     | Commits | Lines changed |
| -------- | ------: | ------------: |
| 2026-W18 |       5 |           340 |
| 2026-W19 |       0 |             0 |
| 2026-W20 |      12 |           876 |
| 2026-W21 |       3 |            45 |

## Hot files (top 10 by commit count)

| File                 | Commits | Authors |
| -------------------- | ------: | ------: |
| src/services/data.ts |      18 |       3 |
| src/api/auth.ts      |      15 |       2 |
```

## Performance

`dev-report` is the fastest of the analyzer commands — pure `git log`
parsing, no external tools. < 30 sec on most repos.

## See also

- [`dashboard`](dashboard.md) — HTML view bundles dev-report with the others
