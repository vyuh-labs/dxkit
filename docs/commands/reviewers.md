# `vyuh-dxkit reviewers`

Suggest reviewers for a change, grounded on an **active-owner model** rather
than a platform's naive last-touch blame.

```bash
vyuh-dxkit reviewers [--base <ref>] [--staged] [--limit N] [--json]
```

## How it picks

The candidate set is the contributors who have touched the changed files,
ranked by an active-owner model:

- **Recency-weighted** — sustained recent work ranks far above an ancient single
  commit (exponential half-life decay).
- **Active-only** — "active" means a non-merge commit repo-wide within the recent
  window. A contributor who has gone quiet (left the team) is flagged inactive
  and not silently suggested.
- **Bots filtered** — `dependabot`, CI, release bots, and similar automation are
  excluded.
- **Author excluded** — you are never suggested as a reviewer of your own change.
- **`CODEOWNERS` blended in** — when a `CODEOWNERS` file matches the touched
  paths, its owners are authoritative and surfaced first.
- **Bus-factor signal** — if a single active owner covers the touched files, the
  command warns (a single point of failure on that code).

When every contributor who knows the files is inactive, the command says so and
leans on `CODEOWNERS` / current ownership rather than naming someone unreachable.

## Output

Names + **GitHub @handles** — never raw emails. The @handle is both the
privacy-safe identifier and the actionable one: it's @-mentionable and feeds
`gh pr create --reviewer`.

## Options

| Option       | Effect                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `--base <r>` | Diff `<r>...HEAD` for the changed files (default: `origin/HEAD`, else `origin/main`) |
| `--staged`   | Use the staged changes instead of a branch diff                                      |
| `--limit N`  | Cap the number of suggestions (default 3)                                            |
| `--json`     | Emit a structured payload (consumed by the `dxkit-pr` skill)                         |

## Where it fits

The `dxkit-pr` skill runs `reviewers --json` to add a "Suggested reviewers"
block to the PR body and can pass the handles to `gh pr create --reviewer`.

## Privacy

Author emails are used only as the internal identity key for clustering aliases;
they are never rendered. Everything user-facing is a display name or @handle.

## See also

- [`dev-report`](./dev-report.md) — the contributor-activity analysis this builds on
- [`bom`](./bom.md) / [`vulnerabilities`](./vulnerabilities.md) — `--attribute` adds a "who to ask" column to findings
