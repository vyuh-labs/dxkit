# `vyuh-dxkit licenses`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Dependency license inventory. Per-package + per-license summary across
every active language pack.

## Usage

```bash
vyuh-dxkit licenses [path] [options]
```

## Options

| Option       | Effect                                                       |
| ------------ | ------------------------------------------------------------ |
| `--detailed` | Write detailed report + JSON (per-package shape)             |
| `--xlsx`     | Also write 15-column XLSX matching the standard BOM template |
| `--json`     | Stdout JSON                                                  |
| `--no-save`  | Skip writing markdown                                        |

## Where the data comes from

Each language pack contributes its own license capability:

| Pack                    | Tool                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| TypeScript / JavaScript | `license-checker`                                                   |
| Python                  | `pip-licenses`                                                      |
| Go                      | `go-licenses`                                                       |
| Rust                    | `cargo-license`                                                     |
| Ruby                    | `licensee` / `bundle exec` parse                                    |
| Java                    | `mvn license:aggregate-third-party-report`                          |
| Kotlin                  | derived via Java + Gradle                                           |
| C#                      | `nuget-license` (license-data joined to dotnet list package output) |

Multi-stack repos union all packs' output. The deduplicated shape
groups by package name + version + license type.

## Output

```markdown
## Summary

| Stat                            | Count |
| ------------------------------- | ----: |
| Total packages                  |   312 |
| Unique licenses                 |    14 |
| Permissive (MIT/BSD/Apache/ISC) |   287 |
| Weak copyleft (MPL/EPL)         |     8 |
| Strong copyleft (GPL/AGPL)      |     0 |
| Unknown / unrecognized          |    17 |
| Source-available / commercial   |     0 |

## By license (top 10)

| License    | Count |
| ---------- | ----: |
| MIT        |   178 |
| Apache-2.0 |    65 |
| ISC        |    30 |

| ...
```

## Output formats

- `licenses-<date>.md` — short summary
- `licenses-<date>-detailed.md` — every package + version + license
- `licenses-<date>-detailed.json` — same data, machine-readable
- `licenses-<date>-detailed.xlsx` — 15-column XLSX (with `--xlsx`)

The XLSX is drop-in compatible with the standard BOM-template shape
used in customer audits.

## See also

- [`bom`](bom.md) — licenses joined with vulnerabilities, ordered by Risk
