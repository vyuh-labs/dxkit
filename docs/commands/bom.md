# `vyuh-dxkit bom`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Bill of Materials. The unified package-centric view — every dependency
with its license, vulnerabilities, reachability evidence, KEV/EPSS
enrichment, composite Risk score, and an actionable upgrade plan.

## Usage

```bash
vyuh-dxkit bom [path] [options]
```

## Options

| Option               | Effect                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `--detailed`         | Write detailed report + JSON (every package row, full vuln join)                           |
| `--xlsx`             | Also write 15-column BOM XLSX                                                              |
| `--filter top-level` | Only top-level deps; transitives roll up under each top-level (default: `all`)             |
| `--no-nested`        | Don't scan sub-projects (monorepo case); default behavior aggregates every nested manifest |
| `--json`             | Stdout JSON                                                                                |
| `--no-save`          | Skip files                                                                                 |

## What's joined

For every package across every active pack's lockfile, the BOM stitches:

| Source           | What                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Package manifest | Name, version, top-level/transitive flag, parent chain                                                        |
| License          | Per-package license from the `licenses` capability                                                            |
| Vulnerabilities  | Every advisory affecting this exact version (osv-scanner / npm-audit / pip-audit / govulncheck / cargo-audit) |
| KEV catalog      | CISA "known exploited" flag (`⚠`) when any advisory's CVE is in KEV                                           |
| EPSS             | Probability of exploitation in 30 days (percentage)                                                           |
| Reachability     | Whether the source actually imports this package — `✓` / `✗` / blank                                          |
| Risk             | Composite 0-100 score (CVSS × EPSS × KEV × reachability)                                                      |
| Upgrade plan     | Patch version + breaking-change flag where available                                                          |

## Output

The short report opens with a triage table:

```markdown
## This Week's Triage (Risk ≥ 15)

| Risk | ID            | Package@Version | Rationale             | Fix                  |
| ---: | ------------- | --------------- | --------------------- | -------------------- |
| 78.4 | CVE-2024-1234 | lodash@4.17.4   | CVSS 7.5, EPSS 0.32   | upgrade to 4.17.21   |
| 42.0 | GHSA-...      | minimist@1.2.3  | reachable, no fix yet | evaluate replacement |
```

The detailed report's package-row table has columns `Risk | Severity
| CVSS | Package | License | # Vulns | KEV | Reach | EPSS | Resolution`.

## Key conventions

- **Risk column**: `**N.N**` when CVSS data is available; `—` when
  no advisory had CVSS (never `**0.0**` as a misleading
  stand-in)
- **Reach column**: three-state (`✓` reachable, `✗` not reachable,
  blank = unknown)
- **`totalAdvisories`** count = **unique fingerprints** (not
  sum-of-occurrences across multiple top-level deps)

## XLSX output

`--xlsx` writes the standard 15-column BOM template. Useful for:

- Security review handoff
- Procurement / supply-chain audits
- Periodic compliance check-ins

## Performance

Largely shaped by `osv-scanner` (network round-trip per pack) and the
enrichment passes (EPSS + KEV). Medium repo: 1-3 min.

## See also

- [`licenses`](licenses.md) — licenses-only view
- [`vulnerabilities`](vulnerabilities.md) — same vulns through a finding-centric lens
