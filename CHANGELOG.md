# Changelog

All notable changes to `@vyuhlabs/dxkit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] - 2026-04-24

Phase 10h.6 complete. Tier-2 fix tools + agent-handoff types +
cross-pack upgrade-plan resolver + C# multi-project attribution.
Closes defect D003. One user-facing theme: every `DepVulnFinding`
that has a viable remediation now carries a structured
`upgradePlan` that agents can consume directly — no more parsing
free-text `upgradeAdvice` to figure out what to upgrade.

### Added — agent handoff (Phase 10h.6 kickoff)

- **Advisory fingerprint** — `DepVulnFinding.fingerprint` is a stable
  16-char hash of `(package, installedVersion, id)`, stamped by the
  cross-pack aggregator after enrichment. Identity is input-only —
  re-scoring or enrichment changes do not mint a new fingerprint.
  `BomReport.summary.fingerprints` ships the sorted-deduplicated
  manifest so external tooling (suppressions, CI gates, upgrade bots)
  can diff two reports by plain set difference. New helper
  `src/analyzers/tools/fingerprint.ts`.

- **Structured upgradePlan** — `DepVulnFinding.upgradePlan` is a typed
  sibling to the existing free-text `upgradeAdvice`:
  `{ parent, parentVersion, patches[], breaking }`. Populated by the
  Tier-2 fix tools landing in 10h.6.1–.4 (`osv-scanner fix`,
  `pip-audit --fix`, `cargo audit fix`, the cross-pack transitive
  resolver). Free-text advice stays for markdown/xlsx readability;
  autonomous upgrade bots consume the structured form. New type
  `DepVulnUpgradePlan`.

### Added — Tier-2 fix tools (Phase 10h.6.1 + 10h.6.2)

- **TypeScript `osv-scanner fix` integration** (10h.6.1) — wraps
  `osv-scanner fix --format json --manifest package.json --lockfile
  package-lock.json` and stamps structured `upgradePlan` on each
  matching `DepVulnFinding` surfaced by `npm audit`. Per-patch rollup:
  if one top-level bump resolves N advisories, every finding's
  `upgradePlan.patches[]` lists all N. Breaking detection normalizes
  pre-1.x where a minor bump (0.5 → 0.6) is treated as breaking.
- **Rust `cargo-audit` upgradePlan population** (10h.6.3) — mirrors the
  Python pattern: cargo-audit's existing JSON output already carries
  per-advisory `versions.patched[]`, so we populate
  `DepVulnFinding.upgradePlan` as a pure transformation (parent equals
  the finding's own crate; Rust has no transitive-parent remediation
  concept at the advisory level). New `isMajorBump` helper shared with
  the TS/Python packs (identical implementation — flagged for
  consolidation in 10h.6.4's cross-pack resolver). 5 new tests.
- **Python `pip-audit` upgradePlan population** (10h.6.2) — pip-audit
  already returns `fix_versions[]` per advisory; we now map the first
  (minimal-resolving) entry into `DepVulnFinding.upgradePlan` alongside
  the existing `fixedVersion`. Python's flat dep graph means
  `upgradePlan.parent` equals the finding's own package — no transitive
  parent to upgrade, just bump the vulnerable package directly. No new
  subprocess call required; pure transformation of existing output.
- **New tool in `TOOL_DEFS`** — `osv-scanner` (Node/TS pack, Tier-2).
  Installs via `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`
  (macOS also tries `brew install osv-scanner` first). Soft-fails when
  the binary isn't available — existing `upgradeAdvice` (free-text,
  from npm-audit) stays as the fallback and no findings are dropped.
- **New helper** — `src/analyzers/tools/osv-scanner-fix.ts` exports
  `gatherOsvScannerFixPlans(cwd)`, `parseOsvScannerFixOutput(raw)`, and
  `enrichWithUpgradePlans(findings, plans)`. 19 new tests with a real
  osv-scanner sample as fixture.
- **New helper in Python pack** — `isMajorBump(from, to)` shared
  between depVulns gather and tests. Same pre-1.x-minor-is-breaking
  convention as the TypeScript pack. 5 new tests.

### Fixed — C# multi-project attribution (Phase 10h.6.7, closes D003)

- Multi-project .NET solutions (web app + tests + shared libs) now
  get correct top-level-dep attribution from every project's graph.
  Earlier revisions walked to the **first** `obj/project.assets.json`
  they found and built the attribution index from that one file —
  advisories reachable only through sibling projects' dep chains
  ended up without a `topLevelDep`. Fix: enumerate every
  `project.assets.json` under cwd, merge the edge maps + union
  top-level sets, run BFS against the merged graph. New exports in
  `src/languages/csharp.ts`: `findAllProjectAssetsJson` and
  `mergeAssetParses`. 5 new tests covering the merge semantics + the
  concrete D003 case (advisory reachable through sibling only).

### Added — cross-pack upgrade-plan resolver (Phase 10h.6.4)

- **Shared `isMajorBump` helper** — three identical copies
  (TS/Python/Rust from 10h.6.1–.3) consolidated into
  `src/analyzers/tools/semver-bump.ts`. All three packs import from
  the shared module; 7-test suite at `test/semver-bump.test.ts`
  supersedes the inline duplicates.
- **Cross-pack resolver** — new module
  `src/analyzers/tools/upgrade-plan-resolver.ts` exposing
  `resolveTransitiveUpgradePlans(findings)`. Runs after per-pack
  Tier-2 tools and before riskScore composition. Two passes:
    1. **Reconciliation** — for every advisory id listed in any
       existing plan's `patches[]`, stamp the same plan onto the
       matching finding (by id only, case-insensitive). Fills gaps
       where a Tier-2 tool's `fixed[]` mentions an id that's carried
       by another finding with a different (package, version) tuple.
    2. **Free-text parse** — derives a plan from the npm-audit
       transitive-fix template (`"Upgrade X to Y [major] (transitive
       fix)"`) when no structured plan exists. Single-advisory scope
       (patches=[finding.id]) since the free-text doesn't carry
       cross-advisory rollup. Producer-written plans are
       authoritative; resolver never overwrites.
- **Wire-up** — `gatherDepVulns` in `src/analyzers/security/gather.ts`
  now calls `resolveTransitiveUpgradePlans` after fingerprinting and
  tier-3 enrichment, before composite `riskScore`. 11 new tests at
  `test/upgrade-plan-resolver.test.ts`.

## [2.3.2] - 2026-04-24

PM-grade bom reports. The xlsx and markdown outputs both restructure
around decision-making (what to fix, who to call, what to plan) rather
than enumeration (here are all the packages, figure it out).

### Added — markdown report

- **🎯 Executive Summary** at the top: ship-blocker count, sprint-sized
  finding count (risk ≥ 40), license exposure (copyleft-strong + unknown
  counts), staleness (> 3y old packages), highest-leverage upgrade. One
  screen, written for a PM who needs "can we ship?" without scrolling.

- **Reconciliation prose** on "Top-Level Dep Groups" explaining why the
  numbers don't sum to the Summary totals — each CVE is counted once per
  top-level parent it reaches through, by design. "Advisories" column
  renamed to "Rolled-up Advisories" to reinforce the different semantics.

### Added — xlsx report (4-sheet workbook, replaces the single `platform` sheet)

1. **`Executive Summary`** — KV grid on one screen: totals, severity
   breakdown, top ship-blocker, highest-leverage upgrade, license-class
   counts (Permissive / Copyleft weak & strong / Proprietary / Unknown),
   staleness counts, tool provenance.

2. **`Triage`** — top 10 findings ranked by composite riskScore.
   Columns: Priority / Risk / Severity / KEV / Reachable /
   Package@Version / Advisory / CVSS / EPSS / Upgrade to / Effort /
   Rationale.

3. **`Inventory`** — the legacy 15-column customer format (unchanged
   byte-for-byte on cols 1–15) with **4 columns appended** (16–19):
   Risk / KEV / Reachable / EPSS, plus a bonus col 20 for CVSS (max).
   Sort by col 16 desc for the same triage ordering sheet 2 uses.

4. **`License Breakdown`** — pivot: license type × count × risk class ×
   sample packages. Copyleft-strong licenses surface at the top; unknown
   bucket flags licenses the classifier didn't recognise (legitimate
   human-review candidates like `CC-BY-4.0`).

### Added — shared pm-signals module

New `src/analyzers/bom/pm-signals.ts` with pure helpers the markdown
and xlsx renderers both use:

- `licenseClass(licenseType)` — SPDX-id → `permissive` | `copyleft-weak` |
  `copyleft-strong` | `proprietary` | `unknown`. Handles compound
  expressions (`MIT OR GPL-3.0` classifies as `copyleft-strong`, the
  stricter class), parenthesised forms (`(Apache-2.0 OR UPL-1.0)`),
  legacy `"MIT license"` / `"Apache 2.0 license"` suffixes, and known
  proprietary markers (`UNLICENSED`, `SEE LICENSE IN ...`).

- `stalenessTier(releaseDate)` — `fresh` (< 1y) / `aging` (1–3y) /
  `stale` (≥ 3y) / `unknown`. Injectable `now` for deterministic tests.

- `effortEstimate(entry)` — `trivial` (patch bump) / `moderate` (minor
  bump) / `major` (breaking) / `blocked` (no fix available). Derived
  from semver delta; multi-vuln entries escalate to the worst tier seen.

Derivations deliberately stay in the renderer layer rather than on
`DepVulnFinding` / `LicenseFinding` so the analyzer contract is
unchanged — consumers can re-derive trivially if needed.

### Changed (breaking-ish — see note)

- Xlsx sheet layout changed from single `"platform"` sheet to a 4-sheet
  workbook. **Consumers hardcoding sheet name `"platform"` will break.**
  The legacy 15-column layout is preserved byte-for-byte on the renamed
  `"Inventory"` sheet. Appended cols 16–19 are additive.

### Validation

- 715 tests passing (+18 pm-signals cases: license class mapping,
  compound expressions, staleness thresholds, effort semver deltas).
- Typecheck + lint + format + architecture + pre-push CI-mirror gate clean.
- vyuhlabs-platform smoke: all 4 sheets render correctly, exec summary
  surfaces 3 ship-blockers + 9 sprint-risk findings + pm2 flagged
  copyleft-strong, `@loopback/rest` surfaces as highest-leverage upgrade
  (27 transitive advisories, worst CRITICAL).

## [2.3.1] - 2026-04-24

Patch release fixing three install-robustness issues reported on a
real vyuhlabs-platform install:

### Fixed

- **`@vitest/coverage-v8` install crashed with `MODULE_NOT_FOUND`** on
  repos that don't use vitest (mocha / jest / ava / lb-mocha). The
  install command called `node -e "require('vitest/package.json')"`
  to auto-detect the vitest major — unconditionally, so any non-
  vitest project hit a hard crash during `tools install --yes`.
  Now prefixed with `test -f node_modules/vitest/package.json ||
  { echo 'vitest not present — skipping'; exit 0; }` so the install
  no-ops cleanly when vitest isn't a target-repo dep.

- **Semgrep / pip-audit / ruff / pip-licenses / coverage dep pins
  colliding in the shared venv**. Pre-2.3.1 installed every Python
  CLI tool into one venv at `~/.cache/dxkit/tools-venv/`. semgrep's
  `tomli~=2.0.1` pin lost to pip-audit's newer tomli, breaking
  semgrep on repos where both tools installed. Every Python CLI
  (semgrep, ruff, pip-audit, pip-licenses, coverage) now uses
  `pipx install <tool>`, putting each in its own isolated venv
  under `~/.local/pipx/venvs/<tool>/`. Binaries symlink into
  `~/.local/bin/` which is already in `getSystemPaths()`'s probe
  list, so `findTool()` picks them up without further changes.
  Bootstrap fragment auto-installs pipx via `pip --user` when
  absent (handles PEP-668 Debian/Ubuntu with
  `--break-system-packages` fallback).

- **Graphify stays on the shared venv** — it's a Python *library*
  that our graphify.ts subprocess imports, not a CLI tool, so pipx
  doesn't apply. `TOOLS_VENV` narrows to graphify-only.

- **"Install command exited 0 without producing the binary" now
  reports as skipped, not failed**. Any install command can
  legitimately no-op (guarded installs like vitest-coverage);
  those no-ops shouldn't clutter the failure summary. Real
  failures (non-zero exit) still classify as `failed`.

### Known limitations (not blocking)

- `npm install @vyuhlabs/dxkit` still emits deprecation warnings for
  `inflight@1`, `glob@7`, `fstream`, `rimraf@2`, `lodash.isequal` —
  all transitive under `exceljs` (via `archiver` → `archiver-utils`).
  exceljs@4.4.0 is the latest available; the chain is upstream.
  Warnings only, no functional impact; would require either switching
  xlsx libraries (breaking) or upstream archiver modernization.

### Validation on vyuhlabs-platform/userserver

- `vyuh-dxkit tools` reports 12/13 tools found (vitest-coverage
  correctly listed as missing since lb-mocha is in use)
- `vyuh-dxkit tools install --yes` reports `0 installed, 1 skipped,
  0 failed` (clean)
- `vyuh-dxkit bom --xlsx --filter=top-level` completes in 17s,
  writes `.dxkit/reports/bom-YYYY-MM-DD.{md,xlsx}` cleanly

## [2.3.0] - 2026-04-24

Minor release — turns the `bom` report from enumeration (1700+ rows
of noise) into a **decision doc** (top 10 triage queue ranked by
composite exploit-risk). Every `DepVulnFinding` now carries five
exploitability signals — CVSS, EPSS, CISA KEV, reachability,
composite `riskScore` — that consumers can read individually or as
the ranked `Risk` column. `licenses` + `vulnerabilities` renders
gain parity with the new bom surface so any dxkit command shows the
same triage-relevant data.

Nine sub-commits (Phase 10h.5) landed behind PRs #4 / #5 / #6 /
#7 / #8 / #9 / #10 / #11 through the hardened 2.2.1 pipeline —
the first full release cut where every commit flowed PR → CI-green →
merge → tag → CI-publishes without deviation.

### Added — exploitability enrichers

- **EPSS** (`DepVulnFinding.epssScore`, 0.0–1.0) from FIRST.org's
  `api.first.org/data/v1/epss`. Batched (≤100 CVEs/call), session-
  cached, graceful offline fallback. Non-CVE primaries (GHSA /
  RUSTSEC / GO / PYSEC) resolve via OSV.dev alias lookup — no
  coverage gap across packs. (10h.5.1)

- **CISA KEV** (`DepVulnFinding.kev`, boolean) from the official
  catalog at `cisa.gov/.../known_exploited_vulnerabilities.json`.
  Single bulk fetch per process, O(1) lookup. Badge `⚠` in every
  render. (10h.5.2)

- **Reachability** (`DepVulnFinding.reachable`, tri-state) — does
  this repo's source actually import the vulnerable package?
  Built from per-pack `ImportsResult`'s specifier extraction;
  `specifierToPackage` handles TS scoped/bare, Python dotted
  modules, Go 3-segment module paths. Coarse name-level
  matching; undefined when no imports data available. (10h.5.3)

- **Composite riskScore** (`DepVulnFinding.riskScore`, 0–100) —
  `clamp(cvss*10 × kev? × (1+2*epss) × reach?, 0, 100)`. Formula
  documented in `src/analyzers/tools/risk-score.ts`. Null when
  CVSS missing (no fabrication from side signals). (10h.5.4)

- **"This Week's Triage"** section at the top of every bom report —
  top 10 advisories with riskScore ≥ 15, rationale composed from
  most decisive signals (KEV → reachable → CVSS → EPSS), fix
  column with "PROPOSAL:" prefix stripped. (10h.5.5)

### Added — decision-doc UX

- **`bom --filter=top-level`** drops transitive rows (1700+ → ~150
  on typical repos) while the `byTopLevelDep` rollup still reflects
  full blast radius — "upgrading `@loopback/cli` resolves 29
  advisories" survives when those 29 transitive rows are hidden.
  `BomEntry.isTopLevel` + `summary.filter` + `summary.unfilteredTotalPackages`
  ride the shape. (10h.5.0)

- **Nested-project aggregation** (default ON; `--no-nested` opts
  out). `src/analyzers/bom/discovery.ts` walks the repo,
  discovers every directory with a language manifest
  (package.json, pyproject.toml/requirements.txt/setup.py/Pipfile,
  go.mod, Cargo.toml, *.csproj/*.sln), runs per-root gather, and
  merges with dedup on `(package, version)`. `BomEntry.sources`
  unions the roots each package was found in; `isTopLevel`
  OR-merges; vulns dedup on `(id, package, installedVersion)`.
  Closes **D001a** — `bom platform/` previously missed
  `platform/userserver/` entirely. Side-benefit: naturally
  addresses **D003** (C# multi-project) since each `.csproj`
  becomes its own root. (10h.5.0b)

- **`LicenseFinding.releaseDate`** populated from the npm registry
  for every TS-ecosystem package. Closes **D006** — xlsx col 10
  ("Component Release Date") was previously empty. Bundled with
  the EPSS fetcher roundtrip. (10h.5.1)

- **`licenses` render** sorts top-level deps (⭐) first, transitive
  below. Adds `Direct` + `Released` columns. Matches bom's
  `--filter=top-level` ordering so cross-referencing the two
  reports Just Works. (10h.5.6)

- **`vulnerabilities` render (main, not --detailed)** per-advisory
  table now sorted by `riskScore` desc with `Risk` / `KEV` /
  `Reach` / `EPSS` columns alongside the existing fields. (10h.5.6)

### Fixed

- **D013** — graphify's shared Python venv moved from
  `/tmp/graphify-venv` (subject to systemd-tmpfiles sweep + race
  on first install) to `~/.cache/dxkit/tools-venv` (XDG persistent).
  Also fixed `Date.now()` script-tempfile collision class in
  graphify.ts via `fs.mkdtempSync`. Affects every Python-based
  tool dxkit installs (graphify, semgrep, ruff, pip-audit,
  pip-licenses, coverage). Legacy `/tmp/graphify-venv` path still
  probed, so existing installations aren't forced into a
  reinstall. (10f.2)

- **OSV.dev GHSA case-sensitivity** — `api.osv.dev/v1/vulns/<GHSA>`
  expects lowercase; npm-audit emits uppercase. `osv.ts`
  `DEFAULT_FETCHER` normalizes the alphabetic portion. Silently
  broke alias resolution for every TS finding pre-2.3.0.

### Changed — output directory

- **Reports moved from `.ai/reports/` to `.dxkit/reports/`**.
  Separates tool output (regenerated each run, can be gitignored)
  from AI-agent context (`.ai/sessions/`, `.ai/prompts/` —
  human-authored, version-controlled). All CLI commands + every
  scaffolded slash command / agent / template updated to the new
  path. Existing `.ai/reports/*.md` files become orphans after
  upgrade — acceptable since reports regenerate each run.

### Process

- First full release cut through the 2.2.1-hardened publish
  pipeline: 8 PRs, every one PR→CI→admin-squash-merge→main. Each
  dog-fooded the pre-push CI-mirror hooks landed in PR #3.

## [2.2.1] - 2026-04-23

Patch release hardening the publish pipeline after `v2.2.0`'s Publish
workflow failed with `403 — version already published`. The failure
was caused by a local `npm publish` that preceded the
Release-triggered CI publish, not a code defect — the tarball on npm
byte-matches main. No functional changes in this release; all work
is on the release path (tracked internally as D015).

### Added — publish pipeline guardrails

- **`scripts/require-ci.js` + `prepublishOnly` guard** — any `npm publish`
  invocation outside GitHub Actions now fails at the script hook with
  a clear error pointing to `CLAUDE.md §"Release procedure"`. Prevents
  accidental local publish before the registry is ever contacted.

- **`publishConfig.provenance: true`** — npm publishes now carry a
  GitHub Actions provenance attestation. Provenance requires an OIDC
  token that only exists inside Actions; tarball-mode publishes
  (`npm publish *.tgz`, which skips `prepublishOnly`) also fail outside
  CI. Belt-and-suspenders with the script guard.

- **Publish-workflow preflights** (`.github/workflows/publish.yml`) —
  before `npm publish` runs, the workflow now verifies (in order):
  1. tag `vX.Y.Z` matches `package.json` version `X.Y.Z`
  2. tagged commit is reachable from `origin/main` (blocks
     feature-branch tags)
  3. the `CI` workflow succeeded on the tagged commit SHA
  4. `X.Y.Z` is not already on npm (catches the exact 2.2.0 failure)

- **Explicit pack + publish + verify** — workflow packs the tarball,
  records its sha1, publishes that exact file, then fetches
  `npm view dist.shasum` and fails on mismatch. Eliminates drift
  between "what npm packed" and "what we audited."

- **Tarball workflow artifact** — every release archives the published
  `.tgz` as a workflow artifact (90-day retention) for post-mortem
  auditability.

### Documented — `CLAUDE.md`

New "Release procedure" section codifying PR → CI-green → merge → tag
→ CI publishes as the only path. Explicit "no local `npm publish`"
rule.

## [2.2.0] - 2026-04-23

Minor release adding Snyk-style top-level dep attribution across every
language pack. Answers "which direct manifest dep do I upgrade to fix
the most advisories" alongside the existing per-leaf-package reporting.
Drop-in upgrade — additive `topLevelDep?: string[]` field, no schema
bump required.

### Added — top-level dep attribution (Phase 10h.4)

- **`DepVulnFinding.topLevelDep?: string[]`** — per-advisory list of
  root manifest entries (direct + dev deps) that transitively pull the
  vulnerable package. Coarse name-level attribution (unions across
  multiple parents when the package is reachable from more than one
  top-level). Enables Snyk-style grouping: one advisory against
  `tar@7.5.9` surfaces as "under `@loopback/cli`" rather than just
  "tar has a CVE".

- **TypeScript pack** — BFS over `package-lock.json` (v2/v3) from
  each root `dependencies` / `devDependencies` entry. Pure parser
  `buildTsTopLevelDepIndex` unit-tested; benchmark on
  `vyuhlabs-platform`: 71/71 findings attributed across 31 vulnerable
  packages, `@loopback/cli` rollup = 29 advisories (matches Snyk UI).

- **Python pack** — BFS over `pip show` graph from packages with empty
  `Required-by`. Pure parsers `parsePipShowOutput` +
  `buildPyTopLevelDepIndex`. Venv detection now includes poetry
  (`poetry env info --path`), pipenv (`pipenv --venv`), and
  `$VIRTUAL_ENV` env var alongside the existing `.venv`/`venv` fast
  path — poetry with default `virtualenvs.in-project = false` now
  resolves.

- **Go pack** — BFS over `go mod graph` output, with `go.mod`'s
  `// indirect` markers filtering the seed set so only user-declared
  direct deps become top-levels. Pure parsers `parseGoModDirectDeps` +
  `buildGoTopLevelDepIndex`.

- **Rust pack** — BFS over `cargo metadata --format-version 1` resolve
  graph from each direct dep of `resolve.root`. Pure parser
  `buildRustTopLevelDepIndex`; maps package ids → names, collapses
  version variants.

- **C# pack** — **two-part expansion**. First,
  `dotnet list package --vulnerable` now uses `--include-transitive`,
  so transitive vulns (previously invisible) are surfaced. Second,
  attribution comes from walking `obj/project.assets.json` — pure
  parsers `parseProjectAssetsJson` + `buildCsharpTopLevelDepIndex`.
  Direct findings carry self-attribution; transitive findings gain
  `topLevelDep` from the assets-json graph. Degrades gracefully when
  the lockfile is absent (user hasn't run `dotnet restore`).

### Added — bom render surfaces top-level grouping

- **`BomReport.summary.byTopLevelDep: Record<string, BomTopLevelRollup>`**
  where `BomTopLevelRollup = { advisoryCount, maxSeverity, packages[] }`.
  Multi-parent advisories increment counters for each top-level they
  list, matching Snyk's rollup semantics.

- **Markdown "Top-Level Dep Groups" section** in `bom-<date>.md` —
  sorted by severity then advisory count. First row is the single
  upgrade that resolves the most critical/highest-volume issues. Caps
  at 30 top-levels, packages list truncated at 8 with "+N more".

- **Xlsx col 12 annotation** — each advisory line gains
  ` via <parent>` (single top-level) or ` via <parent> (+N more)`
  (multi-parent). Reviewer sees upgrade guidance directly in the
  spreadsheet cell. No suffix when `topLevelDep` is unset.

### Fixed — TS dep-vuln finding dedupe

- `gatherTsDepVulnsResult` now de-duplicates findings by
  `(package, installedVersion, id)`. npm-audit inlines the same
  advisory on every consumer's `via[]` across the vulnerability tree
  (e.g. minimatch's ReDoS appearing on `@loopback/cli`, `glob-parent`,
  `picomatch` simultaneously); the advisory-emission loop previously
  pushed N copies of one logical finding. Platform count 94 → 71,
  14 distinct dupe pairs → 0. Pre-existing from 2.1.0; caught during
  10h.4 evaluation.

### Notes

- Every pack degrades gracefully when its dep-graph source is missing:
  TS without `package-lock.json`, Python without a venv, Go without
  `go.mod`, Rust without `cargo metadata`, C# without
  `obj/project.assets.json`. Findings still emit; `topLevelDep` stays
  unset.

- Release validated against `vyuhlabs-platform` TypeScript benchmark.
  Python/Go/Rust/C# packs exercised via fixture-based unit tests
  (+53 new tests across the 4 non-TS language test files); real-world
  validation lands with 2.3.0's cross-ecosystem benchmark fixtures.

## [2.1.0] - 2026-04-23

Minor release adding two new analyzers and a shared XLSX converter.
Schema-compatible with 2.0.x for all pre-existing reports; introduces
two new report kinds (`licenses`, `bom`) and a schema v11 → v12 bump on
the detailed security report. Drop-in upgrade — no existing consumer
breaks.

### Added — license inventory

- **`vyuh-dxkit licenses [path]`** — per-pack dependency license
  inventory across TypeScript (license-checker-rseidelsohn), Python
  (pip-licenses), Go (go-licenses), Rust (cargo-license), and C#
  (nuget-license). Populates 11 fields per package (name, version,
  description, license type, license text, source URL, supplier,
  release date, etc.). Writes `.ai/reports/licenses-<date>.md`; with
  `--detailed` also a risk-categorized JSON + markdown flagging
  strong-copyleft, weak-copyleft, unknown-license, missing-attribution
  packages. TypeScript provider normalizes source URLs through
  `hosted-git-info` so `git+`/SCP/RFC-SSH variants collapse to canonical
  HTTPS.
- **`vyuh-dxkit bom [path]`** — Bill of Materials joining `licenses`
  with dependency vulnerabilities on `(package, version)`. One row per
  installed package-version with license metadata (cols 1-9, 15 per
  customer spec) AND per-package vulnerability rollup: max severity
  (col 11), per-advisory list with CVSS scores (col 12), and derived
  Tier-1 resolution proposal (col 13 — "Upgrade X to Y" when every
  advisory has a fixedVersion, "Upgrade <parent> (transitive fix)" when
  the fix is in a parent dep, "No fix available" otherwise). Detailed
  mode (`--detailed`) emits a risk-review markdown with 6 triage
  buckets (critical/high × no-fix/actionable, medium, low, license-
  scanner-gap). `--xlsx` / `to-xlsx` produce the 15-column workbook
  the customer's spreadsheet workflow expects, byte-identical headers.
- **`vyuh-dxkit to-xlsx <json>`** — shared converter. Reads any
  licenses or bom detailed JSON and emits the canonical 15-col XLSX.
  Lets downstream tooling stash JSON and render on demand without re-
  running the analyzer.

### Added — dependency-vulnerability per-advisory detail

- Every language pack's `depVulns` provider now populates
  `DepVulnFinding[]` alongside the existing per-severity counts. Counts
  remain per-package (for `vulnerabilities` command parity); findings
  are per-advisory with id (GHSA/CVE/PYSEC/GO/RUSTSEC), installed +
  fixed versions, CVSS score, aliases, summary, references, and tool
  attribution. `gatherDepVulns` forwards findings into
  `SecurityReport.summary.dependencies.findings` so the
  `vulnerabilities --detailed` command renders per-advisory inventory
  (previously: counts only).
- `DepVulnFinding` extended with nine optional fields for tier-layered
  enrichment: `tool` (denormalized producer, renamed from unused
  `source`), `cvssScore`, `upgradeAdvice`, `reachable`, `epssScore`,
  `kev`, `riskScore`, `breakingUpgrade`, `aliases`, `summary`,
  `references`. Per-pack Tier-1 providers populate what their native
  tools emit; Tier-2/3/4 enrichment lands in later 10h sub-phases.
- Cross-pack OSV enhancement: `enrichOsv` (renamed from
  `enrichSeverities`) now returns `{severity, cvssScore}` pairs, and
  a new `resolveCvssScores` helper does batched alias-fallback
  lookups. Fills the CVSS gap for GO-\* records (bulk of which carry
  no severity but whose CVE aliases do) and PYSEC-\* records. TS pack
  is a no-op via this path (npm-audit already ships CVSS at ~100%);
  Python cvssScore coverage jumped from 0% → 100% on the fixture,
  Go from 0% → 55% on vyuhlabs/Tickit.
- **Go pack parser fix** — `govulncheck -json` emits pretty-printed
  multi-line JSON, not single-line ndjson. Previous `split('\n')`
  parser silently failed on every invocation; new balanced-brace
  `parseJsonStream` helper in `runner.ts` handles both shapes and
  string-literal escapes. Reusable for any future tool that
  pretty-prints.
- **Python pack manifest gating** — previously `pip-audit` ran with
  no project context and silently scanned dxkit's own graphify-venv.
  Now routes by manifest: `pip-audit <cwd>` for pyproject.toml/setup.py
  projects, `pip-audit -r requirements.txt` for requirements projects,
  null otherwise. Corrected platform audit: 97 → 94 dep vulns (3
  phantom graphify-venv pip findings removed).

### Added — tool registry

- TypeScript pack: `license-checker-rseidelsohn` (license inventory)
- Python pack: `pip-licenses` (license inventory)
- Go pack: `go-licenses` (license inventory, `go install golang.org/...`)
- Rust pack: `cargo-license` (license inventory, `cargo install`)
- C# pack: `nuget-license` (license inventory, `dotnet tool install`)

All bundled into per-pack provider commits so `findTool` + provider
invocation land together (CLAUDE.md rule 1).

### Changed

- **Vulnerability report labelling** — Executive Summary now cleanly
  separates "Code Findings" (your team patches source) from
  "Dependency Vulnerabilities" (upgrade the dep) into two tables with
  a combined total. Previously a single table labelled just "Severity
  / Count" implied dep vulns were included, which they weren't. The
  shallow report also now renders a worst-first per-advisory dep-vuln
  table (50-row cap), so `vulnerabilities` without `--detailed` is
  already actionable.
- **Security detailed schema** — bumps from `"11"` → `"12"` for the
  new `summary.dependencies.findings: DepVulnFinding[]` field in the
  JSON output. Additive — consumers reading just the old keys stay
  compatible.
- **`DepVulnFinding.source` repurposed to `DepVulnFinding.tool`**.
  The former `'osv.dev' | 'tool-default' | 'tool-reported'` enum was
  dead code (declared, never written or read). Field now holds the
  producer tool name (`npm-audit` / `pip-audit` / `govulncheck` /
  `cargo-audit` / `dotnet-vulnerable`) so per-finding attribution
  survives merges across multiple providers.

### Fixed

- **npm-audit `fixAvailable` misinterpretation** — `fix.name` is the
  top-level upgrade target, not the vulnerable package itself. Prior
  code blindly assigned `fix.version` as `fixedVersion` on every
  advisory, producing absurd output like "uuid@13.0.0 → Upgrade to
  3.2.1". Now branches on `fix.name === pkgName`: direct fix sets
  `fixedVersion`; transitive fix sets `upgradeAdvice` with parent-
  package guidance ("Upgrade @loopback/cli to 5.0.0 [major]
  (transitive fix)"). Surfaced ~20 false positives on platform audit
  covering uuid/octokit/tar/undici/underscore.
- **bom xlsx col 11/12/13 fill on non-vulnerable rows** — previously
  blank, creating "scanned-clean vs not-scanned" ambiguity. Now fills
  "None" / "No action required" so reviewers see at a glance which
  rows dxkit actually processed.

### Runtime dependencies added

- `exceljs ^4.4.0` — XLSX writer. Adds ~80 transitive deps (bumps
  dxkit's own license-checker count 242 → ~325).
- `hosted-git-info ^9.0.2` + `@types/hosted-git-info ^3.0.5` — URL
  canonicalisation (source URL column of licenses/bom).

## [2.0.1] - 2026-04-22

Patch release following the 2.0.0 smoke-test. No API or schema changes —
drop-in upgrade from 2.0.0.

### Fixed

- **`HealthReport.toolsUsed` now includes every external scanner that
  actually ran.** Pre-2.0.1 the list was synthesized only from
  `capabilities.lint` + `capabilities.depVulns`, so `semgrep` (code-
  pattern scanner, `capabilities.codePatterns`) and `jscpd` (clone
  detector, `capabilities.duplication`) didn't appear in the `health`
  command's tool list even though they ran during
  `gatherCapabilityReport`. `gitleaks` and `graphify` appeared only
  because `tools/parallel.ts` pushed them separately. Now
  `toolsFromCapabilities` mirrors all six external-scanner envelopes
  (lint, depVulns, secrets, codePatterns, duplication, structural);
  Layer 2's pushes dedupe via the existing `!includes(t)` guard.
  Pseudo-tool envelopes (`imports.tool = 'ts-imports'`,
  `testFramework.tool = 'typescript'`) stay out of the list — those
  are language-pack identifiers, not external tools.

## [2.0.0] - 2026-04-22

**BREAKING RELEASE.** The deterministic analyzer architecture introduced in
1.6.0 matured through an explicit capability model during Phase 10e. Language
packs now expose data exclusively through typed capability providers
(depVulns, lint, coverage, testFramework, imports) routed through a
`CapabilityDispatcher`; global scanners (gitleaks + grep-secrets fallback,
semgrep, jscpd, graphify) register under the same model. The legacy
`gatherMetrics` channel and its aggregation helpers are removed.

### Breaking changes — JSON schema v10 → v11

- Detailed reports now emit `"schemaVersion": "11"` (was `"10c.1"`).
- `HealthReport.dimensions.*.metrics` shed all capability-data echoes
  (`lintErrors`, `lintWarnings`, `lintTool`, `secretFindings`,
  `depVulnCritical`/`High`/`Medium`/`Low`, `depAuditTool`,
  `testFramework`, `coveragePercent`, `commentedCodeRatio`,
  `maxFunctionsInFile`, `deadImportCount`, `godNodeCount`,
  `communityCount`, `avgCohesion`, `orphanModuleCount`). Consumers read
  these from `report.capabilities.*` now.
- `HealthReport.capabilities` is the new canonical sub-object carrying
  typed envelopes (`depVulns`, `lint`, `coverage`, `imports`,
  `testFramework`, `secrets`, `codePatterns`, `duplication`,
  `structural`).
- `HealthMetrics` narrowed to ~30 non-capability fields (filesystem
  counts, grep markers, doc / config flags, language breakdown).
- `QualityReport`, `SecurityReport`, `TestGapsReport`, `DevReport` shapes
  unchanged — their detailed variants still bump to v11 for release
  consistency.

### Added

- Capability dispatcher (`src/analyzers/dispatcher.ts`) with per-`(cwd,
  capId)` in-memory caching and provider-failure isolation.
- Nine capability descriptors with bespoke aggregate functions
  (depVulns/lint sum counts, coverage/testFramework last-wins,
  secrets/codePatterns union findings, duplication sums + re-weights,
  structural last-wins, imports unions per-pack graphs).
- Multi-provider support per capability: `GlobalCapabilities` slots take
  provider arrays, so fallbacks and opt-in scanners compose cleanly.
- `grep-secrets` fallback provider: 7 regex patterns (hardcoded-password,
  api-key, secret, private-key, AWS access key, GitHub token, Anthropic
  key) that activate when `gitleaks` is absent. Preserves degraded-
  environment secret coverage.
- `src/analyzers/tools/package-json.ts`: direct `fs.readFileSync` +
  `JSON.parse` helper for `npmScriptsCount` and `nodeEngineVersion`,
  replacing the prior `node -e` subprocess pair.

### Removed

- `LanguageSupport.gatherMetrics` optional method — every pack now
  exposes data through `capabilities`.
- `LangMetrics` type and `mergeMetrics` / `AGGREGATED_VULN_FIELDS`
  helpers.
- `gatherGitleaksMetrics`, `gatherGraphifyMetrics` legacy bridge
  functions (capability providers + memoized outcome helpers replace
  them).
- `getSemgrepRulesets`, `getToolDef`, `runRegisteredTool`,
  `EVOLVING_FILES`, `src/analyzers/index.ts` barrel file — all
  unreferenced after the refactor.
- Pre-2.0 child-process + bash orchestration in `tools/parallel.ts`;
  gitleaks and graphify now run in-process with per-cwd memoization.

### Changed

- Scorers consume a `ScoreInput = { metrics, capabilities }` bundle
  (was: flat `HealthMetrics`). Same byte-identical scoring formulas.
- `HealthReport.toolsUsed` synthesizes per-pack tool names
  (`eslint`, `npm-audit`, `ruff`, `pip-audit`, `golangci-lint`,
  `govulncheck`, …) directly from `capabilities.lint.tool` and
  `capabilities.depVulns.tool` rather than from the deleted per-pack
  gatherMetrics emissions.

### Migration

- Replace `report.dimensions.quality.metrics.lintErrors` →
  `(report.capabilities.lint?.counts.critical ?? 0) +
  (report.capabilities.lint?.counts.high ?? 0)`.
- Replace `report.dimensions.security.metrics.secretFindings` →
  `report.capabilities.secrets?.findings.length ?? 0`.
- Replace `report.dimensions.security.metrics.depVulnCritical` →
  `report.capabilities.depVulns?.counts.critical ?? 0` (and similarly
  for high/medium/low).
- Replace `report.dimensions.testing.metrics.coveragePercent` →
  `Math.round(report.capabilities.coverage?.coverage.linePercent ?? 0)`.
- Replace `report.dimensions.testing.metrics.testFramework` →
  `report.capabilities.testFramework?.name`.
- Replace `report.dimensions.quality.metrics.maxFunctionsInFile` →
  `report.capabilities.structural?.maxFunctionsInFile`.
- No changes required for non-`health` commands — `vyuh-dxkit
  vulnerabilities`, `test-gaps`, `quality`, `dev-report` keep their
  report shapes unchanged.

## [1.6.1] - 2026-04-21

Patch release with two CLI bug fixes found while regenerating dxkit's own
reports. No API or schema changes — drop-in upgrade from 1.6.0.

### Fixed

- **CLI positional paths are now resolved to absolute before analyzers run.**
  Previously, `vyuh-dxkit health .` (or any other analyzer command invoked
  with `.`) propagated the literal `"."` into Layer 2 child worker processes
  (cloc, gitleaks, graphify), which run from `dist/analyzers/` rather than
  the target repo. The `.` then resolved against the worker's cwd and cloc
  happily scanned dxkit's own compiled `dist/*.js` output — producing
  bogus language breakdowns like "JavaScript 90%, TypeScript 10%" on
  TypeScript-only repos. The CLI now wraps all 6 positional-path sites
  with `path.resolve()` at the boundary, so bare `.` / `./foo` / `../bar`
  arguments work as users expect. Affects `health`, `vulnerabilities`,
  `test-gaps`, `quality`, `dev-report`, and `tools`.
- **Vulnerability report section numbers are now dynamic.** Previously,
  empty finding categories (Secrets / Code Patterns / Config Issues /
  Dependencies) were skipped but their hardcoded section numbers were
  not renumbered, so a report with only secrets + dep vulns rendered as
  `## 1.` → `## 4.` with 2 and 3 mysteriously missing. Sections are now
  numbered with a running counter that advances only when a section
  actually renders. Output is purely cosmetic-identical when all four
  categories have findings; skipped categories no longer leave holes.

### Internal

- `chore: sync package-lock.json to 1.6.0` — the 1.6.0 release commit
  bumped `package.json` but not the lockfile. Every `npm install` since
  has surfaced as `M package-lock.json`. Now consistent.

## [1.6.0] - 2026-04-18

This release transforms dxkit from a scaffolder into an analyzer-and-scaffolder.
Five native CLI commands run deterministic analyses against any repo — no LLM
required, reproducible scores, agent-consumable JSON output. The scaffolding
capability is unchanged.

### Added

#### Native analyzer CLI (new primary capability)

- **`vyuh-dxkit health [path]`** — 6-dimension score (Testing, Code Quality,
  Documentation, Security, Maintainability, Developer Experience) with
  overall grade A–F. Runs in 10–20s on mid-size repos.
- **`vyuh-dxkit vulnerabilities [path]`** — gitleaks secret scan + semgrep SAST
  + `npm audit` / `pip-audit` / `govulncheck` / `cargo-audit` dependency
  vulnerabilities. Findings grouped by rule with severity + CWE category.
- **`vyuh-dxkit test-gaps [path]`** — coverage artifact import with
  import-graph reachability fallback. Ranks untested files by risk tier
  (CRITICAL for auth/security, HIGH for large services, etc.).
- **`vyuh-dxkit quality [path]`** — Slop score (0–100) combining lint errors,
  `: any` density, console statements, TODO/FIXME, duplication % (jscpd),
  comment ratio, and hygiene markers. Ranked remediation actions.
- **`vyuh-dxkit dev-report [path]`** — git activity: commits, contributors,
  hot files, merge ratio, conventional-commit compliance, weekly velocity.
- **`--detailed` flag** on all analyzers — writes paired `<name>-detailed.md`
  + `<name>-detailed.json` with Evidence (file, line, rule, tool) and
  `RemediationAction<M>` entries ranked by projected score delta.
- **`--json` flag** — pure JSON on stdout, logs on stderr for clean piping.
- **`--verbose` flag** — per-tool timing to stderr.
- **`--no-save` flag** — skip markdown output.
- **`--since <date>`** (dev-report only) — bound the git activity window.

#### Tool registry and installer

- **`vyuh-dxkit tools`** — list detection status for all tools required by
  the detected stack. Multi-path detection (PATH → brew → npm-g → pipx →
  cargo → go → project `node_modules` → system probes).
- **`vyuh-dxkit tools install [--yes]`** — interactive or non-interactive
  install of missing tools via platform-specific commands (brew on macOS,
  user-local on Linux). No `sudo` required; tools install to `~/.local/bin`
  or equivalent.
- **21 tools integrated** across 6 languages:
  - Universal: `cloc`, `gitleaks`, `semgrep`, `jscpd`, `graphify`
  - Node/TS: `eslint`, `npm audit`, `@vitest/coverage-v8`
  - Python: `ruff`, `pip-audit`, `coverage` (coverage.py)
  - Go: `golangci-lint`, `govulncheck`
  - Rust: `clippy`, `cargo-audit`, `cargo-llvm-cov`
  - C#: `dotnet-format`
- **`nodePackage` field** on `ToolDefinition` — detects Node packages that
  have no CLI binary (e.g. vitest plugins) via `node_modules/<pkg>/package.json`.
- **`runRegisteredTool()`** — sanctioned path to run any registered tool,
  ensures all tool invocation goes through detection instead of hardcoded
  binary paths.

#### Coverage artifact import

- **Istanbul** (`coverage/coverage-summary.json` + `coverage-final.json`) —
  used by vitest, nyc, c8. Parses per-file line coverage + overall %.
- **coverage.py** (`coverage.json`) — Python.
- **Go coverprofile** (`coverage.out` / `cover.out`) — text format with
  module-prefix path resolution.
- **Cobertura XML** (`coverage.cobertura.xml`, `TestResults/<guid>/...`) —
  C# (coverlet) and Rust (`cargo llvm-cov --cobertura`).
- **lcov** (`lcov.info`) — Rust (`cargo llvm-cov --lcov`).

#### Import-graph test matching

- **TS/JS extractor** — static imports, `import(...)` dynamic, `require()`,
  `export * from` re-exports, multi-line imports, comment-stripping.
- **Python extractor** — `import X`, `from X import Y`, relative-dot imports.
- **Go extractor** — single-line `import "fmt"` + multi-line `import (...)`
  blocks with alias support. Module-based resolution via `go.mod`.
- **Rust extractor** — `use std::io`, nested paths, block `use std::{io, fs}`.
- **C# extractor** — `using X.Y;`, `using static`, `using Alias = X.Y;`.
- **Resolver** — relative-path resolution with extension fallback and
  directory-as-`index.ts` probing (TS/JS) or `__init__.py` (Python).
  Go resolves internal module paths via `go.mod` module prefix.
- **BFS walker** — up to 3 hops transitively, cycle-safe. External packages
  are correctly skipped.

#### Suppressions

- **`.dxkit-suppressions.json`** — silence known-false positives per tool
  without editing code. Format:
  ```json
  {
    "gitleaks": [
      { "rule": "generic-api-key", "paths": ["test/fixtures/**"], "reason": "..." }
    ]
  }
  ```
- Glob matcher supports `**`, `*`, `?`. A finding is suppressed when rule
  matches (exact or `*`) AND at least one path glob matches.
- Wired to gitleaks. Semgrep and slop-hook integrations follow.

#### CI + hooks hardening

- **CI enforces everything pre-push does, plus slop-vs-base diff.**
  `.github/workflows/ci.yml` now runs architecture check, slop check
  (diffing against the PR base branch via `DXKIT_SLOP_BASE`), tests with
  coverage, and coverage-threshold enforcement. `--no-verify` can no longer
  ship code that introduces slop.
- **`scripts/check-coverage.sh`** — reads `coverage/coverage-summary.json`,
  fails if line coverage below threshold (default 50%, configurable via
  `DXKIT_COVERAGE_THRESHOLD`). Wired into `.husky/pre-push` and CI.
- **`scripts/check-slop.sh` CI mode** — when `DXKIT_SLOP_BASE` env var is
  set, diffs against that ref instead of `--cached`. Pre-commit behavior
  unchanged.

#### Dogfood

- dxkit's own line coverage raised from ~19% to 59% in the course of
  building these analyzers. 423 tests across 21 files, all passing.
  Coverage threshold of 50% enforced on every push and PR.

#### Language-pack rearchitecture (10d.1.6)

- **`LanguageSupport` interface** — single-file-per-language architecture.
  Each language implements: detection, tool bindings, semgrep rulesets,
  coverage parsing, import extraction/resolution, metric gathering, and
  lint severity mapping. `src/languages/{python,typescript,csharp,go,rust}.ts`.
- **Registry dispatch** — `health.ts`, `tool-registry.ts`, `import-graph.ts`,
  `gather.ts`, and `quality/gather.ts` all dispatch through
  `detectActiveLanguages()` instead of per-language if-chains.
- **Old scattered code deleted** — `src/analyzers/tools/{node,python,go,
  rust,dotnet}.ts` removed (~583 LOC). Net reduction despite adding 5
  language packs + coverage parsers + import extractors.
- **Ruff severity mapping** — Python lint results now bucket ruff codes by
  prefix: S→critical, F/B→high, E/C→medium, W/N/D/I→low. Previously all
  results were counted as errors regardless of code.
- **C# `*Tests.cs` pattern** — test-gap analyzer now recognizes the C#
  naming convention (`FooTests.cs`, `Foo.Tests.cs`) that the old
  `*.test.*`/`*.spec.*`-only patterns missed.
- **`cargo-llvm-cov`** registered in TOOL_DEFS with detection + install.
- **Contract tests** — 46 tests validate every language pack: TOOL_DEFS
  key validity, extension format, wildcard patterns, detect() idempotency,
  completeness (all 5 required IDs registered).

#### OSV.dev severity enrichment + CVSS v4 (10d.2)

- **OSV.dev integration** — `src/analyzers/tools/osv.ts` looks up
  vulnerability IDs against `https://api.osv.dev/v1/vulns/{id}` and
  classifies them into critical/high/medium/low tiers. Session-scoped
  in-memory cache. 10s per-request timeout with offline fallback.
- **Full CVSS v4.0 calculator** — `src/analyzers/tools/cvss-v4.ts` with
  the 270-entry macrovector → base-score lookup table (BSD-2-Clause,
  ported verbatim from FIRST.ORG's reference implementation, attributed
  in `THIRD_PARTY_NOTICES.md`). Handles equivalence-class computation,
  severity-distance refinement, and rounding per spec. Critical for
  modern CVEs (2025+) that publish v4 vectors exclusively.
- **Python pack (`pip-audit`)** — previously bucketed every finding as
  medium. Now extracts vuln IDs and looks each up via OSV. Unknown or
  unreachable IDs keep the legacy medium bucket. Verified on
  CVE-2025-8869 (pip tar symlink → v4 5.9 → medium, matches NVD).
- **Go pack (`govulncheck`)** — ndjson findings reference OSV IDs.
  We now prefer the advisory's embedded severity (govulncheck inlines
  the full OSV record), only falling back to the OSV.dev API when
  severity data is missing. Unknown IDs bucket as high (govulncheck's
  legacy default).

#### Lint severity tiers across all packs

Each language pack now exposes `mapLintSeverity(ruleId)` that tiers
findings into critical/high/medium/low. `gatherMetrics` still collapses
to the legacy `lintErrors`/`lintWarnings` fields (critical+high →
errors, medium+low → warnings) for backcompat.

- **TypeScript (ESLint)** — security plugins (`security/*`,
  `security-node/*`) and code-injection built-ins (`no-eval`,
  `no-new-func`, `@typescript-eslint/no-unsafe-eval`) → critical;
  correctness bugs (`no-undef`, `no-unreachable`, `no-dupe-*`,
  `@typescript-eslint/no-unsafe-*`, `react-hooks/rules-of-hooks`) → high;
  best practices (`no-console`, `prefer-const`,
  `@typescript-eslint/no-explicit-any|no-unused-vars`,
  `react-hooks/exhaustive-deps`) → medium; style plugins
  (`prettier/*`, `import/*`, `react/*`, `jsx-a11y/*`, `unicorn/*`) → low.
  Unknown rules fall back to ESLint's severity floor.
- **Go (golangci-lint)** — tier by `FromLinter`: `gosec` → critical;
  `govet`/`staticcheck`/`typecheck`/`errorlint`/`ineffassign`/`unused`/
  `bodyclose`/`sqlclosecheck`/`noctx` → high; `errcheck`/`gocritic`/
  `revive`/`gocyclo`/`gosimple`/`unparam`/`gocognit` → medium; `gofmt`/
  `goimports`/`stylecheck`/`whitespace`/`misspell`/`lll` → low.
- **Rust (clippy)** — hand-catalogued correctness-group lints:
  15 memory-safety / UB lints (`uninit_*`, `transmuting_null`, `cast_ref_to_mut`,
  `invalid_atomic_ordering`, …) → critical; 35+ correctness-bug lints
  (`panicking_unwrap`, `never_loop`, `out_of_bounds_indexing`,
  `ifs_same_cond`, `logic_bug`, …) → high; rustc-native lints → medium;
  all other clippy groups (style, perf, pedantic, nursery, cargo) → low.
- **C#** — `mapLintSeverity` intentionally omitted: `dotnet-format` is
  a formatter, not a tiered linter. Documented in pack source with a
  TODO pointer to a future `dotnet build --verbosity quiet` integration
  that would extract CS*/CA*/IDE* diagnostic codes.

#### Dep-vuln aggregation across language packs

- **`mergeMetrics` now sums `depVuln*` counts** instead of overwriting.
  Mixed-stack repos (e.g. Node + Python) previously had whichever pack
  ran last silently clobber earlier packs' vuln counts. Now pip-audit
  and npm-audit findings add together. `depAuditTool` likewise joins
  with `, ` (e.g. `"pip-audit, npm-audit"`).
- **Meta-tool classifier fix** — `src/analyzers/security/*.ts` files
  matched `CRITICAL_PATTERNS` by name (`/security/i`) and showed up in
  test-gaps as critical untested code. They're analyzer modules, not
  app security code. Added path-prefix exception (`^src/analyzers/`,
  `^tmp/`, `^scripts/`) that downgrades these to their structural tier.
- **C# dotnet-format violations** reclassified from `lintErrors` to
  `lintWarnings` — they're formatting issues (indentation, spacing),
  not correctness errors. No longer inflates the quality/slop error
  count.

#### Async language-pack contract

- **`gatherMetrics` is now async** (`Promise<Partial<HealthMetrics>>`).
  Enables network-dependent enrichment (OSV lookups). The full analyzer
  chain — `analyzeHealth`, `analyzeQuality`, and the CLI commands —
  threads async end-to-end. Bonus: the 5 language packs now run through
  `Promise.all` in health.ts instead of sequentially.
- **`timedAsync`** helper added alongside existing `timed` in
  `src/analyzers/tools/timing.ts` for per-tool verbose timing of
  async gatherers.

### Changed

- **`vitest.config.ts`** now generates Istanbul summary + JSON reporters when
  `--coverage` is passed. Coverage output in `coverage/`.
- **Signal precedence in `test-gaps`** — coverage artifact now *overrides*
  filename match for files it measured. Previously all three signals OR'd
  together, which wrongly credited files like `cli.ts` when a test had a
  similar basename but didn't actually import the module. Now: artifact
  authoritative where present, import-graph for files it didn't see,
  filename-match as last resort.
- **`.husky/pre-push`** — now runs `npm run build && vitest run --coverage &&
  bash scripts/check-coverage.sh`. Previously ran `vitest run --changed @{u}`
  without coverage.
- **`--json` output** — clean JSON on stdout now. Previously the logger
  header (`━━━ vyuh-dxkit ...`) leaked into stdout before the JSON payload.

### Fixed

- **`--json` stdout pollution** — `logger.header/info/success/warn/fail/dim/
  detected` route to stderr when JSON mode is active.
- **Filename matcher false positives** — `cli-init.test.ts` used to credit
  `cli.ts` via basename similarity even though it doesn't import it in
  process (uses `execFileSync`). After the precedence fix and import-graph
  matcher, dxkit's `test-gaps` agrees with V8 on every measured file.
- **Unused import warnings** — cleaned up six pre-existing unused imports
  that CI's `--max-warnings 0` would now catch.

### Internal / Architecture

- New modules: `src/analyzers/tools/coverage.ts`, `tools/suppressions.ts`,
  `tests/import-graph.ts`.
- `HealthMetrics.coveragePercent` now populated from the imported artifact
  when present; the existing Testing-dimension coverage bonus fires against
  line-level truth instead of being null.
- `HealthMetrics.secretSuppressed` — count of gitleaks findings filtered by
  `.dxkit-suppressions.json`.
- `ToolDefinition.nodePackage` — optional field for Node packages detected
  via `node_modules/<pkg>/package.json` rather than a binary in `.bin`.
- `vitest.integration.config.ts` — separate config for running only the
  `test/integration/**` suite (kept for developers who want to run the slow
  integration tests without the rest of the suite).

## [1.5.1] - 2026-04-10

### Fixed
- **`make setup` no longer aborts on npm install failure.** Peer dependency
  conflicts now show a helpful message instead of killing the entire script.
- **`--stealth` flag** for `dxkit init` — gitignore only files created in
  this run.

## [1.5.0] - 2026-04-10

### Fixed
- **Node version detection** no longer returns the minimum from
  `engines.node` ranges. `">=10"` previously returned `10`; now
  prefers the installed Node version. Exact pins (`"^20"`, `"20"`)
  still work directly. Priority: `.nvmrc` > `volta.node` >
  `engines.node` (exact pin) > installed version > range minimum >
  default.

## [1.4.0] - 2026-04-09

### Added
- **`.project.yaml` config source.** When `.project.yaml` exists in the
  target directory (typically written by `@vyuhlabs/create-devstack`),
  `dxkit init` reads it and uses it as the config source — skipping
  both `detect()` and interactive prompts. This enables greenfield
  projects where no language files exist yet. If the file is malformed
  or missing `project.name`, dxkit falls back to detection + prompts.
- **Library exports**: `hasProjectYaml()` and `readProjectYaml()` from
  the `@vyuhlabs/dxkit` package entry point.
- **README**: `.project.yaml` documentation, library API section, and
  config source priority.

## [1.3.0] - 2026-04-09

### Added
- **Library entry point** (`src/lib.ts`). Exports `detect()`,
  `processTemplate()`, `TemplateEngine`, and `DetectedStack` for
  programmatic consumption by downstream packages like
  `@vyuhlabs/create-devstack`. The npm `exports` and `main` fields now
  point to `dist/lib.js` so `import { detect } from '@vyuhlabs/dxkit'`
  works. The CLI binary (`vyuh-dxkit`) is unaffected.
- **Path-scoped auto-activation** (`paths:` frontmatter) on four shipped
  skills, so they auto-load whenever Claude Code is touching a matching
  file — even if the user's prompt doesn't name the tool:
  - `gcloud` — `**/cloudbuild.{yaml,yml}`, `**/.gcloudignore`, `**/app.yaml`
  - `pulumi` — `Pulumi.{yaml,yml}` and stack variants
  - `secrets` — `**/.env*`, `**/.infisical.json`
  - `test` — common test file patterns across TypeScript, JavaScript,
    Go, Python (`**/*.test.*`, `**/*_test.go`, `**/test_*.py`,
    `**/__tests__/**`, `**/tests/**`)

  This is additive — descriptions still drive activation for everything
  else, and the eight intent-driven skills (`build`, `deploy`, `doctor`,
  `learned`, `quality`, `review`, `scaffold`, `session`) remain
  description-only, since path-scoping would over- or under-trigger them.
- **Test suite** (Vitest). Unit tests for `detect()` against fixture project
  trees, plus an integration test that runs the built CLI against a tmp dir
  and asserts on the generated `.claude/` tree.
- **Lint + format toolchain.** ESLint flat config with `typescript-eslint`,
  Prettier, and `eslint-config-prettier`. CI enforces both with
  `--max-warnings 0`.
- **Git hooks** via husky + lint-staged. Pre-commit auto-fixes staged files
  and runs `tsc --noEmit`. Pre-push runs affected tests
  (`vitest run --changed @{u}`) with a graceful fallback to the full suite.
- **`.git-blame-ignore-revs`** so formatting commits don't pollute blame.

### Changed
- **GitHub Actions Node version bumped from 20 → 22** in both `ci.yml` and
  `publish.yml`. Removes the Node 20 deprecation warning ahead of the
  2026-06-02 runner cutoff. `.nvmrc` updated to match. The package's
  `engines.node: ">=18"` constraint is unchanged — consumers on Node 18+
  are unaffected.
- **One-time Prettier baseline** applied across the existing source. The
  baseline commit is registered in `.git-blame-ignore-revs`.

### Fixed
- Removed three unused-variable / unused-import dead-code spots in
  `src/generator.ts` and `src/codebase-scanner.ts` that ESLint flagged.

## [1.2.1] - 2026-04-06

### Fixed
- Add missing `repository`, `homepage`, `bugs`, and `author` fields to
  `package.json` so npmjs.com surfaces a "Repository" link to
  https://github.com/vyuh-labs/dxkit. These fields were accidentally
  omitted from the 1.2.0 publish during the repo split.
- Include `LICENSE` and `CHANGELOG.md` in the published tarball.

## [1.2.0] - 2026-04-06

### Changed
- **Repository moved** to its own home at https://github.com/vyuh-labs/dxkit.
  Previously developed inside `vyuh-labs/codespaces-ai-template-v2`. The npm
  package name (`@vyuhlabs/dxkit`) is unchanged — `npx @vyuhlabs/dxkit init`
  works exactly as before.
- Package is now self-contained: templates live in `src-templates/` inside the
  repo instead of being copied from a parent monorepo at build time.

### Added
- `LICENSE` (MIT), `CHANGELOG.md`, `CONTRIBUTING.md`.
- GitHub Actions: `ci.yml` (typecheck + build + pack-dry on push/PR) and
  `publish.yml` (publish to npm on GitHub release).

## [1.1.0] - 2026-04-06

### Added
- Strategic planner and plan executor agents (reports → KPIs → plans → execution).
- Feature development loop: `feature-planner` and `feature-builder` agents.
- Pattern-based tasks in the planner; pattern sweep in the plan executor.
- Stealth mode, dashboard, and expanded command/agent set (26 commands, 12 agents).

## [1.0.0] - 2026-03

### Added
- Initial public release of `@vyuhlabs/dxkit`.
- `init` command with auto-detect for languages and frameworks.
- Drop-in `.claude/` generation: agents, commands, skills, rules, settings.
- `--full` mode that also seeds devcontainer, Makefile, CI, and project scripts.
- `doctor` and `update` commands.
