# `vyuh-dxkit uninstall`

Remove dxkit and restore the repo's pre-dxkit state: delete every file
dxkit created, and surgically reverse every additive merge dxkit made
into a pre-existing file, without touching a byte the user owns. The
command is dry-run by default; nothing changes until you pass `--yes`.

## Usage

```bash
vyuh-dxkit uninstall [path]          # dry run: show the plan, change nothing
vyuh-dxkit uninstall [path] --yes    # apply the plan
```

## Options

| Option             | Effect                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `--yes`            | Apply the plan (without it, the command only prints the plan)                                                       |
| `--keep-baselines` | Keep the curated git-tracked artifacts under `.dxkit/` (see below)                                                  |
| `--remove-devdep`  | Also strip the `@vyuhlabs/dxkit` devDependency + postinstall, and any tool devDeps dxkit added, from `package.json` |
| `--force`          | Remove dxkit-created files even if you edited them (default: skip + warn)                                           |
| `--no-feedback`    | Skip the optional prefilled feedback-issue link at the end                                                          |
| `--json`           | Emit the plan (`empty`, `warnings`, `actions`) and exit without applying                                            |

## Behavior

The plan is built from the install manifest (`.vyuh-dxkit.json`) and its
per-file provenance:

- **Created files are deleted.** A manifest entry recorded as created or
  overwritten by dxkit is removed. Non-evolving files are hash-guarded:
  if you edited one since dxkit wrote it, it is skipped and warned about
  unless you pass `--force`.
- **Your files are never deleted.** An entry with `skipped` provenance is
  a file that pre-existed dxkit; it is left alone even under `--force`.
- **Merged files are reverted, not deleted.** `.gitignore`, `CLAUDE.md`,
  `.claude/settings.json`, and `package.json` get dxkit's additions
  stripped while your content is preserved (byte-preserving JSON
  serialization for the JSON files). The `.vscode` JSONC file
  association for `.dxkit/policy.json` is removed, and `core.hooksPath`
  is unset if dxkit pointed it at `.githooks`.
- **Managed artifacts** (CI workflows, git hooks, devcontainer, skills)
  are removed via the same registry `init` and `update` read, so a
  surface cannot be installed by one path and missed by this one.
- **Runtime state.** `.dxkit/` is removed entirely (baselines, reports,
  loop, policy). With `--keep-baselines`, the curated committed artifacts
  survive: `baselines/`, the allowlist (and its reasons sidecar),
  `external/`, `flow/`, and `workspace.json`.
- **The manifest goes last.** If any edited file was skipped, the
  manifest is kept so a later `uninstall --force` can still find and
  remove it.

After an apply that changed `package.json`, the command prints your
package manager's install command so the lockfile prune completes. It
also offers a prefilled GitHub issue link asking why you uninstalled;
nothing is sent automatically, and `--no-feedback` suppresses it.

## See also

- [`vyuh-dxkit init`](init.md), the inverse operation
- [`vyuh-dxkit update`](update.md), which reads the same provenance model
- [`.dxkit/policy.json` reference](../configuration/policy.md)
