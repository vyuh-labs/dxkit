# `dxkit.yml`

Per-project configuration. Optional — dxkit infers most settings from
detection. Use `dxkit.yml` when you want to override defaults
(force-activate a pack, pin a language version, etc.).

## File location

Place `dxkit.yml` at the repo root. DXKit auto-discovers it.

## Example

```yaml
# Project metadata
projectName: my-awesome-service

# Language pack overrides — set true/false to force-activate/deactivate
languages:
  typescript: true
  python: true
  go: false # detected but ignored

# Per-pack version pins (consumed by `init` for scaffold generation)
versions:
  node: '20'
  python: '3.12'
  go: '1.22'
```

## Schema

| Key              | Type    | Effect                                                                                                    |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `projectName`    | string  | Override the displayed name (default: directory name)                                                     |
| `languages.<id>` | boolean | Force pack on/off (8 valid IDs: `typescript`, `python`, `go`, `rust`, `csharp`, `kotlin`, `java`, `ruby`) |
| `versions.<key>` | string  | Version pin per pack (used by `init` scaffolds + dev-container generation)                                |

## When you don't need this file

The vast majority of repos work fine without `dxkit.yml`. Detection
covers:

- Which language packs are active (manifest + source files)
- Where to find tests (per-pack conventions)
- Where to find coverage artifacts (per-pack conventions)
- Which lint configs exist

So unless you have a specific override need, omit this file entirely.

## When you need it

- Forcing a pack off (e.g. you have a `go.mod` for tooling but don't
  want Go analysis on the repo)
- Forcing a pack on (rare — usually means a missing manifest you can't
  add)
- Pinning Node / Python / etc. version for the scaffold tooling
- Renaming the project as shown in reports

## See also

- [Language packs](language-packs.md) — what each pack contributes
- [`.dxkit-ignore`](dxkit-ignore.md) — exclude paths from analysis
