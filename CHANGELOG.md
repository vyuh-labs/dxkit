# Changelog

All notable changes to `@vyuhlabs/dxkit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.11.1] - 2026-06-17

### Line-aware passive context hook

- **The PreToolUse context hook now uses the line the agent is reading.** When a
  `Read` carries an `offset`, the hook injects the *location's* structural
  neighborhood — the enclosing symbol plus its direct callers/callees, and the
  file's cross-file role — instead of only a flat file-level symbol map. Reading
  the body of a function now yields "you're inside `addUser`; it calls
  `getNextSequence`, `getRandomFutureDate`" rather than a list of every symbol in
  the file. No source text is injected (the `Read` already returns the lines); the
  hook adds only the structure the read doesn't show.
- **The hook also fires for symbol-less but connected files.** The old gate
  skipped any file with zero named symbols, which silently blanked out top-level
  config / entrypoint modules even when other files import them. The gate is now
  "fire iff there's useful structure" (named symbols *or* cross-file edges),
  applied uniformly to the file-level and line-level paths.
- The fail-open/additive contract is unchanged: when the graph has no structure
  for a location, the hook stays a silent no-op and the agent proceeds exactly as
  without dxkit.

No identity-scheme change; no migration. `vyuh-dxkit update` (or `npm i -D
@vyuhlabs/dxkit@latest`) picks up the refreshed hook scaffolding.

## [2.11.0] - 2026-06-16

### Code-graph quality, guardrail reliability on JS/TS, and a dogfooding pass

dxkit was run on its own repo and on real public targets, the way a user would.
That surfaced a cluster of graph-quality and guardrail-identity defects — several
HIGH — that the unit suite couldn't catch because they only appear on the default
configuration, end-to-end. This release closes them.

#### Code graph

- **JS/TS method extraction (via `graphifyy` 0.8.40).** Function symbols defined as
  `this.x = () => {}` (constructor-assigned methods), `exports.x` / `module.exports.x`,
  prototype methods, class arrow fields, and function expressions are now captured.
  Previously only top-level declarations, `const` arrows, and class-method shorthand
  were, so on expression-style JS and CommonJS the bulk of callable symbols — and any
  call edges to them — were invisible. On a constructor-style DAO, a file goes from 1
  captured symbol to all of its methods. (Fixed upstream in
  [safishamsi/graphify#1323](https://github.com/safishamsi/graphify/pull/1323).)
- **The code graph is restricted to source files.** graphify also parses `.md`
  (headings → nodes) and `.json` (config + lockfile keys → nodes); on a JS repo that
  made the graph ~92% non-code (a `package-lock.json` alone outweighed all application
  code). A source-extension allowlist, sourced from the language registry, keeps the
  graph to actual code — node counts, communities, hot-files, api-surface, and the
  context-hook's file summaries all stop being diluted by docs/config.

#### Guardrail + finding identity

- **Dependency-vulnerability identity is now environment-independent.** The
  fingerprint hashed `(package, installedVersion, id)`; the installed version is only
  resolvable when the dependency tree is installed (`npm-audit` reads `node_modules`),
  so a lockfile-only scanner — or any scan in an environment without `node_modules` —
  omitted it, and the **same advisory forked into two identities by scan environment.**
  Identity is now `(package, canonicalAdvisoryId)`: the version is display metadata, not
  identity, and the advisory id is canonicalized across namespaces (GHSA → CVE → raw) so
  different scanners agree on the same vulnerability.
  **Migration:** dep-vuln fingerprints change. `ref-based` baselines: nothing to do.
  `committed-full` baselines: run `vyuh-dxkit baseline create --force` once; the
  transition run shows dep-vulns as resolved+added (non-blocking) until re-baselined.
  Fingerprint-allowlisted dep-vulns (rare) need re-adding.
- **Secret + code-pattern finding identity is anchored to content, not line position.**
  A finding's durable fingerprint hashed its file plus a 3-line window, so any edit that
  shifted a finding more than three lines re-minted its identity — which silently
  stranded the allowlist entry pinned to it (the suppression stopped matching) and
  churned the baseline on edits that never touched the finding. Identity now derives from
  *what the finding is*, computed only from inputs dxkit derives itself — never a scanner's
  captured text or an environment-derived salt: a secret from a tool-independent constant
  plus its file plus an in-file ordinal (no captured value, no salt — so the same leak gets
  one identity whether gitleaks or the grep fallback found it, and identically across a
  developer's machine and CI); a code-pattern finding from its enclosing symbol (resolved
  from the code graph, or the file when no symbol resolves) plus a hash of the matched span
  plus an in-symbol ordinal; a config finding (`.env`-in-git) from `(rule, file)`. The line
  number becomes display metadata. A finding keeps its identity when it moves and re-mints
  only when the matched construct — or its enclosing function — actually changes, so
  allowlist entries and baselines survive refactors and unrelated edits. Ingested SARIF
  findings (Snyk Code / CodeQL) earn the same code anchor from the engine's reported
  snippet. When no anchor is resolvable (e.g. a scanner that surfaces no matched snippet)
  identity falls back to the previous line-window hash, so every finding still has a stable
  id.
  **Migration — one command:** secret/code/config and dep-vuln fingerprints change once.
  Every artifact now records the identity scheme it was written under, and the upgrade is
  automatic:

  ```
  npm i -D @vyuhlabs/dxkit@latest
  vyuh-dxkit update     # detects the scheme change → migrates baseline + allowlist
  git add .dxkit && git commit -m "chore(dxkit): adopt this release"
  ```

  `update` rewrites the allowlist's fingerprints onto the new scheme (preserving every
  reviewed suppression — no re-reviewing, no copying fingerprints from reports) and
  regenerates the baseline, reporting what it re-anchored and flagging any entry whose
  finding is gone. Inline `dxkit-allow:` source annotations need nothing (they match by
  location). If you skip `update` and run the guardrail directly, it stops with an
  explicit "run `vyuh-dxkit update`" message instead of reporting every pre-existing
  finding as net-new. `ref-based` repos (no committed baseline) need nothing. Manual
  fallback if you'd rather not use `update`: `vyuh-dxkit baseline create --force` plus
  re-adding fingerprint-based allowlist entries by hand. Refresh committed SARIF
  snapshots (`vyuh-dxkit ingest …`) so ingested findings pick up content anchors; until
  refreshed they ride the line-window fallback.
- **`ref-based` guardrail is reliable on JS/TS repos.** ref-based gathers the prior side
  from a detached `git worktree` that has no `node_modules` or coverage report, so the
  build-artifact-dependent kinds (`duplication` via jscpd, `test-gap` via coverage)
  under-produced on the prior side and the current side's full set read as net-new. They
  are now excluded from both sides of a ref-based diff (symmetric), with a disclosure in
  the console + PR-comment output; `committed-full` remains the mode that gates them.
- **The analysis cache invalidates on `.dxkit/` input changes.** Editing
  `.dxkit/allowlist.json` had no effect until the commit changed, because the cache
  key tracked `.dxkit-ignore` but not the allowlist / policy / ingested-snapshot inputs
  that live under the same `.dxkit/` prefix the dirty-check excludes. The cache key now
  folds in a content digest of those inputs, so an allowlist edit re-scores immediately.

#### Toolchain

- **vitest 4.** Bumps vitest + `@vitest/coverage-v8` to v4 and clears the critical +
  high dev-tooling advisories in the vitest → vite → esbuild chain (plus `tmp`). All
  dev-only — none ship in `dist/`. No published-`engines` change.

## [2.10.0] - 2026-06-13

### Honest scoring under changing scanners, passive graph delivery, tool-robustness

Closes a set of brownfield-install and guardrail-matcher defects (the original
2.9.5 hardening), a class of scoring-honesty bugs (a Security score that could get
worse on an unchanged commit, with nothing explaining why), a defensive
tool-version-pin sweep, and the agentic-delivery redesign that finally routes the
code graph to the agent in a real fix workflow.

#### Scoring honesty

A Security score could drop on an **unchanged commit** — e.g. after an upgrade
enabled more scanners, or because a repo's own reviewed-and-accepted findings kept
holding it at a cap. The measurement was getting more honest, but the output
didn't explain it, and a properly-triaged repo couldn't recover its score. These
close that gap.

- **Symmetric unavailable-scanner caps.** A missing dependency-audit
  already capped the Security score at the uncertainty tier, but missing
  secret/code-pattern scanners silently scored as "0 findings" — so enabling
  those scanners later read as a phantom regression. The secret and code-pattern
  axes now get the same uncertainty cap when their scan didn't run, surfaced in
  `metrics.toolsUnavailable` and the standalone vuln-scan report.
- **The score respects the allowlist.** Findings reviewed-and-accepted as
  `false-positive` / `test-fixture` are now lifted from the Security penalties and
  caps (not just the guardrail), so a triaged repo scores honestly instead of
  staying capped on noise it has already accepted. `accepted-risk` / `deferred` /
  `mitigated-externally` still count — accepting a real risk can't earn an A. The
  vulnerability report and dashboard also annotate allowlisted findings and render
  `Subtotal N (M allowlisted)` so the raw counts are explained, not alarming.
- **Scanner-coverage drift is disclosed.** When the active scanner set grew
  since the last run, the vuln-scan report leads with a note: findings the new
  scanners surface are newly **visible**, not newly **introduced**. This is the
  root-cause explanation for a score that moved on unchanged code.
- **Secret severity is never lowered by file path.** A hardcoded credential keeps
  its natural severity whether it sits in production code or a test — the generic
  matcher can't tell a throwaway fixture from a real secret leaked into a test, so
  lowering severity by path would silently hide genuine leaks. Test-file noise is
  managed by the allowlist score-lift above (review fixtures once with
  `--category test-fixture`), not by hiding. The vulnerability report now flags how
  many secret findings sit in test files and points fixtures at the allowlist; the
  `dxkit-action` and `dxkit-allowlist` skills gain an explicit triage step
  (confirm fixture vs. real, allowlist fakes, rotate reals) so an agent handles
  this judgment per finding rather than blanket-ignoring the test directory.
- **Systematic test-file detection.** Tests organized under Jest's `__tests__/`
  directory — or named with the widespread `.unit.` / `.e2e.` / `.cy.` suffixes —
  were classified as source, corrupting the test ratio, coverage, and test-gap
  analysis. The cross-ecosystem test directories (`__tests__/`, `test/`, `tests/`,
  `spec/`, `e2e/`) are now recognized in any language; the TS pack gains the
  co-located suffix conventions.
- **Dependency-audit cleanup on Windows (EPERM).** The osv-scanner-fix temp-dir
  cleanup now retries with backoff and never throws out of its `finally`, so a
  Windows handle race (npm-install grandchildren / antivirus) can no longer
  discard the already-parsed fix plans — which had let dependency vulnerabilities
  go silently unreported.

#### Passive graph delivery (agentic value)

- **Context-hook fires on the tools agents actually use.** Pre-2.10 the graph
  context-hook fired only on the native `Grep`/`Glob` tools and only when the
  search pattern substring-matched a symbol name — so in a real fix workflow
  (agents search via `Bash grep` for a symptom, and read files directly) it
  almost never engaged. It now fires on **Read/Edit** (keyed on the file touched
  → that file's structural summary: symbols, callers, callees, module group),
  **Bash** (parses grep/rg commands; a named source file delivers its summary,
  else a symbol match on the pattern), and the original **Grep/Glob** path.
  Per-session, per-file dedup keeps it cheap; the FAIL-OPEN + ADDITIVE contract is
  preserved (any problem is a silent no-op). **Existing repos must re-run
  `vyuh-dxkit init`** (or update `.claude/settings.json`) to pick up the broadened
  `Read|Edit|Bash|Grep|Glob` matcher.

#### Snyk sync

- **`.dxkit-ignore` → `.snyk` exclude sync.** `allowlist export --snyk` now also
  emits the paths dxkit's analyzers skip (`.dxkit-ignore`) into the `.snyk`
  `exclude.global` block, so Snyk and dxkit agree on what's out of scope —
  mirroring the existing allowlist → `.snyk` ignore sync. An export carrying only
  exclusions still writes.

#### Tool-robustness + matcher rename fixes

Hardening pass closing a set of brownfield-install and guardrail-matcher
defects surfaced while benchmarking on Python 3.14 and large real-world repos.

#### Fixed

- **graphify on Python 3.14.** Python 3.14 made `forkserver` the default
  multiprocessing start method on Linux. graphify parallelises extraction with a
  `ProcessPoolExecutor`, and under spawn/forkserver each worker re-imports the
  generated script — re-running top-level extraction and crashing the run (no
  `.dxkit/reports/graph.json` written; every graph-dependent feature silently
  degraded). The generated script now wraps its execution body in
  `if __name__ == '__main__'` — graphify's own documented requirement for
  parallel extraction — so it is correct on every platform and start method
  (Linux fork/forkserver, macOS/Windows spawn) while keeping multi-core
  extraction. The previous forced `set_start_method('fork')` workaround is
  removed.
- **graphify cache redirect.** The on-disk cache is now redirected via
  graphify's public `extract(cache_root=...)` parameter instead of
  monkeypatching the internal `graphify.cache.cache_dir`, whose signature
  changed in graphifyy 0.8 (`cache_dir(root)` → `cache_dir(root, kind)`) and
  crashed the run. This also stops graphify's `atexit` stat-index flush from
  writing a stray `graphify-out/` into the scanned repo. The temp cache lives
  under the caller-owned script dir and is reclaimed after the process (and its
  atexit handlers) exit. `graphifyy` is pinned to `0.8.36`.
- **jscpd version pin.** jscpd is pinned to `4.2.5`. jscpd 5.x is a Rust
  rewrite that dropped the `--gitignore` flag (dxkit passed it → exit 2) and
  changed the report JSON schema dxkit parses.
- **Guardrail matcher — whole-file rename relocation.** Renaming a source
  file no longer reports its whole-file findings (test-gap, coverage-gap,
  test-file-degradation, god-file, stale-file, large-file) as removed + added,
  which falsely blocked the guardrail on a pure rename. The git-aware matcher
  now relocates these line-less, file-anchored findings through git's rename
  detection, keyed on `(renamed-path, kind)` so two different whole-file kinds
  on the same renamed file never cross-pair.

#### Tool-version pins

- **Defensive pin sweep.** Nine more dxkit-owned, deterministic-output scanners
  are pinned to their current releases (semgrep `1.165.0`, ruff `0.15.17`,
  pip-audit `2.10.1`, pip-licenses `5.5.5`, coverage `7.14.1`,
  license-checker-rseidelsohn `5.0.1`, golangci-lint `v1.64.8` — the v1 line,
  since v2 is a breaking rewrite on a separate module path — govulncheck `v1.3.0`,
  go-licenses `v1.6.0`), so a future breaking major can't silently change parsed
  output or exit codes the way jscpd 5.x and graphifyy 0.8 did. Five tools stay
  unpinned by design and are now documented as such: `eslint` + `vitest-coverage`
  (project-local — the consumer owns the version), `snyk` (a SaaS client that
  self-manages backend compatibility), `codeql` (a GitHub-managed bundle paired
  with query packs), and `cloc` (non-semver npm tag, lowest-risk schema). Proper
  schema-adaptive multi-version handling is planned for a later release.

#### Internal

- The version-pin guard test partitions every registry tool into pinned /
  unpinned-by-design / package-manager-tracked, so a tool can't be added or
  un-pinned without a deliberate decision.

## [2.9.4] - 2026-06-09

### Connecting findings + PRs to the people who know the code

Two features on a shared **active-owner model** — recency-weighted git history
scoped to who is still active, with bots and departed contributors filtered, the
change author excluded, and a bus-factor signal. Output renders names + GitHub
@handles, never raw emails (the @handle is both privacy-safe and the actionable
identifier — it's @-mentionable and feeds `gh --reviewer`).

- **`vyuh-dxkit reviewers`** suggests reviewers for a change (`--base <ref>` /
  `--staged`). It ranks the active owners of the touched files — recency-weighted,
  bot-free, departed-dev-aware, author-excluded — blended with `CODEOWNERS`, and
  warns on a bus factor of 1. The differentiation over a platform's naive
  last-touch suggestion is the activity grounding + active-only scoping. The
  `dxkit-pr` skill consumes it for a "Suggested reviewers" block and
  `gh pr create --reviewer`.
- **`--attribute` "who to ask"** on the detailed vulnerability / test-gaps /
  quality reports. For a pre-existing finding it adds a "Who to ask" column:
  line-level findings are `git blame`d and routed through the owner model (an
  inactive author is forwarded to the file's current owner); file-level findings
  (test gaps) attribute to the file's current owner. Opt-in and historical only —
  a net-new finding the guardrail just blocked was introduced by your own change,
  so its owner is the PR author. The column is honest that blame is last-touch,
  not necessarily who introduced the finding.

### Privacy

Author emails are used only as the internal identity key for clustering; they
are never rendered in any report or PR output. Everything user-facing is a
display name or a GitHub @handle.

## [2.9.3] - 2026-06-09

### Targetable fix loop + test generation

A workflow-depth release: make the fix loop targetable, add the test-writing
skill the suite was missing, and surface the riskiest test gaps first. Almost
entirely agent-skill + docs work; one contained, flag-gated analyzer change.

- **Scoped fixes.** `dxkit-action` can burn down one category at a time —
  dependency/BOM vulnerabilities, security, code quality, tests, or docs. It
  runs the report that partitions that dimension and works only that worklist,
  with the usual severity → reachability → blast-radius prioritization applied
  within the scope. Tests/docs scopes hand off to `dxkit-test` / `dxkit-docs`.
- **New `dxkit-test` skill** — the testing mirror of `dxkit-docs`. Reads the
  test-gaps worklist, orients on real behavior via the code graph, and writes
  meaningful tests that close the highest-risk gaps and move the Tests score
  without coverage theater (real assertions, the repo's framework, the suite +
  coverage run to prove it).
- **Test-gap blast-radius weighting.** With a code graph present
  (`test-gaps --graph-context`), the untested-file worklist is ranked within
  each risk tier by how many files depend on each one — the most-depended-on
  gaps surface first instead of just the largest by line count. Ordering only;
  the Tests score is unchanged (it derives from the tier counts). Files the
  graph can't resolve fall back to line-count ranking and are never dropped.
- **New `dxkit-pr` skill** — opens a pull request with a title + body grounded
  in the branch's real commits and diff (features, fixes, findings closed),
  the dxkit signals a reviewer needs (guardrail verdict, allowlist activity,
  score deltas), and a checklist tailored to the actual change. `dxkit-feature`
  now offers to write tests for a newly built surface (on confirmation) and
  hands off to `dxkit-test`.
- **Docs + roadmap refresh.** Every doc surface updated for the current skill
  set; the roadmap records why deep-SAST (code-path) reachability is deferred —
  it needs interprocedural taint analysis dxkit can't do natively (semgrep is
  intraprocedural; the call graph is too sparse), so the realistic path is
  surfacing an ingested engine's reachability rather than computing our own.

## [2.9.2] - 2026-06-09

### Allowlist lifecycle + Snyk credential ergonomics

A follow-up to 2.9.1 closing the self-service gaps the first customer
walkthrough surfaced: managing the allowlist after a re-baseline without
hand-editing JSON, propagating suppressions back to Snyk, and reading Snyk
credentials from a local `.env`.

- **`vyuh-dxkit allowlist remove <fingerprint>`.** Delete a single file-level
  entry from the CLI. `prune` still removes only expired entries; `remove`
  handles a stale-but-unexpired one (e.g. a confirmed-gone finding) — no more
  hand-editing `.dxkit/allowlist.json`.
- **Orphaned-entry audit.** `vyuh-dxkit allowlist audit --against-baseline`
  cross-checks every entry against the committed baseline and flags those whose
  fingerprint matches no current finding. Orphans are flagged for review, never
  auto-removed — re-baselining can churn fingerprints and an orphan may still
  suppress an intermittently-detected finding. The matcher counts both a
  finding's own fingerprint and any cross-tool fingerprints it absorbed, so an
  entry keyed on a collapsed contributor isn't falsely flagged.
- **`vyuh-dxkit allowlist export --snyk`.** The outbound half of the Snyk
  ignore sync (2.9.1 did the inbound SARIF-suppressions direction). Writes a
  `.snyk` policy ignoring every Snyk Code finding the team has allowlisted in
  dxkit, keyed on the Snyk rule id + path with the entry's reason + expiry, so
  the suppression propagates to Snyk's own gate. Round-trip stable with the
  inbound reader; only Snyk-originated, active entries export.
- **Opt-in `.env` loading for Snyk credentials.** `ingest --from-snyk` now
  reads `SNYK_*` keys from a local `.env` as a fallback — and ONLY those keys,
  never the rest of the file. A real exported env / CI secret always wins, so CI
  behavior is unchanged. `--no-env-file` opts out; `--env-file <path>` overrides
  the location. dxkit warns if the file looks committed to git.
- **New `dxkit-allowlist` skill** covering the full suppression lifecycle
  (review, audit, remove, prune, the re-baseline → re-point flow, and Snyk
  export), deferring the fix-vs-suppress decision back to `dxkit-action`.
- **Baseline refreshes steer to CI.** The skills and docs now warn against an
  ad-hoc local `baseline create --force` — it bakes the dev machine's scanner
  versions into the committed baseline, producing spurious tooling-drift
  warnings and phantom "resolved" findings on the next PR — and route refreshes
  through the bundled refresh workflow instead. The first local capture stays
  fine.

## [2.9.1] - 2026-06-08

### Cross-tool dedup + allowlist suppression + ignore sync

A follow-up to 2.9's ingestion: when two engines flag the same weakness, count
it once; make the allowlist actually suppress; and keep ignores in sync across
the tools dxkit ingests from.

- **Cross-tool dedup.** Two engines that flag one weakness at one site under
  different rule names no longer double-count. The aggregator collapses them via
  a canonical-rule map and a CWE-at-the-same-location bridge (only ever across
  different tools), keeping the higher severity and recording every contributing
  tool.
- **The allowlist now suppresses findings from the guardrail verdict.**
  Previously it was audit-only (category / reason / expiry + a PR-comment delta)
  while the baseline was the sole suppressor — a reviewed-and-accepted finding
  that landed outside the baseline still blocked. An active, unexpired allowlist
  entry now waives a matching finding from the verdict; expired entries stop
  suppressing, so the finding re-blocks the moment its window lapses. Suppressed
  findings surface in their own report section (console / JSON / markdown) —
  visible for review, never silently dropped, never counted as a live
  regression.
- **Robust matching across dedup.** A suppression keyed on a contributing
  fingerprint still matches the merged finding, so dedup nondeterminism between
  runs (which engine is present, line wobble) can't silently orphan an
  acceptance.
- **Allowlist expiry surfaced.** `vyuh-dxkit doctor` flags expired allowlist
  entries (their findings re-block) and entries expiring within the audit
  window. The allowlist docs gain a verdict-behavior + expiry-lifecycle section.
- **Ignore sync across tools.**
  - dxkit honors a SARIF result's own `suppressions`: a finding dismissed
    upstream (Snyk Code, CodeQL, Semgrep Pro) no longer re-surfaces here.
  - Ingested findings pass through the same `.dxkit-ignore` path exclusions as
    native findings — an external engine that scans vendored / generated /
    fixture code no longer leaks findings dxkit would never raise itself.

### Upgrading from 2.9.0 — re-baseline + re-point the allowlist

Cross-tool dedup changes the fingerprints of merged findings, so a baseline or
allowlist captured on 2.9.0 partially goes stale:

1. **Re-baseline:** `vyuh-dxkit baseline create --force`. (On a real polyglot
   repo, most findings keep their fingerprint; only the cross-tool merges
   change.)
2. **Re-point the allowlist:** run `vyuh-dxkit allowlist audit` to find entries
   that no longer match a finding, then re-add them against the fresh
   fingerprints from the guardrail output (`vyuh-dxkit allowlist prune` clears
   the stale ones). Robust matching prevents _future_ run-to-run orphaning but
   cannot bridge this one-time fingerprint change, so the re-point is manual.

## [2.9.0] - 2026-06-08

### Deep SAST — engine-agnostic interprocedural findings (2.9)

dxkit's bundled SAST (community semgrep) is intraprocedural and misses the
cross-function taint class — path traversal, information exposure, SSRF,
injection — that interprocedural engines (Snyk Code, CodeQL) catch. 2.9 makes
dxkit ingest any such engine's findings and treat them as first-class, rather
than try to re-detect that class. dxkit becomes the governance + agentic-fix
layer on top of any detector, grounded in the repo's own code graph.

- **`vyuh-dxkit ingest`** brings external SAST findings into dxkit:
  - `--from-snyk` brings in a project's Snyk Code findings and works on **every
    Snyk plan**. It reads the REST API quota-free where available (an
    Enterprise entitlement); on Free/Team plans the read returns 403 and dxkit
    automatically falls back to `snyk code test` (the Snyk Code product, which
    free includes — one test per run). `--snyk-cli` forces the CLI path. Set
    `SNYK_TOKEN`; org/project resolve from the flag, then `.vyuh-dxkit.json`,
    then the environment (`SNYK_ORG_ID` / `SNYK_PROJECT_ID`). dxkit reads these
    from the environment and does **not** auto-load a `.env` file.
  - `--sarif <file>` ingests SARIF 2.1.0 from any engine (CodeQL, a Snyk
    export, Semgrep Pro, Bearer).
  - `--codeql` runs CodeQL on demand for the active languages (open-source /
    GitHub Advanced Security only).
- Ingested findings are written to a committed `.dxkit/external/<engine>.json`
  snapshot and enter the security pipeline as first-class code findings:
  fingerprinted + deduped against native findings, recorded in the baseline,
  enforced by the guardrail, rendered in the vulnerability report, and
  graph-linked under `--graph-context` (blast radius + callers for the fix
  loop). The engine token is needed only at ingest time — every developer and
  CI run reads the committed snapshot.
- Persist the engine + Snyk project in `.vyuh-dxkit.json:deepSast` so
  `ingest --from-snyk` needs no flags after first setup.
- `--with-deep-sast-refresh` installs an on-demand CI workflow
  (`workflow_dispatch`) that re-ingests and commits the snapshot — the one
  place the token is used. A `method` input selects `api` (Enterprise,
  quota-free) or `cli` (free/team, one test per run); `api` auto-falls-back to
  the CLI. No-ops without the `SNYK_TOKEN` secret.
- New `dxkit-ingest` skill; `dxkit-action` and `dxkit-config` updated. CodeQL
  and Snyk support is declared per language pack; CodeQL is a guarded, opt-in
  tool kept out of the default toolchain.

### Guardrail reliability — the pre-push hook actually fires

A guardrail only protects a repo if the hook runs and resolves the right
dxkit. Hardening for brownfield repos, found by exercising the full install
path on a real project:

- **`init` / `update` declare `@vyuhlabs/dxkit` in `devDependencies`** (pinned
  to the installed version) whenever hooks or CI are installed. The hook and CI
  workflow resolve `./node_modules/.bin/vyuh-dxkit` before any global, so a
  project that wired them but never declared the package silently ran a stale
  global — or failed on a fresh CI runner. `doctor` gains a matching check.
- **A non-executable hook is no longer a silent no-op.** Git ignores a hook
  that lacks the executable bit (a hook committed as mode 100644, or checked
  out on a filesystem that drops it), so pushes sailed through with no check
  while `doctor` reported a false green. `hooks activate` now restores the bit
  on every run (self-healing on every clone via the postinstall), and `doctor`
  verifies executability, not just `core.hooksPath`.
- **Hook activation chains after an existing `postinstall`** (patch-package, a
  husky bootstrap) with `&&` instead of bailing with a note, so the pre-push
  guardrail activates even on repos that already script their install.

Upgrading: after `npm install --save-dev @vyuhlabs/dxkit@latest` +
`npx vyuh-dxkit update`, run `npx vyuh-dxkit ingest --from-snyk` (or
`--codeql`) to bring your interprocedural findings into dxkit, then
`npx vyuh-dxkit baseline create --force` to anchor them. The `dxkit-ingest`
skill walks through token setup and the license-aware engine choice. On a
brownfield repo the binary install may hit a peer-dep `ERESOLVE` from your own
dependency tree — retry with `--legacy-peer-deps` (the `dxkit-update` skill
walks through it).

### create-dxkit 0.2.1

- **Surfaces the real npm error when bootstrap install fails.** When
  `npm init @vyuhlabs/dxkit` couldn't install `@vyuhlabs/dxkit` (both the
  strict and `--legacy-peer-deps` attempts), the shim previously printed
  "Resolve the npm error above" with nothing above — npm routes the
  actual ERESOLVE / registry / auth detail to a debug-log file, and the
  retry attempt's stderr wasn't captured. The shim now captures stderr
  from both attempts, always prints the npm debug-log path, lists the
  common causes (private-registry auth, peer-dep conflict, wrong
  directory), and points at `npx vyuh-dxkit init --full --yes` as a
  direct path that needs no successful `npm install`.

## [2.8.0] - 2026-06-03

Graph-context navigation, two new agent skills, and broader secret +
.NET dependency coverage.

### Added

- **`vyuh-dxkit context <file:line>`.** Given a source location, returns
  the focused source chunk around it — roughly the enclosing symbol
  rather than the whole file — plus its structural neighborhood (module,
  blast radius, callers/callees). The chunk is read from disk, carved to
  a token budget, and centered on the requested line so the line you
  asked about is always shown. Degrades in layers: a file absent from the
  graph still returns a centered raw-line window; an unreadable path
  exits with a clear message. The keyword form `context <query>` is
  unchanged.
- **`dxkit-feature` skill.** Drives net-new development the way
  `dxkit-action` drives fixes: orient via the code graph to find where a
  feature plugs in and what it touches, build following existing
  patterns, then run the analyzers + `guardrail check` on the change so
  the feature doesn't ship a regression. Degrades to grep + read when no
  graph is present.
- **`dxkit-docs` skill.** Generates the documentation a repo is missing —
  reads the Documentation dimension's gaps, orients on the real code via
  the graph, then writes a grounded README / docstrings / API +
  architecture docs and re-runs the slop check so generated prose doesn't
  trade Documentation score for Quality score.

### Fixed

- **Hardcoded passwords are detected even when gitleaks is installed.**
  gitleaks is keyed to known token formats (AWS / GitHub / Stripe /
  private keys) and deliberately skips generic credential assignments
  like `password = "..."`. The pattern scanner already had a
  hardcoded-password rule but returned nothing whenever gitleaks was
  present, on a false "strict superset" assumption — so a plain
  hardcoded password sailed through the guardrail. The pattern scanner
  now complements gitleaks: generic keyword-assignment patterns
  (password / api-key / secret / token = a quoted literal,
  case-insensitive) always run, while branded token shapes stay
  gitleaks-only to avoid double-counting. The scan also moved off POSIX
  `grep` onto the in-process source walker, so it works on Windows.
- **Transitive .NET dependency vulnerabilities are found from committed
  lock files.** When a repo commits NuGet `packages.lock.json` files but
  the scanning machine lacked the .NET SDK, a vulnerable transitive
  dependency could go unreported: the osv path synthesized a lock file
  from each project's direct `<PackageReference>` entries only and never
  read the repo's real lock file (which carries the full resolved
  transitive tree). osv now scans the committed `packages.lock.json`
  files directly — full transitive coverage with no SDK or restore
  required — falling back to the direct-reference synthesis only when no
  lock file is committed.

### Changed

- Package-level dependency reachability (the `reachable` flag feeding the
  composite risk score) is documented as shipped on the roadmap, with the
  remaining refinements (per-ecosystem reliability gating, reachable-first
  report framing) split out as pending.

## [2.7.1] - 2026-05-31

Windows compatibility. Tool detection, the scanner toolchain, and source
enumeration now work on native Windows (cmd.exe / PowerShell), not only
on POSIX shells. Previously a Windows user could capture a baseline that
silently omitted whole finding categories because the underlying tools
were never detected or run; dxkit now detects them correctly and, when
something genuinely can't run, says so instead of recording an empty
result as clean.

### Fixed

- **Cross-platform tool detection.** Binary resolution now walks `PATH`
  in pure Node, honoring `%PATHEXT%` on Windows, instead of shelling out
  to `which`. Previously every external tool — and even `git`, `node`,
  and `dotnet` — was reported missing on Windows even when installed,
  which `doctor` now reflects accurately.
- **Scanners run on Windows.** gitleaks, semgrep, and jscpd write their
  reports under the OS temp directory and gitleaks is invoked without a
  shell, so a path with spaces or a non-POSIX shell no longer produces
  an empty result.
- **Source enumeration is shell-free.** Per-language import discovery,
  the directory count, README/manifest reads, and the developer-
  experience probes use in-process file walkers instead of
  `find` / `ls` / `wc` / `cat`, which returned nothing on Windows.
- **Graph context on Windows.** The graphify interpreter is resolved via
  the platform venv layout (`Scripts\python.exe` vs `bin/python`), so
  `explore`, `context`, and `--graph-context` work once graphify is
  installed.
- **`tools install` on Windows** selects an available shell rather than
  assuming `/bin/bash`.

### Added

- **Baseline coverage signal.** `baseline create` warns when an expected
  scanner isn't available — prompting to install or continue
  interactively, and requiring `--allow-incomplete` in non-interactive
  runs rather than silently writing a partial baseline (`--force`
  implies this opt-in, so the shipped baseline-refresh workflow keeps
  working). The baseline file now records which scanners were available
  at capture time, and `guardrail check` surfaces when that availability
  has since changed.
- **Configurable tool locations.** A `.dxkit/tools.json` with
  `probePaths` and `installDir` lets dxkit find tools in non-standard
  locations and install them where you choose — useful on locked-down or
  corporate-managed machines. Documented in the `dxkit-config` skill.
- **Windows CI job** that validates detection on a real Windows runner,
  triggered only when detection-relevant files change.

## [2.7.0] - 2026-05-29

The "Repo Explore" release. dxkit now builds a deterministic code graph
of your repo and exposes it three ways: a CLI to query structure, an
interactive graph in the dashboard, and per-finding blast radius in
detailed reports. The throughline is helping a coding agent fix findings
by navigating structure instead of re-reading whole files.

### Added

- **`vyuh-dxkit explore`** with six subcommands (`entry-points`,
  `hot-files`, `communities`, `file`, `feature`, `api-surface`) for
  asking the code graph what the repo does, where a feature lives, which
  files are load-bearing, and what the public API surface is.
- **`vyuh-dxkit context <query>`** returns a token-budgeted structural
  slice for a query (an anchor symbol, its relevant neighbors, and the
  blast radius), plus a fail-open Claude Code PreToolUse hook that feeds
  it on Grep/Glob so agents need fewer follow-up whole-file reads.
  Auto-installed with `--with-dxkit-agents`.
- **Interactive Graph tab** in `vyuh-dxkit dashboard`, embedding
  graphify's code-graph viewer with the renderer bundled to work
  offline. Large repos render a community-aggregated view.
- **`--graph-context`** on `vulnerabilities`, `test-gaps`, and `quality`
  attaches each finding's module and blast radius (which files call into
  it) to the detailed report, so a fixing agent gets the structural map
  per finding without a separate lookup.
- **Per-language call-graph reliability.** Where the call graph cannot be
  resolved (C#, which cannot follow `using` across assemblies), blast
  radius reads "n/a" rather than a misleading "0 callers", so it is never
  mistaken for "safe to change".
- **`dxkit-action`** now folds blast radius into prioritization as an
  additive signal, and the generated `AGENTS.md` documents the new
  commands.

### Changed

- `vyuh-dxkit health` writes the code graph to
  `.dxkit/reports/graph.json` as a side effect, so a single run
  populates the artifact the explore, context, dashboard, and
  graph-context surfaces read.

## [2.6.0] - 2026-05-23

The "per-finding suppression + public-repo-safe baselines" release.
Adds the typed-category allowlist surface for false-positive /
test-fixture / mitigated-externally / accepted-risk / deferred
suppression with inline + file-level modes; retires license
findings from the baseline (~73% size drop on real customer repos);
introduces three baseline modes with visibility-aware defaults so
public repos no longer leak file paths, package names, and
advisory IDs through a committed baseline.

### Added

- **Per-finding allowlist** — `vyuh-dxkit allowlist add/list/show/audit/prune`.
  Typed-category suppression (`false-positive`, `test-fixture`,
  `mitigated-externally`, `accepted-risk`, `deferred`) with required
  reason + (where relevant) expiry. Two surfaces: inline
  `// dxkit-allow:<category> reason="..."` annotations and a
  file-level `.dxkit/allowlist.json`. `accepted-risk` and `deferred`
  require expiry (default 90 days). See
  [docs/commands/allowlist.md](docs/commands/allowlist.md).
- **Strict stale-annotation detection** — orphaned `dxkit-allow:`
  annotations (where the underlying finding is now gone) emit a
  new `stale-allow` baseline kind on the next scan. The
  TypeScript `@ts-expect-error` pattern, applied to suppressions —
  forces cleanup, prevents the annotation graveyard. Allowlisting
  a `stale-allow` finding is forbidden; only remediation is to
  remove the orphaned comment.
- **Allowlist activity in PR comments** — the
  `dxkit-guardrails.yml` workflow's sticky PR comment now includes
  an "Allowlist activity" section listing every entry added (or
  removed) on this branch versus the baseline commit. Reviewers
  see new suppressions being introduced and can sanity-check
  category + reason + expiry before approving.
- **`vyuh-dxkit issue`** — pre-filled GitHub Issues for false
  positives, missing findings, bugs, feature requests, and docs
  gaps. Nothing submits automatically — the CLI opens the
  customer's browser at a new-issue URL with env metadata
  pre-populated, customer reviews + clicks "Submit." See
  [docs/commands/issue.md](docs/commands/issue.md).
- **`commentSyntax` on language packs** — each pack declares its
  line-comment marker (`#` for python/ruby; `//` for
  typescript/go/rust/csharp/kotlin/java). Drives the inline
  allowlist-annotation generator across every language uniformly.
  Recipe-enforced: scaffolder ships an empty placeholder so
  unfilled packs fail the contract test until populated.
- Three preemptive architecture rules in `scripts/check-architecture.sh`
  lock down the allowlist canonical entry points: no `createHash`
  inside `src/allowlist/`, no direct `allowlist.json` IO outside
  the canonical loader, no language-comment fallback literals
  (`?? '//'`) anywhere in the module.

### Changed

- **License findings retired from the baseline.** Per-package
  license attributions no longer flow through the baseline
  producer registry — they were informational, not regression
  material, and dominated baselines on real customer repos
  (~73% of entries). The canonical license inventory now lives
  solely in `.dxkit/bom.json` (`vyuh-dxkit bom`), which already
  carries richer per-package data (licenseType, licenseText,
  sourceUrl, supplier, releaseDate). Lenient migration:
  baselines written by older dxkit versions still load — the
  reader silently filters retired `license` entries on the way
  in (no file rewrite until the next `baseline create --force`).
  Dependency vulnerability tracking is unchanged — `dep-vuln`
  is a separate identity kind on a separate producer and still
  blocks via the guardrail check.
- **Sanitization machinery for baseline entries.** New pure
  module `src/baseline/sanitize.ts` introduces a stripped
  `SanitizedBaselineEntry` variant (`{ id, kind, sanitized: true }`)
  carrying identity + kind only. The `sanitizeEntry` /
  `sanitizeFile` pass collapses every rich field; cross-run
  matching still works at full confidence via the fingerprint
  multiset pass. Producers now emit the rich
  `RichBaselineEntry` shape (a `BaselineEntry` excluding the
  sanitized variant); sanitization is a write-time
  transformation, never a producer concern. Consumers walking
  a baseline narrow via the `isSanitized` type guard before
  switching on `entry.kind`. Write-path wiring + visibility-
  aware mode selection ship in a follow-up commit.

### Added

- **Three baseline modes with visibility-aware defaults.**
  `committed-full` (today's behavior, rich entries), `committed-
  sanitized` (stripped per-entry payload via the sanitization
  pass), and `ref-based` (no committed file; guardrail check
  recomputes the prior side from a git ref via `git worktree
  add`). The mode is picked by a single resolver
  (`src/baseline/modes.ts`) with precedence: CLI flag →
  `.dxkit/policy.json:baseline.mode` → visibility-derived default
  (public repos auto-pick `ref-based`; everything else picks
  `committed-full`). `committed-sanitized` is never auto-picked
  — it's the explicit opt-in for compliance-conscious private
  repos.
- `vyuh-dxkit baseline create [--mode <m>] [--ref <r>]` and
  `vyuh-dxkit guardrail check [--mode <m>] [--ref <r>]` — flags
  override `policy.json` for one-off runs.
- `gh repo view --json visibility` probe + per-process cache
  in `src/baseline/visibility.ts`. Every failure path returns
  `'unknown'`; the resolver treats unknown as private to avoid
  surprise sanitization when `gh auth` lapses.
- Ref-based gather mechanics in `src/baseline/ref-baseline.ts` —
  `withRefWorktree(opts, fn)` is the reusable primitive; tears
  down the worktree on success + failure. Mirrors file-mode
  `.dxkit/salt` into the worktree so secret-HMAC entries pair
  across cwd + worktree.

### Architectural notes

- New CLAUDE.md rule 11: baseline mode resolution flows through
  `resolveBaselineMode`. Two arch-check rules lock the contract:
  no `gh repo view --json visibility` outside
  `src/baseline/visibility.ts`; no `git worktree add` / `remove`
  outside `src/baseline/ref-baseline.ts`.
- `resolvePolicy` lifted from `check.ts` to `policy.ts` so
  `createBaseline` and `runGuardrailCheck` share one canonical
  loader.

### Discovery surfaces

- **PR-comment markdown** now shows the resolved baseline mode in
  the sticky footer (`_Mode_: \`ref-based\` (ref: \`origin/main\`)`).
  Reviewers see WHY a guardrail run picked a given posture.
- **JSON renderer** carries `baseline.mode = { value, source,
  explanation, ref? }` so agents + dashboards can read the audit
  trail without re-deriving it.
- **`vyuh-dxkit doctor`** has two new operational checks:
  - "baseline mode: ref-based" / "baseline captured (mode: ...)" —
    the existing baseline-captured check now understands ref-based
    mode (where no on-disk file is expected) so the doctor stops
    reporting a false-negative on public repos.
  - "baseline mode aligned with repo visibility" — warns when an
    explicit `committed-full` pin is in use on a public repo (the
    posture leaks file paths + package names; the auto-picker
    would have chosen ref-based).
- **`dxkit-onboard` skill** — step 5 now ASKs about disclosure
  posture before running `baseline create`, walks customers through
  the three modes, and offers a one-shot `.dxkit/policy.json` snippet
  for pinning the choice repo-wide.
- **`dxkit-action` skill** — new section explains how to act on a
  blocked finding when the baseline is sanitized / ref-based
  (locator stripped at write time; re-run the analyzer for full
  context or allowlist by fingerprint).
- **README + getting-started.md** — call out the public-repo
  posture explicitly so customers don't accidentally commit a
  rich baseline to an open-source repo.

### Architectural notes

- Added `stale-allow` as a new `IdentityKind` (Rule 9 + Rule 10
  compliant: identityFor case + producer + fixture row +
  removed from `DEFERRED_KINDS` once the gather pass landed).
- The hint formatter (block-time guidance for blocked findings)
  consumes the canonical `BaselineEntry` discriminated union
  directly — no invented intermediate "BlockingFinding" shape.
  TypeScript exhaustiveness across 6+ switches guarantees new
  finding kinds can't ship without matching cases.
- `dxkit-action` skill extended with the typed-category +
  surfaces description; SAST recipe redirects from semgrep's
  `// nosemgrep:` to dxkit's `// dxkit-allow:` (single canonical
  suppression surface across all scanners).

## [2.5.2] - 2026-05-22

The "scaffold UX + lifecycle skills + setup automation" release. Closes
every defect surfaced during the 2026-05-21 guided Codespaces UX
walkthrough (D145–D156) plus a vestigial-cleanup pass and adds three
new CLI subcommands + three new lifecycle skills.

Companion release: **`@vyuhlabs/create-dxkit@0.2.0`** ships alongside
this version, picking up the create-dxkit shim improvements (quieter
ERESOLVE handling, `--no-audit`, `.npmrc legacy-peer-deps` persistence).
Tag: `create-dxkit@v0.2.0`. Run `npm init @vyuhlabs/dxkit` to get
the new combined experience.

Validated end-to-end with two cross-stack walkthroughs on 2026-05-22:
a polyglot Python+TypeScript reference repo and a .NET reference repo.
Both stacks: defect closures verified, per-pack devcontainer adapts
correctly, doctor's new tier-3 surfaces operational gaps with
actionable fix commands.

### Added

- Three new lifecycle skills under `.claude/skills/`, completing
  the orthogonal customer-journey trio:
  - **`dxkit-fix`** — reactive repair. Consumes
    `vyuh-dxkit doctor --json` output and walks the customer
    through each fixable check with per-step confirmation.
  - **`dxkit-update`** — existing-install upgrade orchestrator.
    Consumes `vyuh-dxkit upgrade --plan --json` and drives a
    conversational upgrade with version-delta analysis, breaking-
    change warnings, and per-step confirmation. Hands off to
    `dxkit-fix` on post-upgrade doctor failures.
  - **`dxkit-onboard`** — fresh-install orchestrator. Walks the
    full first-time customer journey end-to-end (install → doctor
    → fix gaps → baseline → hooks → branch protection → Codespaces
    prebuild → final verify). Delegates to focused skills for
    sub-decisions.
- Three new CLI subcommands:
  - **`vyuh-dxkit upgrade [--plan [--json] | --yes | --target=X.Y.Z |
    --dry-run]`** — combined binary + scaffold refresh. `--plan`
    mode emits structured `upgrade-plan.v1` JSON consumed by the
    `dxkit-update` skill. Execution mode runs `npm install`
    + `vyuh-dxkit update` + `vyuh-dxkit doctor` in sequence with
    a devcontainer-rebuild reminder if applicable.
  - **`vyuh-dxkit setup-branch-protection [--branch X]
    [--require-reviews N] [--force]`** — wraps `gh api` to mark
    `dxkit-guardrails` as a required status check on the default
    branch. Idempotent merge with existing required-checks list.
  - **`vyuh-dxkit setup-prebuild [--branch X] [--regions=R1,R2]
    [--force]`** — wraps `gh api` to configure Codespaces
    prebuilds. Fresh Codespaces start in ~30s instead of running
    the full devcontainer build (~7 min after per-stack feature).
- Doctor third tier — **Operational health**. Six runtime checks
  (`git hooks active`, `baseline captured`, `vyuh-dxkit on PATH`,
  `scanner toolchain healthy`, `.npmrc legacy-peer-deps
  persistence`, `CI guardrails workflow`) each carrying structured
  fix metadata (hint + command + skill). Plus a new `--json`
  output mode emitting the `doctor.v1` schema for `dxkit-fix`
  consumption.
- `manifest.installFlags` — persists the customer's `init`
  flag choices in `.vyuh-dxkit.json` so `vyuh-dxkit update`
  knows exactly which surfaces to refresh. Self-migrates legacy
  pre-2.5.2 manifests by stamping detected flags back on first
  update run.
- Per-pack `LanguageSupport.devcontainerExtensions?` field.
  Each language pack contributes its VSCode editor extensions;
  the installer unions across active packs only. Pure-Python
  Codespaces no longer install Go / Rust / C# / Java / Kotlin /
  Ruby editor extensions on every container start.
- Architecture rule (`scripts/check-architecture.sh`) that catches
  dead `IF_*` template conditions in `constants.ts`. The
  type-correct compute-without-consumer class of dead code sat
  for days before the rule landed; rule now blocks new
  occurrences at pre-commit time.
- Three new doc pages: `docs/commands/upgrade.md`,
  `docs/commands/setup-branch-protection.md`,
  `docs/commands/setup-prebuild.md`.

### Changed

- **`vyuh-dxkit update` actually refreshes everything now.**
  Pre-this-release, update only re-ran the template generator and
  silently passed `withDxkitAgents=false`. Customers on 2.5.1 had
  no path to receive new dxkit-* skills, per-stack devcontainer
  extensions, doctor pivot, or any other scaffold-side change.
  `update` now detects which install surfaces the customer
  originally landed (via `manifest.installFlags` or workspace
  detection) and re-runs every relevant installer.
- `vyuh-dxkit doctor` — three-tier framing (Reports + Agent DX +
  Operational health, was two-tier). Tier 1 + 2 labels +
  exit-code behavior preserved verbatim; tier 3 is additive.
- All six existing dxkit-* skill prose files standardized on
  `npx vyuh-dxkit X` invocations (was a mix of bare + npx forms).
  Robust to customers whose shell PATH doesn't have dxkit
  globally installed.
- Python devcontainer feature switched from `installTools: true`
  → `false`. The upstream feature's bundled installTools list
  added ~3 min to every devcontainer build with no dxkit
  consumer. Saves ~3 min per Codespaces rebuild on python-stack
  projects.
- `osv-scanner` install switched from `go install` to GitHub
  releases binary fetch. Pre-this-release, customers on any
  non-Go stack silently lost `osv-scanner` (the canonical
  Tier-2 dep-vuln scanner) because the install command failed
  without a Go toolchain.
- `post-create.sh` always runs a global `npm install -g
  @vyuhlabs/dxkit` in addition to whatever project-local install
  happened. Without this, `vyuh-dxkit` wasn't on the customer's
  shell PATH in Codespaces.
- Init's closing summary surfaces `Next: run vyuh-dxkit
  baseline create` as a prominent info-level call-to-action
  immediately after `Done!`, instead of burying it in a dim
  three-line footer.
- `create-dxkit` shim: stderr from the first `npm install`
  attempt is now captured (not streamed) so a peer-dep
  `ERESOLVE` doesn't print a multi-line error wall before the
  silent `--legacy-peer-deps` fallback succeeds. `--no-audit`
  passed to both install attempts so the host project's
  pre-existing vulnerability count doesn't surface mid-init.
  Fallback choice persisted to `.npmrc` so the customer's next
  `npm install <pkg>` doesn't re-hit the same ERESOLVE wall.
- CI: `actions/cache@v4` on the scanner toolchain
  (`~/.local/{pipx,bin,share/{detekt,pmd}}`). Saves ~2 min per
  CI run.
- Publish workflows (`publish.yml` + `publish-create-dxkit.yml`):
  verify-shasum poll window 18s → 180s. First-publishes of
  scoped packages commonly need 30–90s for CDN propagation;
  the wider window prevents the "publish succeeded but workflow
  reports failure" mode that bit both 2.5.1 publishes.
- README, getting-started, docs/README, commands/init.md
  refreshed to reflect: `npm init @vyuhlabs/dxkit` as canonical
  first install, 9 lifecycle skills (was 6), postinstall
  auto-activation of hooks, per-stack devcontainer.

### Removed

- Vestigial `DetectedStack.tools.{gcloud, pulumi, infisical,
  ghCli}` field. Computed at every detect call since the 2026-
  05-19 generator simplification removed the `.project.yaml`
  consumers; nothing referenced them post-cleanup. Doctor's
  pre-pivot tier-2 `gcloud` + `infisical` availability checks
  removed alongside (no manifest field to gate on).
- Six dead `IF_*` template conditions in `constants.ts`:
  `IF_POSTGRES`, `IF_REDIS`, `IF_HAS_SERVICES`, `IF_DOCKER`,
  `IF_CLAUDE_CODE`, `IF_COVERAGE_ENABLED`. Computed but no
  template referenced them; same 2026-05-19 cleanup left them
  behind. Arch-check rule (above) prevents new occurrences.

### Fixed

- Dispatcher deadline test (`test/dispatcher-deadline.test.ts`):
  lower-bound assertion 40ms → 25ms. Test was occasionally
  flaking on fast CI runners where `setTimeout`'s ~1-2ms
  granularity could fire at 38-39ms.

## [2.5.1] - 2026-05-20

### Added

- New `vyuh-dxkit hooks activate` CLI subcommand. Idempotently sets
  `core.hooksPath = .githooks`. Wired into `init`'s scaffolded
  `package.json` as a `postinstall` script so every clone plus
  `npm install` activates the dxkit hooks transparently — no more
  one-time-per-clone manual step.
- New `--with-dxkit-agents` `init` flag (default-on under `--full`).
  Installs six dxkit-specific skills under `.claude/skills/dxkit-*/`
  (`learn` / `init` / `config` / `hooks` / `reports` / `action`)
  alongside `AGENTS.md` (open-standard project context) and a small
  `CLAUDE.md` shim. The skills wrap the `vyuh-dxkit` CLI as
  workflow-aware surfaces that Claude Code auto-discovers via skill
  frontmatter.
- New optional `LanguageSupport.devcontainerFeature?` field. Each
  language pack declares its canonical `ghcr.io/devcontainers/features`
  entry; `installDevcontainer` renders the per-stack features block.
  Cold devcontainer rebuilds drop from ~25 minutes (every supported
  toolchain installed) to ~7 minutes on a pure-TypeScript repo
  (only the toolchains the repo actually needs).
- New optional `ToolDefinition.applicabilityGuard?` field. Tools
  whose preconditions aren't met on the current repo
  (e.g. `vitest-coverage` on a mocha-based codebase) now report as
  `n/a` with an inline reason instead of inflating the
  missing-count. `tools install` filters n/a entries from the
  install loop.
- New `@vyuhlabs/create-dxkit` shim package (zero dependencies; code
  shipped under `packages/create-dxkit/`). First npm publish is a
  manual tag-and-release step after this version lands on main.
  Once published, `npm init @vyuhlabs/dxkit` will collapse the
  prior two-step first install (`npm i -D @vyuhlabs/dxkit && npx
  vyuh-dxkit init`) into one command.

### Changed

- The generic 73-file `.claude/` scaffold (`agents/`,
  `agents-available/`, `commands/`, generic skills, etc.) is replaced
  with six dxkit-specific skills plus `AGENTS.md` and the
  `CLAUDE.md` shim. Customers upgrading keep their existing
  `.claude/` (`init` is additive — won't overwrite without
  `--force`). Fresh `--full` installs now land ~20 files instead of
  ~73, focused entirely on equipping coding agents to drive the
  dxkit CLI safely.
- `post-create.sh` now falls back through a three-step npm install
  chain (`npm ci` → `npm install` → `npm install --legacy-peer-deps`)
  so brownfield Node monorepos with peer-dep tangles survive the
  devcontainer post-create cleanly.
- `doctor` no longer checks for the deleted generic scaffold files.
  It now reports an `X/6 dxkit-* skills present` tally plus an
  `AGENTS.md` presence check, giving customers a clearer signal of
  what's missing on partially-scaffolded repos.

### Fixed

- Graphify's on-disk cache no longer leaks `graphify-out/cache/` into
  consumer repos. The temp-dir redirection monkey-patch now fires
  before the first graphify call; `graphify-out/` is also added to
  the scaffolded `.gitignore` defensively.

### Deferred to next polish release

The following items rolled out of this release and will ship in
2.5.2 (or bundle into 2.6 depending on the marketplace decision):

- `vyuh-dxkit setup-branch-protection` CLI (wraps `gh api` for
  branch-protection enforcement).
- `vyuh-dxkit setup-prebuild` CLI (wraps `gh api` for Codespaces
  prebuilds — cold-start cuts from ~25 minutes to ~30 seconds).
- Full `doctor` pivot to onboarding-health checks (hooks active,
  branch protection set, baseline current). This release partially
  shipped the pivot — the generic-scaffold checks were dropped — but
  the new positive checks await the two CLI subcommands above.
- CI tool cache via `actions/cache@v4` on the scanner toolchain in
  `dxkit-guardrails.yml`.

## [2.5.0] - 2026-05-18

### Summary

2.5.0 introduces **commit-time guardrails** — a per-finding baseline
captured once on a brownfield repo, then diffed against every
subsequent scan to detect net-new regressions while grandfathering
existing debt. Existing issues stay where they are, new ones block.

This release also **prunes the legacy task-runner scaffolding** that
prior versions of `init --full` bundled (Makefile, `.project/` task
scripts, `.ai/` prompt scaffolding, per-language config templates,
non-dxkit CI workflows, `.editorconfig`, `.pre-commit-config.yaml`).
The agent DX surface is now the sole `init --full` output —
`init --full` lands 73 files (down from 119), every one of them
focused on equipping AI coding agents to operate safely on the
codebase. Customers who relied on the legacy scaffolding can use
`@vyuhlabs/create-devstack` for greenfield project bootstrap.

The release ships three coordinated surfaces:

1. **A new `baseline` / `guardrail` CLI** that captures stable
   per-finding identities, diffs current scans against them, and
   classifies each pair (`added` / `relocated` / `tooling_drift` /
   `config_drift` / `persisted` / `removed` / `fixed`) with a
   confidence score and structured reasons. The classifier ships
   with a **scanner-wobble demotion** that converts `added` findings
   on UNCHANGED lines into `uncertain` (warn) for high-wobble kinds
   (`code`, `hygiene`), so semgrep's per-run non-determinism on
   large codebases doesn't trigger false-positive blocks. Findings
   inside the diff's changed lines still block — real regressions
   are caught. Customers can extend or clear the kind list via
   `addedRequiresChangedLines` in `.dxkit/policy.json`.
2. **Init-installable templates** for the pre-push guardrail hook,
   a devcontainer with pinned toolchains + Claude Code & Codex
   CLIs, a GitHub Actions PR-gate workflow that posts a markdown
   summary as a PR comment, and a post-merge baseline-refresh
   workflow that keeps the anchor current. Pre-commit + AI-PR-
   review are opt-in via `--with-precommit-hook` and
   `--with-pr-review` respectively (slow on large repos / requires
   API-cost opt-in). Every `init` also seeds `.gitignore` entries
   for the analyzer runtime outputs (`.dxkit/reports/`,
   `.dxkit/dashboard.html`) and writes a starter `.dxkit-ignore`
   template for dxkit-specific scan-exclusion tuning.
3. **Aggregate-gate flags** (`--fail-on-score`, `--fail-on-severity`)
   on every analyzer command, plus a stable JSON schema banner on
   every `--json` output so consumers can version-gate.

Tests: ~1530 unit + integration cases pass on the integrated branch
(up from 1265 at the 2.4.8 baseline; +265 across fingerprinting,
producers, policy, matcher, ship installers, the smart classifier,
opt-in hook + workflow installers, and the CLI surface).

#### New CLI surface

```bash
vyuh-dxkit baseline create [path] [--name <name>] [--force]
                                  [--verbose]
vyuh-dxkit baseline show   [path] [--name <name>] [--baseline <p>]
                                  [--kind <kind>] [--json]
vyuh-dxkit guardrail check [path] [--name <name>] [--baseline <p>]
                                  [--changed-only] [--policy <p>]
                                  [--json | --markdown]
```

- `baseline create` runs every analyzer, fingerprints each per-
  finding entity through the canonical identity dispatcher
  (`src/baseline/finding-identity.ts`), and writes
  `.dxkit/baselines/<name>.json`. Schema-versioned
  (`dxkit-baseline/v1`); commit it.
- `baseline show` pretty-prints the on-disk baseline, optionally
  filtered by kind or emitted as a schema-banner-wrapped JSON.
- `guardrail check` loads the baseline, re-runs the analyzers,
  matches via the git-aware matcher (`-M` renames, ±2 line fuzz,
  content-hash fallback for shallow clones), classifies each pair
  through the brownfield policy, and exits 1 when the policy
  blocks. Output modes: console (default), `--json` (schema
  `dxkit.guardrail-check.v1`), or `--markdown` (used by the PR-
  gate workflow to post a comment).

The full read/write/compare triplet flows through a registered
producer pipeline (`src/baseline/producers/index.ts:PRODUCERS`) —
adding a new identity kind means registering a producer, not
editing the orchestrator. Architectural rule documented in
`CLAUDE.md` Rule 10 with three enforcement gates (arch check +
contract test + synthetic-producer playbook).

#### Aggregate gates + schema banner

Every analyzer command (`health`, `test-gaps`, `quality`,
`vulnerabilities`, `bom`) gains composable exit-code gates:

- `--fail-on-score <N>` — exit 1 when the headline score drops
  below N (applies to `health`, `test-gaps`).
- `--fail-on-severity <tier>` — exit 1 when any finding at `<tier>`
  or higher exists (applies to `vulnerabilities`, `bom`; tier ∈
  critical / high / medium / low).

Every `--json` output carries a top-level
`schema: 'dxkit.<kind>-report.v1'` banner so consumers can version-
gate against future schema migrations.

#### `vyuh-dxkit init` ship flags

`init` gains four new flags, all implied by `--full`:

- `--with-hooks` writes `.githooks/pre-commit` (fast,
  `--changed-only`) and `.githooks/pre-push` (full).
- `--with-devcontainer` writes a lightweight `.devcontainer/`
  layering all seven supported language toolchains via devcontainer
  features + a `post-create.sh` that runs `vyuh-dxkit tools install
  --yes` to provision the scanner toolchain pinned in the registry
  + `install-agent-clis.sh` that installs Claude Code + OpenAI
  Codex CLIs (opt out of either with `CLAUDE_CODE_VERSION=skip` /
  `CODEX_VERSION=skip`).
- `--with-ci` writes `.github/workflows/dxkit-guardrails.yml` (PR-
  gate that posts a markdown summary as a PR comment, updating in
  place across pushes via an HTML marker).
- `--with-baseline-refresh` writes
  `.github/workflows/dxkit-baseline-refresh.yml` (regenerates the
  baseline on every push to the consumer's default branch and
  auto-commits with `[skip ci]`). The default-branch name is
  detected at install time from the consumer's git state, with
  fallbacks for `main` / `master` / `trunk` / `develop`.

Installs are **additive by default**. Existing `.githooks/<hook>`
or `.husky/<hook>` files trigger a `.dxkit` sidecar + merge note
instead of an overwrite. An existing `.devcontainer/devcontainer.json`
stashes the full dxkit set under `.devcontainer/.dxkit-reference/`
for manual merge. Workflow files are uniquely named so they don't
collide; if our exact filename already exists, init skips it. The
`--force` flag overrides every additive fallback and writes in
place.

#### Brownfield policy

`.dxkit/policy.json` (auto-discovered at the repo root) tunes which
classifications block vs warn, per-severity confidence thresholds
that demote low-quality matches to `uncertain`, and per-finding-kind
block rules (`newSecret`, `newCriticalSecurity`,
`newCriticalDependencyVulnerability`, etc.). Compiled-in defaults
ship a conservative posture: block on `added`, warn on
`tooling_drift` / `config_drift` / `newly_detected` /
`probable_existing` / `uncertain`. The `--policy <path>` flag
overrides auto-discovery; when no policy is found, the defaults
apply.

#### Architectural fixes surfaced by the customer-repo audit

A pre-ship audit on three real customer repositories (a 444-source
TypeScript backend, a 553-source TypeScript frontend, and a
.NET WinForms project) surfaced four drift classes between the
report aggregates and the per-finding identity sets the baseline
captures. All four are closed in 2.5.0:

1. **Large-file producer was capped at top 10.** The gather layer
   pre-sliced `largestFiles` to ten entries for the markdown
   renderer's "Top Files by Size" table; the baseline producer
   inherited the cap and silently dropped per-file identity for
   every oversized file beyond the first ten. A real customer
   brownfield with 47 files over 500 lines saw 10 baseline entries;
   the .NET project with 926 oversized files saw 10. The gather now
   emits every file over the 500-line threshold sorted descending;
   the renderer adds an explicit `.slice(0, 10)` at the table site.
   `HealthMetrics.filesOver500Lines` aggregate now matches the
   per-kind count in the baseline byte for byte. Combined recovery
   across the three audit repos: 1,087 previously-silently-missed
   `large-file` findings now flow into baselines.

2. **Secret-HMAC producer emitted duplicates.** When the same
   secret value appeared at multiple locations — the same token on
   two lines of one file, a leaked key in both `.env` and
   `src/config.ts`, or two overlapping gitleaks rules firing on the
   same line — the producer wrote multiple entries with identical
   `(rule, hmac)` identity. Identity sets aren't supposed to have
   duplicates by definition. Now a per-call `Set<string>` keyed on
   the computed identity collapses repeats; first write wins,
   output order is stable.

3. **Tools-map version probes occasionally cached `'present'`
   under load.** The per-process version cache locks the first
   probe's outcome to keep `toolchainHash` byte-stable across two
   back-to-back gathers (a previously-shipped flake closure). But
   when the first `execSync(<tool> --version)` raced its 5-second
   timeout under heavy CPU load — parallel scanner pools or the
   post-merge workflow doing two scans in series — the cache locked
   the `'present'` fallback for the rest of the process. The tools
   map in the baseline file then read `gitleaks@present` instead of
   a real version, and the next run flagged spurious tooling-drift.
   The fix retries the version probe up to three times before
   falling back; each attempt is fresh. The cache layer is
   unchanged — once a value settles (real version or genuine
   `'present'`), it's locked for the rest of the process.

4. **TypeScript license enrichment could stall the entire licenses
   capability.** `gatherTsLicensesResult` calls `enrichReleaseDates`
   after license-checker returns to populate the optional
   `releaseDate` field from the npm registry. The enrichment runs
   with 20-way concurrency, 10s per request — usually fast — but a
   flaky network or rate-limited registry can push a 700-package
   run past the dispatcher's 720-second deadline. When that
   happens, the entire licenses capability is dropped and the
   baseline silently loses every license entry. On the TypeScript
   frontend audit repo, license-checker itself returned 749KB of
   JSON in under 10 seconds when invoked manually; the enrichment
   stalled the whole capability. Now the enrichment is raced
   against a 60-second wall-clock budget; on timeout, the license
   findings still emit with their static fields and `releaseDate`
   is left unset on the unenriched ones. A previously-zero baseline
   now captures 1,897 license entries on that repo.

Together these four fixes recover **~3,000 baseline findings** that
were being silently dropped on real customer repos pre-2.5.0.

#### Migration guidance for 2.4.x users

No breaking changes. Existing analyzer commands continue to work
exactly as before. The new commands and flags are additive.

To start using guardrails on an existing repo:

```bash
vyuh-dxkit init --with-hooks --with-ci --with-baseline-refresh
git config core.hooksPath .githooks
vyuh-dxkit baseline create
git add .dxkit/baselines/main.json .githooks .github/workflows/dxkit-*.yml
git commit -m "chore: enable dxkit guardrails"
```

See [`docs/getting-started.md`](docs/getting-started.md),
[`docs/commands/baseline.md`](docs/commands/baseline.md),
[`docs/commands/guardrail.md`](docs/commands/guardrail.md), and
[`docs/configuration/policy.md`](docs/configuration/policy.md) for
the full walkthrough.

## [2.4.8] - 2026-05-18

### Summary

Focused patch release closing the regressions surfaced by a
post-2.4.7 user-simulation evaluation across the three external
audit repos. The biggest item is the structural follow-up to
D134 — the silent-health failure root-caused in 2.4.7 was a
real abandoned-Promise inside `runDetached`, but the underlying
class (unbounded await chain at the dispatcher level) had a
second failure mode that the 2.4.7 fix didn't reach. 2.4.8
closes it structurally. Plus: a date-rollover false-failure on
long runs, a Tools-used footer attribution drift, a cascade
warning when the analysis cache can't be built, and a README
upgrade-advisory correction. Tests: 1265 / 0 (up from 1241 at
the 2.4.7 baseline).

#### Per-provider deadline closes a second silent-health failure mode (D141)

D134 in 2.4.7 added a `settle()` guard plus a safety deadline
**inside** `runDetached` so that exit / error / safety-deadline
each force the subprocess Promise to resolve. That closed the
shape where a `runDetached` Promise itself stayed pending. But
a post-ship user-simulation reproduced the same silent-rc=0
behavior on a JS-heavy customer frontend audit — and this time
the runDetached safety deadline did not fire, because the
abandoned Promise was not inside `runDetached` at all. It was
inside the capability dispatcher's `Promise.allSettled` over
nine providers: one of those providers' `gatherOutcome` chains
contained a Promise that never settled, `Promise.allSettled`
cannot collapse an unsettled Promise, the whole
`gatherCapabilityReport` stayed pending forever, Node's event
loop emptied and the parent saw a clean rc=0 with no markdown
written.

Fix (commit `611321d`):

- New `src/analyzers/tools/deadline.ts` with a
  `withDeadline(promise, deadlineMs)` helper that races any
  Promise against a timer.
- The dispatcher (`src/analyzers/dispatcher.ts`) wraps every
  provider's `gather` / `gatherOutcome` call in a 720-second
  deadline (`DEFAULT_PROVIDER_DEADLINE_MS`). A stalled provider
  is materialised as a skipped source with reason
  `"stalled at >Ns (deadline)"` that flows through the existing
  availability machinery into the `Tools unavailable` surface.
  A stderr line names the stalled capability + source so the
  abandoned-Promise location is visible in `--verbose` and CI
  logs.
- The two non-dispatcher gathers
  (`gatherDepVulnsWithAvailability` and
  `gatherLicensesWithAvailability`) iterate active packs
  themselves; both apply the same per-pack deadline pattern.
- New `DispatcherOptions` fields (`providerDeadlineMs`,
  `onProviderStall`) so tests can wrap deadlines around 50-ms
  stubs without polluting test output. Default `onProviderStall`
  emits the stderr notification.
- New regression test
  (`test/dispatcher-deadline.test.ts`, 7 cases) exercises the
  helper directly, the dispatcher with one hung + one good
  provider, the all-hung case, the bounded wall-clock claim,
  and confirms thrown-provider rejections still route through
  `onProviderError` (not `onProviderStall`).

Verification on the failure repo:

- Pre-fix (2.4.7 user-sim): `report` exited 1 after ~1428 s;
  Health step hung in the capabilities Promise.all and never
  wrote `health-audit-*.md`; orchestrator's 2.4.7
  defense-in-depth guard surfaced the ✗ but the underlying
  hang remained.
- Post-fix: `report` exited 0 in 1264.5 s; all 8 steps wrote
  their reports; one stderr line attributed the stall to the
  typescript-pack licenses provider walking a deep
  `node_modules` tree — the reproducible offender behind the
  intermittent hang. The Licenses report's framing notice
  reads `typescript: stalled at >720s (deadline)` so the
  customer sees what to act on.

The class is now closed by construction: a never-settling
provider can no longer keep `Promise.allSettled` pending
forever; the worst-case behaviour is one capability surfacing
as unavailable with the deadline reason visible to the user.

#### Orchestrator date snapshot survives UTC-midnight rollover (D140)

Long `vyuh-dxkit report` runs that crossed UTC midnight
produced false failures. Files written before midnight got the
old date suffix; files written after got the new one; the
orchestrator's post-step file-existence check compared against
the date snapshot it captured at startup. Several reports were
on disk under the new date but the orchestrator reported them
as missing.

Fix (commit `cc1f146`):

- New `src/analyzers/tools/report-date.ts` exposes
  `getReportDate()`, which honors the optional
  `DXKIT_REPORT_DATE=YYYY-MM-DD` env var (validated) and falls
  back to today's UTC date.
- The orchestrator captures the date once at startup and
  threads it to every child subcommand via the env var, so
  every report filename in a single run shares the same date.
- All 10 internal date-stamping call sites in
  `src/cli.ts` + dashboard + dev-report routed through the
  helper.
- 6 new tests in `test/report-date.test.ts`, including a
  `Date.now` jump that emulates the orchestrator-snapshot
  surviving a midnight rollover.

#### Tools-used footer reads cleanly when one pack's lint skipped (D138 follow-up)

The 2.4.7 D138 work landed honesty-prose in the dedicated
`⚠ Lint coverage gap` row when one active language pack's
linter didn't run. But the `Tools used:` footer at the bottom
of every report was still rendering the augmented label
verbatim — so on a polyglot repo it read
`..., ruff (not run: typescript — config error), ...`, which
parses as "ruff did not run because of typescript" (false;
ruff ran fine on Python files; the parenthetical describes
eslint's fate, not ruff's). Internal commas inside the
parenthetical also broke the comma-split that fanned the
footer string into individual tool names.

Fix (commit `98ea153`):

- New `src/analyzers/tools/lint-label.ts` centralises the
  parse (regex + `stripNotRunSuffix` helper).
- `splitToolNames` in `health.ts` and the `toolsUsed` push in
  `quality/index.ts` both strip the `(not run: ...)` suffix
  before emitting into the footer.
- The dedicated `⚠ Lint coverage gap` row keeps its own
  augmented-label parse — that row is exactly where the
  per-pack skip belongs.
- 11 tests in `test/lint-label.test.ts` cover single-pack,
  multi-pack with internal commas, and malformed input.

#### Cascade warning when health fails before the analysis cache builds (related to D141)

When the Health step fails before the cross-process
`AnalysisResult` cache is built, every downstream report
(Vulnerabilities, BoM, Licenses, Test gaps, Quality,
Developer) re-runs detection + Layer 0 + Layer 2 gather from
scratch — measurably slower than the cache-hit path. On a
heavy polyglot repo this can add hundreds of seconds across
the run. The structural fix (build the cache from the
gather output even when the markdown write fails) is the
larger piece; this release surfaces the symptom honestly so
the user understands why the remaining steps feel slower.

Fix (commit `fa019f8`):

- When Health fails before the cache is built, the
  orchestrator logs:
  `Health failed before the analysis cache could be built.
  The remaining steps will re-detect the stack and re-gather
  shared metrics from scratch (expect each to be measurably
  slower than usual).`
- No new tests — the warning is exercised end-to-end via
  the orchestrator's existing integration coverage.

#### README upgrade advisory now matches the observed behavior of modern npm (related to F3 audit finding)

The 2.4.7 README's "Already installed dxkit globally?" callout
claimed `npx @vyuhlabs/dxkit@<version>` falls through to a
stale `vyuh-dxkit` global on PATH. Tested under npm 11.6.0
with a stale 2.4.2 global installed, `npx @vyuhlabs/dxkit@2.4.7
--version` correctly returned `2.4.7` — modern npm/npx does
not fall through. A reader following the advisory might
uninstall a working global install on advice that doesn't
match their environment.

Fix (commit `6d8363b`): rewrites the callout to keep the
genuinely useful upgrade hint (globals don't auto-update;
either upgrade them or remove them and rely on `npx`) without
the inaccurate npx-behaviour assertion. Also drops the
2.4.7-specific fix-mention which would have gone stale after
this release.

### Test posture

- `npm run test:run` — **1265 / 0** (up from 1241).
- `+6` tests for D140 (`test/report-date.test.ts`).
- `+11` tests for D138 follow-up (`test/lint-label.test.ts`).
- `+7` tests for D141 (`test/dispatcher-deadline.test.ts`),
  including the D138-class regression that simulates a
  never-settling provider and asserts the dispatcher returns
  within the deadline window with the stalled source in
  `skipped` + `skipReasons`.
- arch / slop / lint / format / typecheck — all clean.

## [2.4.7] - 2026-05-17

### Summary

2.4.7 is the largest release since the language-pack architecture
landed. It bundles three distinct architectural deliverables
(actionable scoring foundation, per-stack architectural shape,
canonical security aggregator), customer-visible UX rework
(security top-5 actions, .env-in-git callout, lint-skip prose
honesty, tools-unavailable renderer split), one ship-blocker
root-cause fix (silent health failure under concurrent subprocess
load), and the project's OSS hygiene baseline. 17 defect IDs
closed in this version. Scoring methodology now anchored to
ISO/IEC 25010, ISO/IEC 5055, SQALE, CVSS v4, CWE, OWASP, and
OpenSSF Scorecard. Tests: 1241 / 0 (up from 1175 at the 2.4.6
baseline). No runtime regressions across the cross-ecosystem
matrix.

Customer-visible numeric impact: scores on some repos will shift
between 2.4.6 and 2.4.7 because the underlying methodology
changed (see the "Actionable scoring foundation" section below
and its "Customer-visible score changes" subsection), not because
of bugs. Migration notes at
[`docs/MIGRATING-TO-2.4.7-SCORING.md`](docs/MIGRATING-TO-2.4.7-SCORING.md).

### Phase C11 — OSS hygiene baseline (2026-05-17)

Adds the standard set of OSS community files so the project
satisfies the OpenSSF Scorecard `Security-Policy`,
`Code-of-Conduct`, and `Contributors` checks and gives external
contributors a clear on-ramp.

- `SECURITY.md` — supported-versions table, response SLAs, explicit
  scope, and a pointer to GitHub's [private vulnerability
  reporting](https://github.com/vyuh-labs/dxkit/security/advisories/new)
  (no public email; routes directly to maintainers).
- `CODE_OF_CONDUCT.md` — adopts the [Contributor Covenant
  2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
  by canonical URL reference. Reports route through the same
  private channel as security disclosures.
- `.github/PULL_REQUEST_TEMPLATE.md` — summary + motivation +
  verification checklist + an architectural-rules pointer section
  nudging contributors at the relevant CLAUDE.md rules before
  touching scoring / language packs / exclusions / tool invocation.
- `.github/ISSUE_TEMPLATE/bug.yml` — issue form: repro steps,
  versions (dxkit + Node), OS, repo stack, logs. Confirmations
  block routes security reports to private disclosure.
- `.github/ISSUE_TEMPLATE/feature.yml` — issue form: problem
  framing, proposal, alternatives considered, scope dropdown.
- `.github/ISSUE_TEMPLATE/question.yml` — light triage form that
  redirects bug / feature / security reports to the right channel
  and surfaces existing docs (README, SCORING.md, CLAUDE.md).
- `docs/ARCHITECTURE.md` — short tour of the analyzer data flow,
  the three core patterns (language packs, scoring specs,
  centralized exclusions + tool registry), the `runDetached`
  subprocess discipline, the `AnalysisResult` cache, and the
  release flow. Entry-point doc; defers to CLAUDE.md as the
  authoritative rule set.

No runtime code changes. Commits: `93a1790`.

### Phase C10.25 — Audit-residue closures + silent-failure root-cause (2026-05-17)

The earlier phases of 2.4.7 brought enough new code into the
analyzer that a pre-ship convergence audit on the three external
customer repos surfaced one HIGH-severity defect — the report
orchestrator's health step intermittently exiting `rc=0` with no
`health-audit-*.md` written on the heaviest polyglot repo — plus a
batch of MEDIUM residue items. This phase closes all of them.
Pairs with the per-stack architectural-shape work below to leave
2.4.7 with zero outstanding ship blockers.

#### Silent health-failure root-cause (D134)

The report orchestrator's health step on a heavy polyglot repo
(13k+ graphify function nodes, ~700 source files, large
`node_modules`) intermittently exited `rc=0` with no
`health-audit-*.md` written. The dashboard then read "no health
data" while the orchestrator itself printed `✓ Health`.
Investigation via a `spawnSync` reproducer plus targeted
diagnostic instrumentation captured the failure shape:

```
[beforeExit] code=0 reachedWrite=false writeComplete=false
[exit]       code=0 reachedWrite=false writeComplete=false
```

No `uncaughtException`, no `unhandledRejection` — classic
abandoned-Promise. Under concurrent subprocess load (semgrep +
jscpd + graphify all spawning grandchildren), one `runDetached`
invocation's `exit` and `error` events both failed to fire. The
Promise stayed permanently pending, the capabilities `Promise.all`
hung, `analyzeHealthInternal`'s `await` never returned, Node's
event loop emptied and the process exited cleanly with the main
task still suspended.

Fix in `src/analyzers/tools/runner.ts` (commit `55ce0d6`):

- **Single-resolve `settle()` guard** — `exit` / `error` /
  safety-deadline, first wins; subsequent events are no-ops.
- **Error listener registered BEFORE other setup** to close the
  spawn-time-emission race window.
- **Safety deadline at `timeoutMs + 30_000`** — the Promise
  mathematically must settle within that window even if every
  event source fails.

Verification on the failure repo:

- Pre-fix: 795-800 s, `rc=0`, **no** health markdown on disk.
- Post-fix: 662.8 s, `rc=0`, full health markdown on disk.

Defense-in-depth (commit `5b6e360`): the `report` orchestrator
now asserts each step wrote its expected markdown post-step. A
future regression that re-introduces the hang surfaces a per-step
`✗` instead of a silent `✓`.

#### jscpd OOM class-fix — centralized exclusions plumbed into `--ignore` (D139)

jscpd was invoked with `--gitignore` + the autogen-pattern list but
NOT dxkit's bundled `default-exclusions.gitignore` / `.dxkit-ignore`
union — the same exclusion set every in-process walker (cloc, grep,
semgrep, graphify's Python filter) honors. Repos committing vendored
bundles outside `.gitignore` (e.g. minified library copies under a
`public/` tree) led jscpd to descend in, tokenize multi-thousand-line
minified bundles, exhaust heap, and OOM-kill before flushing its
JSON report. The quality report would then read
"Duplication unavailable" on the densest repos — exactly the repos
where the metric mattered most.

Fix (commit `2afc097`):

- New `getJscpdIgnorePatterns(cwd)` helper in
  `src/analyzers/tools/exclusions.ts` returns the centralized
  exclusion set as `**/<pattern>`-style globs.
- `gatherJscpdResult` unions it with the autogen patterns and
  passes the union to jscpd's `--ignore`.
- `jscpdProvider` gains a `gatherOutcome` method so the
  dispatcher captures jscpd's actual failure reason
  ("not installed" / "timed out at 600s" / "exit code N
  (stderr: ...)" / "no output" / "parse error") instead of
  dropping it at the gather / `null` boundary.

CLAUDE.md Rule 4 ("Exclusions come from `exclusions.ts`") was
honored at the in-process walker layer but not at the
subprocess-tool argument-builder layer. This closes that drift
for jscpd and lays the pattern for any future subprocess tool
that walks the repo.

Verification on the worst-case repo:

- **Standalone smoke**: 569 s OOM → 17 s success, **7.26 %**
  duplication, 444 clones, 7 423 duplicated lines.
- **End-to-end via `vyuh-dxkit quality`**: capabilities-gather
  770 s → 272 s (jscpd no longer the long pole; eslint also
  surfaces its real findings as a side-effect, contributing
  10 496 errors + 2 787 warnings that were previously masked).

#### Tools-unavailable renderer prose-honesty (D138)

The dispatcher's `skipReasons` channel already carried the real
per-source failure reason for every attempted-but-failed tool, but
`availabilityFromOutcome` in `src/analyzers/health.ts` collapsed
every case to a generic "attempted but produced no output (likely
killed by resource limits — try running dxkit on this repo alone)"
prose. The renderer then printed `**Tools unavailable:** jscpd
(...)` — a reader reasonably concluded the binary needed
installing, when in fact the binary was fine and the run had
OOM'd at runtime. Same misleading-label class as D113 / D128
(lint-skip prose) and D135 (cache-level availability envelope) —
this fix extends the honesty pattern one layer up to the renderer
header label.

Fix (commit `425d0ef`):

- `semgrepProvider` + `graphifyProvider` gain `gatherOutcome`
  (jscpdProvider's method came with the companion D139 commit).
  The dispatcher now captures the real per-source reason into
  `DispatchOutcome.skipReasons`.
- `availabilityFromOutcome` prefers `skipReasons[<source>]` when
  present; falls back to the generic prose for legacy providers
  without `gatherOutcome`.
- New `splitToolsUnavailable` / `renderToolsUnavailableLines`
  helpers in `src/analyzers/tools/tools-unavailable-prose.ts`
  route entries into two honest categories:
  - `**Tools not installed:**` — action: install
  - `**Tools that failed at runtime:**` — action: investigate
- 9 markdown renderer call-sites (`cli.ts`, tests / security /
  quality / health / bom analyzer surfaces, each with their
  `index.ts` and `detailed.ts` formatter pair) + the xlsx BoM
  (two worksheet rows) all share the canonical helper.

#### Other audit-residue closures

| ID(s)                | Description                                                                                                                                                                                                             | Closing commit |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| D124 / D100 / D118   | Vendored-source exclusion class-fix — top-largest-file metric on all 3 customer repos now first-party (or correctly flagged by the per-file advisor). Generic `largest_files` walk routes through canonical exclusions. | `72ec70a`      |
| D113 / D128          | Per-pack lint-skip reasons plumbed end-to-end. Tools row reads `ruff (not run: typescript — config error)` instead of dropping the skip silently.                                                                       | `b878553`      |
| D118-residue         | Graphify enumeration honors file-glob + content-minified exclusions. Webpack-hash bundles no longer rank as the densest file on customer reports (the JS-heavy customer frontend: 4 606 fn artifact → 228 fn real first-party densest).     | `0da08bd`      |
| D135 / D136 (interim) | Vendored-advisor token list extended for SAP B1 OData proxy classes, map-library, proto-gen conventions. Customers with heavy-autogen .NET ERP integrations now see actionable `.dxkit-ignore` guidance.                | `d9f0c31`      |

Tests at this phase close: 1241 / 0 (+15 new unit tests for
`getJscpdIgnorePatterns`, `splitToolsUnavailable`,
`renderToolsUnavailableLines`). Architecture gate clean.

### Phase C8 — Per-stack architectural shape (2026-05-17)

Before this phase, the analyzers carried hardcoded Node-backend-
centric path patterns (`'/controllers/'`, `'/services/'`,
`'/models/'`) and a closed `SourceFile.type` union (`'controller'
| 'service' | 'model' | ...`). A pure React frontend or a .NET
WinForms desktop app matched none of the defaults and reported
`0/0/0` across test-gap CRITICAL / HIGH / MEDIUM buckets — the
kind of metric that reads as a bug to a frontend or desktop
developer scanning the report.

This phase replaces the hardcoded vocabulary with a per-pack
`architecturalShape` capability on `LanguageSupport`. Each pack
declares its own primary-component paths, route-handler paths,
data-model paths, prose vocabulary, and per-bucket test-gap
priority taxonomy. Cross-cutting analyzer code unions across
active packs at runtime — so a polyglot repo's metrics correctly
span TypeScript's `/controllers/` + `/components/` alongside
C#'s `Forms/`, and adding a new language pack auto-extends every
consumer.

#### What landed

- New `architecturalShape?: ArchitecturalShape` field on
  `LanguageSupport` (commit `9a6c48d`).
- 7 packs contribute concrete shapes (commit `c313744`). E.g.
  the csharp pack declares `Forms/`, `ViewModels/`, `Services/`;
  the typescript pack declares `/controllers/`, `/services/`,
  `/models/`, `/components/`, `/hooks/`; the python pack
  declares `/views/`, `/viewsets/`, `/models/`, `/serializers/`.
  Two packs (rust, go) intentionally omit `architecturalShape`
  — they don't have a canonical convention strong enough to
  declare without overfitting.
- Five consumer migrations onto the new helpers (commit
  `6ab2712`): `analyzers/tools/generic.ts` (largest-file +
  source-walk classification), `analyzers/maintainability/shallow.ts`
  (vocabulary prose), `analyzers/security/actions.ts`
  (route-handler attribution), `analyzers/tests/index.ts`
  (test-gap priority taxonomy), `analyzers/health.ts`
  (route-handler files count).
- Cross-cutting registry helpers in `src/languages/index.ts`:
  `allPrimaryComponentPaths(flags)`, `allRoutePaths(flags)`,
  `allModelPaths(flags)`, `allTestGapPriorityPaths(flags)`,
  `dominantVocabulary(flags)` — every consumer reads from the
  active-pack union.
- `dominantVocabulary` weighted by cloc line count (commit
  `7147f3f`) so a polyglot repo's vocabulary prose matches the
  dominant stack. A 106k-line-TS / 1.2k-line-Python monorepo
  correctly renders as "controllers + components", not
  "views + viewsets".
- Two new arch-gate rules (commit `c4f9c20`) in
  `scripts/check-architecture.sh`:
  - No quoted path-style framework literals (`'/controllers/'`,
    `'/services/'`, etc.) inside `src/analyzers/` — they belong
    in `LanguageSupport.architecturalShape`.
  - No bare singular role-name string literals (`'controller'`,
    `'service'`, `'handler'`, `'interceptor'`, `'repository'`,
    `'viewmodel'`, `'viewset'`, `'router'`) — the pre-extension
    closed enum is replaced by free string labels derived from
    `patternToLabel(matched architectural-shape pattern)`.
- Synthetic 6th-pack injection assertion in
  `test/recipe-playbook.test.ts` — confirms an
  `architecturalShape` contribution from a brand-new pack flows
  through test-gap taxonomy and Maintainability prose without
  cross-cutting edits.
- CLAUDE.md gains Rule 8 documenting the new architecture.

#### Customer-visible effects (verified post-fix)

- **platform** (TS / Node backend): test-gap MEDIUM 207;
  Maintainability prose reads "controllers / components"
  (typescript wins cloc weight on a 106k-line monorepo).
- **the JS-heavy customer frontend** (React frontend): test-gap MEDIUM 499 → 379
  (-120) because the vendored-exclusion class-fix in the
  audit-residue phase above also excludes lexical-playground
  subtrees from primary-component matching. Honest count.
- **the .NET WinForms benchmark** (.NET WinForms): Maintainability vocabulary
  reads "Forms / Services"; test-gap classification correctly
  picks up the WinForms project structure.

#### Defects closed

| ID   | Description                                                                                | Closing commit(s)    |
| ---- | ------------------------------------------------------------------------------------------ | -------------------- |
| D119 | Test-gap priority taxonomy backend-centric (HIGH; misleading on non-Node-backend stacks)   | this phase, above    |
| D101 | React / csharp Maintainability vocabulary                                                  | this phase, above    |
| D065 | API-docs gate on `routeHandlerFiles`                                                       | this phase, above    |

### Phase C7 — Actionable scoring foundation (2026-05-17)

Reframes dxkit's six-dimension scoring from descriptive ("Code
Quality: 75/100, Good") to actionable ("Code Quality: 75/100, B —
top action: fix 11 lint errors for +10, would lift rating to A").
The numeric scores stay on the same 0-100 scale; every dimension
now also produces structured provenance that tells the customer
what to fix and how much the score would lift.

dxkit's scoring is now **deterministic** (same repo + same dxkit
version → identical score, every machine), **anchored** (cites
underlying open standards: ISO/IEC 25010, ISO/IEC 5055, SQALE
method, CVSS v4, CWE, OWASP, OpenSSF Scorecard), and **actionable**
(every score paired with structured `deductions`, `capsApplied`,
`topActions`).

See [`docs/SCORING.md`](docs/SCORING.md) for the full methodology
and [`docs/MIGRATING-TO-2.4.7-SCORING.md`](docs/MIGRATING-TO-2.4.7-SCORING.md)
for JSON-consumer migration.

#### Architecture

- **Single home for dimension scoring** at `src/scoring/`,
  mirroring the per-language pattern from CLAUDE.md Rule 6. Each
  of the six dimensions (Security, Code Quality, Tests,
  Documentation, Maintainability, Developer Experience) declares
  a `DimensionScoringSpec<T>` artifact under
  `src/scoring/dimensions/<id>.ts` consumed by a shared
  pure-function evaluator. Adding a new dimension is a recipe
  documented in CONTRIBUTING.md.
- **Cap-tier taxonomy** named by severity: `trust-broken` (40,
  catastrophic), `unmeasured` (35, no signal), `uncertainty` (65,
  key tool missing), `partial-uncertainty` (75, partial gap),
  `fixable-finding` (79, concrete bounded finding open). Caps
  enforce the Label Contract: "A" means "no known blockers."
- **Zero scoring code remains in `src/analyzers/`**. Files deleted
  in full: `src/analyzers/scoring.ts`, `src/analyzers/security/scoring.ts`,
  `src/analyzers/quality/scoring.ts`. CLAUDE.md gains Rule 7
  documenting the new architecture; three new arch-gate rules in
  `scripts/check-architecture.sh` prevent regression.
- **Scoring playbook test** (`test/scoring-playbook.test.ts`)
  injects a synthetic 7th-dimension spec to confirm the registry
  + evaluator + format helpers stay spec-driven.

#### Customer-visible score changes

- **D131 closure — Security HIGH+ open caps at 79 (B)**. Pre-2.4.7
  a single open HIGH-severity code finding (e.g. a TLS-validation
  bypass) left the Security dimension at 95/100 ("Excellent") —
  the headline contradicted the unfixed finding. Now repos with at
  least one open HIGH or CRITICAL code finding cap at 79 (B grade)
  with the cap explicit in the rendered report:
  `Rating cap: 1 open HIGH+ code finding — bounded at 79/100`.
  Repos with zero open HIGH+ are unaffected.
- **D129 closure — severe-debt disclosure**. Pre-2.4.7, "Code
  Quality 0/100" rendered identically whether the penalty stack
  totalled -5 (barely below the floor) or -85 (catastrophic). The
  Top Actions block now surfaces the rawPenalty when the score
  floors at 0: `Severe: raw penalty -85 (deductions exceed the
  floor).`
- **Maintainability — SQALE baseline shift**. Methodology
  migrated to ISO/IEC 25010 + SQALE-inspired step thresholds.
  Baseline shifts from 70 to 100 (matches every other subtractive
  dimension); the small-codebase bonus is removed as overfit.
  Clean repos see Maintainability scores rise by ~30 points.
  Documented behavior change.
- **Testing — cap-then-penalty ordering**. When `commentedCodeRatio
  > 0.5` AND coverage data missing, the final score is now 35 (cap
  binds as the ceiling). Pre-2.4.7 it was 20 (cap then sub-cap
  subtraction). The new semantic is cleaner — caps are ceilings,
  not floors-and-then-keep-subtracting. Affects a narrow edge case.
- **No-tests-found surfaces as a Top Action**. Repos with zero
  test files now show a dedicated deduction +60 with severe-debt
  disclosure, pointing at test-gaps for the ranked critical files.
  Pre-2.4.7 these repos had a 0/E Tests score with no actionable
  signal in the dimension's Top Actions block.
- **`DimensionScore.status` → `rating`**. The descriptive enum
  (`'excellent' | 'good' | 'fair' | 'poor' | 'critical'`) is
  replaced by a uniform letter rating (`'A' | 'B' | 'C' | 'D' |
  'E'`). The overall summary's `grade` field renames to `rating`
  with the same `F` → `E` enum unification.
- **Documentation + Developer Experience specs inverted from
  additive to subtractive**. Numeric scores preserved by
  construction; the `deductions[]` list now reads as
  actions-to-take ("README missing") rather than bonuses already
  earned ("README present").

#### Renderer + JSON

- CLI grid prints a top-action continuation under each dimension
  line: `→ 11 lint errors +10 (B → A)`.
- Health detailed markdown gains a `Top actions (sorted by score
  uplift)` block per dimension with rating-transition annotations.
- Dashboard hero now reads `Rating D` instead of `Grade D`.
- Health-detailed JSON schema bumps `11` → `12` for the new
  provenance fields on `DimensionScore` (`rawScore`,
  `rawPenalty`, `methodology`, `deductions`, `capsApplied`,
  `topActions`). All optional — pre-2.4.7 consumers continue to
  work.

Two-phase release. **Phase A** (audit-driven hot-patches, originally
shipped 2026-05-13) closed a 17-defect cascade surfaced by a critical
post-shipment audit on the .NET WinForms benchmark (enterprise C# / 1500+ files / 68
sub-projects / 1.6M lines of cloc-counted JSON), plus the long-deferred
D021 (coverage workflow). **Phase B** (class-fix release, 2026-05-14)
pivoted from patch shipping to architectural class-fix shipping after
pre-ship audits on platform and the JS-heavy customer frontend surfaced 12 NEW defects
(D074–D085), 9 of which were repeated instances of the same disease
class fixed at different sites.

### Phase C2 — Security UX rework (2026-05-14)

Builds on Phase C1's typed canonical aggregator with the user-facing
UX changes the 2026-05-14 critical-perspective audit demanded. C1
closed the architectural drift class; C2 closes the labeling,
scoring-credibility, and prioritization gaps that remained.

- **C2.1 — Vuln-scan section split** (commit `e637911`). The pre-C2
  executive summary had ONE "Code Findings" table that combined
  codeBySeverity + secretsBySeverity under a label that meant
  code-only to health-side prose. Readers (and AI agents) saw
  apparent drift between health "10H code findings" and vuln-scan
  "Code Findings: 16H." Both numbers were correct for their scopes,
  but the labels obscured this. C2.1 splits the executive summary
  into three labeled tables — **Code Findings** (code-pattern only,
  matches health), **Secret & Config Findings** (gitleaks +
  private-key + .env), **Dependency Vulnerabilities** (unchanged).
  `SecurityReport.summary` grows `codeOnly` and `secretsOnly`
  siblings of `findings`; renderer reads them by name.

- **C2.2 / D098 — `SECRETS_PRESENT_CAP = 40`** (commit `243fa86`).
  Pre-C2 baseline: the JS-heavy customer frontend scored Security 60/100 "Good" despite
  4 hardcoded API keys + 1 .env in git. Credentials in source-control
  history are presumed compromised even after rotation, and a "Good"
  score reads as deprioritizable. C2.2 caps the Security dimension at
  ≤ 40 ("Fair" or worse) whenever `secretFindings > 0 ||
  privateKeyFiles > 0 || envFilesInGit > 0`. Applied as a ceiling
  AFTER all per-signal penalties and the dep-availability cap, so
  it composes monotonically with everything else.
  - Validated: the JS-heavy customer frontend 60 → 40 "Fair" (✓ cap fires);
    platform 45 → 40 "Fair" (✓); the .NET WinForms benchmark 90 → 90 (✓ cap
    correctly does NOT fire — no committed credentials).

- **C2.3 / D099 — `.env`-in-git callout block** (commit `7f43dfc`).
  Pre-C2 a `.env` finding appeared as a plain HIGH entry in the
  Configuration Issues section with no actionable command. C2.3
  adds a dedicated `## 🚨 .env files tracked in git` block between
  the executive summary and the per-category sections. Contents:
  rotation caveat ("presumed compromised even after deletion"),
  working-tree bash block (`git rm --cached <file>` per file +
  `.gitignore` + commit), and history-rewrite block
  (`git filter-repo` preferred + BFG alternative + "every
  collaborator must re-clone" coordination caveat).

- **C2.4 / D105 — Top 5 priority actions** (commit `6fe45fa`).
  Pre-C2 reports listed every finding by severity within category;
  no prioritization surface. A reader scanning the report had to
  skim dozens of medium findings to spot the one KEV-listed dep
  upgrade that actually mattered this week. C2.4 adds a
  `## 🎯 Top 5 Priority Actions` markdown table at the top of the
  findings sections. Priority order codifies the triage rubric:
  KEV deps → hardcoded secrets → .env in git → private-key files →
  non-KEV deps by risk-score tier → HIGH/CRITICAL code findings.
  Capped at 5 — anything below the cap shows up in the per-category
  sections below.

- **D108 — Top 5 sparse-tier fallback** (commit `c09ba87`). C2.5
  audit surfaced D108: the .NET WinForms benchmark's Top 5 had only 1 entry despite
  2 unpatched dep vulns (MongoDB.Driver risk 19 + SharpCompress
  risk 15). The original C2.4 dep filter required `riskScore >= 25`
  which excluded the "watch" tier (10-25 per risk-score.ts), leaving
  the table sparse. Fix: tier-iterate dep risk-score buckets
  (`≥ 50 → 25-50 → 10-25 → ≥ 0`) and stop only when Top 5 is full.
  Findings without scored risk surface in the lowest tier so
  nothing is silently dropped.

### Phase C2 — Verification audit (C2.5)

Cross-report parity audit on three customer repos (`platform`,
the .NET WinForms benchmark, the JS-heavy customer frontend). All vuln-scan + health pairs verified:

- **D086 / D087 / D091 closures from C1 remain intact** across
  all 3 repos. Cross-report parity holds.
- **D098 secrets-cap fires correctly**: the JS-heavy customer frontend + platform both
  drop to 40 "Fair"; the .NET WinForms benchmark (no secrets) stays at 90.
- **D099 .env callout renders correctly on the JS-heavy customer frontend** (the only
  repo with a tracked .env).
- **D105 Top 5 surfaces actionable rows on every repo**, post-D108
  including the sparse-repo case.

### D109 investigation — non-defect

C2.5 also surfaced a candidate drift: platform vuln-scan code-only
`10H 7M` vs health `10H 10M`. HIGH agreed; MEDIUM differed by 3.
Investigation via an in-process probe (`tmp/d109-probe.js` runs
both analyzers sequentially in ONE node process, sharing the
dispatcher cache) showed identical aggregates: `{ high: 10,
medium: 20 }` on both sides. **D109 is NOT a real defect** — the
architecture is sound. The observed drift across separate
processes was semgrep tool-runtime variance (MEDIUM count varied
7 → 10 → 20 across runs while HIGH stayed stable at 10). Future
docs follow-up: note semgrep's non-determinism as a known
limitation.

### Phase C1 — Canonical security aggregator (2026-05-14)

Three customer-facing aggregation-drift defects (D086, D087, D091)
shared one root: **multiple consumers re-counting severity from raw
envelope arrays with different inclusion rules**. Phase B closed
this class at the GATHER layer (canonical `walkSourceFiles`); Phase
C1 closes it at the AGGREGATION layer with the same class-fix
discipline plus two newly-surfaced defects (D107 BoM vs vuln-scan
disagreement, D091-boundary neighbor-bucket miss) caught during the
pre-release audit and fixed before ship.

- **Canonical `SecurityAggregate`** (commit `a3942f4`). New
  `src/analyzers/security/aggregator.ts` exporting
  `buildSecurityAggregate(envelopes) → SecurityAggregate`. The typed
  contract carries three separately-named severity buckets
  (`codeBySeverity`, `depBySeverity`, `secretsBySeverity`), two
  distinct dep-count fields (`dependencyAdvisoryUniqueCount`
  canonical user-facing + `dependencyFindingsRawCount` for audit),
  fingerprint-stamped `CodeFinding[]` per category, dedup audit
  trail, and per-source provenance. Renderers cannot accidentally
  sum cross-axis or pick the wrong number — both defects become
  impossible by the typed shape.

- **Six consumers migrated** onto the aggregate (4 user-facing + 2
  internal):
  - `security/index.ts` standalone vuln-scan (commit `f3bd69f`, D087
    closure — Subtotal now matches "N advisories" by reading
    `dependencyAdvisoryUniqueCount` by name)
  - `security/shallow.ts` health-side scorer (commit `c73c7ca`, D086
    closure — code-finding prose reads `codeBySeverity` from the same
    field vuln-scan reads)
  - `dashboard/index.ts` (commit `9fb0220` — reads severity buckets
    from `vulns.summary.findings + dependencies` instead of re-summing
    finding arrays)
  - BoM (commit `4ae69ed` C1.8, D107 closure — see below)
  - C# pack (commit `14b02a7` C1.9, G_v4_9 — see below)
  - Action planner + legacy fallback (`actions.ts`, `shallow.ts`)
    annotated `// aggregator-ok` for the two legitimate exceptions
    (rebuilding `SecurityScoreInput` from a `SecurityReport`; legacy
    ScoreInput fixtures predating the aggregator field).

- **D107 — BoM vs vuln-scan disagreement (NEW, surfaced in C1.7
  audit)** (commit `4ae69ed`). the .NET WinForms benchmark: vuln-scan reported 2 dep
  advisories (MongoDB.Driver HIGH + SharpCompress MEDIUM via
  osv-scanner-nuget-direct) while BoM reported 0. Root cause: BoM
  walks per-sub-root project directories and called `gatherDepVulns`
  at each sub-root, hitting the csharp pack's cwd-sensitive routing
  (at sub-root with stale `obj/project.assets.json`, dotnet returned
  0; at repo-root with no `.csproj`, the fallback fired). Fix: BoM
  now gathers dep-vulns ONCE at the repo root and passes the result
  to every per-sub-root entry builder via a new `depVulnsOverride`
  option. License-side stays per-sub-root (legitimately
  per-project). Post-fix: the .NET WinForms benchmark BoM 2 ≡ vuln-scan 2.

- **G_v4_9 — csharp pack cwd-invariant** (commit `14b02a7`). The
  pack-contract defect underneath D107: `gatherCsharpDepVulnsResult`
  produced different fingerprint sets depending on where `cwd`
  pointed within the repo. Fix: always run BOTH `dotnet list package
  --vulnerable` (when applicable) AND
  `osv-scanner-nuget-direct` (the direct PackageReference parse)
  in parallel, merge findings by `(package, installedVersion, id)`
  fingerprint at the pack layer. Envelope counts recomputed from the
  merged set; `tool` field joins what ran. Result: same fingerprint
  set regardless of cwd. Any future multi-cwd caller now inherits
  consistency.

- **D091 boundary case (NEW, surfaced in C1.7 audit)** (commit
  `c7b72e2`). The JS-heavy customer frontend `SetupConfigForm.js:43` (semgrep MEDIUM
  `bypass-tls-verification`) and `:45` (registry HIGH
  `tls-validation-disabled`) — same root, 2 lines apart, same
  canonical rule — failed to collapse because the
  `Math.floor(line/3)*3` bucketing put them in different buckets
  (42 and 45, straddling a multiple-of-3). Documented as a known
  edge case in the C1.1 commit; biting in production was the trigger
  to fix it. Fix: after the natural-bucket lookup misses, check
  neighbor buckets at `(canonicalRule, file, line ± 3)`. Two
  MEDIUMs absorbed into HIGHs on the JS-heavy customer frontend, reducing apparent
  code-finding count from 13 → 11 in the right direction.

- **G_v4_8 architectural gate** (commit `6e89131`) in
  `scripts/check-architecture.sh`. Blocks the smoking-gun pattern
  (`[<var>.severity]++` accumulator bump, or
  `function countBySeverity(`) outside the canonical aggregator.
  Static lookup maps (`SEV_RANK`, `SEV_LABEL`) and type-decl fields
  inside interfaces don't match — only the actual aggregation shape.
  BoM's per-package `[e.maxSeverity]++` naturally falls outside the
  pattern (different attribute name) so BoM's legitimate per-package
  aggregation is unaffected.

- **Recipe codification (G_v4_8 + G_v4_9 in
  `tmp/recipe-v4-working-doc.md`)**. Two recipe-playbook
  synthetic-pack assertions in `test/recipe-playbook.test.ts`
  (synthetic depVuln finding flows into `depBySeverity` +
  `dependencyAdvisoryUniqueCount`; cross-tool TLS-bypass collapses
  regardless of pack identity). Future language packs feeding
  security data through standard capability descriptors
  automatically inherit drift prevention.

### Phase C1 — Defect closures

| ID | Status | Closing commit(s) |
| --- | --- | --- |
| D086 | CLOSED (architectural) | `a3942f4` + `c73c7ca` — both surfaces read `aggregate.codeBySeverity` |
| D087 | CLOSED | `a3942f4` + `f3bd69f` — `dependencyAdvisoryUniqueCount` field forces the canonical count |
| D091 | CLOSED | `a3942f4` (canonical-rule registry + line-window) + `c7b72e2` (neighbor-bucket lookup for boundary case) |
| D107 | CLOSED (NEW, two layers) | `4ae69ed` (BoM single-source) + `14b02a7` (G_v4_9 csharp cwd-invariant) |

### Phase C1 — Empirical validation

Cross-report parity audit on three customer repos (all numbers
post-Phase-C1):

- **platform** (1500+ TS/Node files, 2 project roots):
  - vuln-scan Subtotal **81** ≡ "**81** advisories" ≡ "Showing 50 of
    **81**" ≡ BoM `totalAdvisories` **81** ✓
  - 5 cross-tool TLS-bypass collisions deduped (MEDIUM bucket
    14 → 9)
- **the .NET WinForms benchmark** (C#, 3 nested project roots):
  - vuln-scan **2** ≡ BoM **2** ≡ health **2** (dep) ✓
  - health code findings **1** ≡ vuln-scan code findings **1** ✓
- **the JS-heavy customer frontend** (JS-heavy, large repo with degraded license info):
  - dep advisories **31** ≡ **31** ≡ **31** ✓
  - D091-boundary case on `SetupConfigForm.js:43+:45` collapses (the
    C1.10 fix)
  - 2 MEDIUMs absorbed into HIGHs via neighbor-bucket lookup

Tests: **1178 passed / 8 skipped** (1175 pre-Phase-C + 1 + 2 + 1 new
unit/synthetic-pack assertions). Architecture gate clean. No
regressions across the cross-ecosystem matrix.

Open and deferred to Phase C2-C8 (still inside 2.4.7 per the
2026-05-14 reprioritization):

- C2: Security UX rework — split vuln-scan "Code Findings" section
  into code-only + secret/config (closes the perception-level D086
  drift even though architectural drift is gone), security rubric
  weights secrets/.env heavily (D098), Top 5 actions in short
  reports (D105), .env-in-git callout (D099)
- C3: D094 CWE truncation (`**CWE:** C` still on 2 platform
  semgrep findings), D090 Remediation Commands split
- C4: D100 vendor-path exclusions
- C5: D093 word-boundary truncation, D096 densest-file
  clarification
- C6: D106 agent rewrites
- C7: Final pre-release validation
- C8: PR → main → tag v2.4.7 → SLSA publish

### Phase B — Class-fix release (2026-05-14)

Two architectural deliverables backed by 4 consumer-site migrations
and a permanent gate:

- **G_v4_7 — `walkSourceFiles` + `countLineMatches`** (new canonical
  helpers in `src/analyzers/tools/walk-source-files.ts`). Pure JS,
  no shell. The the JS-heavy customer frontend D082/D083 silent-zero cascade was caused
  by `grep -rEf <pat> --include=*.js .` producing 67MB of stdout on
  minified files, overflowing `run()`'s 64MB ceiling, and returning
  empty. The walker prunes excluded files at the directory boundary,
  so grep is never asked to walk `public/build/*.min.js` in the
  first place. Bumping `maxBuffer` is a moving target — the right
  answer is "don't pass excluded files to the scanner at all."

- **Consumer migrations onto canonical helpers** (4 sites):
  - `tools/generic.ts` (commits `3275e1e` + `226a56a`)
  - `quality/gather.ts` (commit `82e0e75`)
  - `tests/gather.ts` (commit `753a412`)
  - `security/gather.ts` TLS-bypass walk (commit `099e844`)
  Each migration is behavior-preserving by default (e.g. `includeTests: true`
  preserves pre-migration semantics where the legacy grep matched in
  test files too).

- **`gatherDebugStatements` shared helper** (commit `e7a8821`).
  Replaces the two divergent implementations in `health.consoleLogCount`
  (sum of JS console + Python print + Go fmt.Print across language-
  scoped walks) and `quality.consoleLogCount` (single console.* pattern
  across all extensions). After: both reports route through one
  function — they cannot drift.

- **Architectural gate** (commit `32574e0`) in
  `scripts/check-architecture.sh`. Blocks new
  `grep -r{l,n,c,E,f}` calls in production code outside a 4-file
  allowlist. After this release, the D082/D083 class of bug cannot
  recur without explicitly bypassing the canonical helpers — which
  the gate blocks.

### Phase B — Defect closures (D074–D080, D082–D085)

| ID | Severity | Closing commit(s) |
| --- | --- | --- |
| D074 — commented-out matches inflate counts | HIGH | `3275e1e` + `82e0e75` + `099e844` + `e7a8821` (`skipComments: true` on print-family / anyType / eval / TLS-bypass) |
| D075 — sourceFiles cross-report drift | HIGH | `0e71683` + `3275e1e` + `753a412` + `e7a8821` (canonical walker + label alignment) |
| D076 — dep-vuln count drift health vs BoM | HIGH | `06b0cec` (BoM `totalAdvisories` uses unique fingerprint count) |
| D077 — dashboard tile drift | MED | closes with D075 |
| D078 — BoM Risk `**0.0**` for missing CVSS | MED | `46b0d6e` (`computeRiskScore` returns `null` for `cvssScore=0`) |
| D079 — duplicate grep-count implementations | MED | `82e0e75` + `e7a8821` (shared `gatherDebugStatements`) |
| D080 — lint dispatcher last-wins | MED | `72cd102` (`gatherWithProvenance` exposes attempted+skipped sources; label reads `"ruff (not run: typescript)"`) |
| D082 — the JS-heavy customer frontend `consoleLogCount = 0` silent zero | CRITICAL | `0e71683` + `3275e1e` + `e7a8821` (walker prunes minified files at directory boundary) |
| D083 — `run()` maxBuffer overflow on minified-JS | CRITICAL | `0e71683` + `3275e1e` + `099e844` + `32574e0` |
| D084 — D082 cascade (anyType, eval) | HIGH | closes with D082/D083 |
| D085 — the JS-heavy customer frontend dep-count drift | HIGH | `06b0cec` |

**Deferred to 2.4.8**:
- D081 (`Dead Imports: 0` suspicious) — investigated; root cause is
  graphify Python script's `dead = imports - calls - module_ids`
  zeroing out module-style imports. Fix requires a new metric
  (`unreachableImportCount`) + synthetic tests + threshold tuning.
- **G_v4_8 full architectural enforcement** — typed gather-result
  interfaces with explicit field-ownership claims. Narrow D076/D085
  fix shipped (BoM uses fingerprint count); the typed-contract
  prevention layer is preventive hardening, not on the convergence-
  audit gate.

### Phase B — Empirical validation

Convergence audit on three customer repos:

- **the .NET WinForms benchmark**: 1537 source files consistent across health,
  test-gaps, maintainability dimension; `consoleLogCount=1`,
  `tlsDisabledCount=1` stable.
- **platform** (the audit's most-troubled repo): `sourceFiles`
  converged 447/438/444 → **444 / 444 / 444**;
  `consoleLogCount` cross-report converged 1578/1555 → **698 / 698**;
  `tlsDisabledCount` 18 reported / 11 active → **11**; lint label
  `"ruff"` → `"ruff (not run: typescript)"`.
- **the JS-heavy customer frontend**: `consoleLogCount` **0 → 1066** (D082/D083 closure;
  catastrophic silent zero eliminated).

### Phase A — Audit-driven hot-patches (2026-05-13)

The earlier portion of the 2.4.7 release. Same content as below —
preserved for traceability.

The cascade taught us that test-green ≠ report-correct: all 1091
tests passed before the audit. Reinforces
`feedback_critical_audit_before_shipping.md` — pre-delivery audit on
real customer reports is the gold standard, not the unit-test suite.

### Added — D021 close (coverage workflow)

Four pieces shipped together:

- **`coverageFidelity` tier** classifies the `coverageSource` field
  into three trust levels:
  - `line-coverage` — real artifact (istanbul / coverage-py / jacoco /
    simplecov / lcov / cobertura / go). The percent is line-coverage
    truth.
  - `import-graph` — derived from test-file import edges (up to N
    hops). Informed heuristic.
  - `filename-match` — share of source files with a name-matched
    test. Pure heuristic.
  Test-gap reports lead with a ⚠️ / ℹ️ banner when fidelity isn't
  `line-coverage`, so a 0% from a heuristic can't be confused with a
  0% from a real coverage run.
- **`--with-coverage` flag** on `health` and `test-gaps`. Materializes
  the coverage artifact via per-pack `runTests()` BEFORE analysis, so
  `loadCoverage()` finds it and the report reads line-coverage truth.
  Shares the same runner the `coverage` command uses.
- **`vyuh-dxkit report` orchestrator**. Single command that runs
  every analyzer + dashboard in dependency order. `--with-coverage`
  runs the coverage step ONCE upfront rather than per-command, so
  `health` and `test-gaps` share the artifact without re-running the
  test suite per analyzer.
- **Cross-ecosystem matrix coverage row × 8 packs** in
  `test/integration/cross-ecosystem.test.ts` + per-pack contract
  conformance assertions in `test/languages-contract.test.ts`. Locks
  in the round-trip from "test runner" to "coverageFidelity:
  line-coverage" across python / typescript / go / rust / csharp /
  kotlin / java / ruby.

### Added — language pack contracts

- **`LanguageSupport.upgradeCommand?(name, version)`** (G_v4_4) —
  each pack ships its own per-ecosystem package upgrade template
  (`dotnet add package`, `npm install`, `pip install`, `cargo update`,
  `go get`, edit-pom for Maven, edit-Gemfile for Bundler). Replaces
  the hardcoded switch on `tool` in `buildUpgradeCommand`
  (security/index.ts). Dispatch now routes through
  `getLanguage(packId).upgradeCommand()` — no language branching in
  non-pack code (CLAUDE.md rule 6).
- **`DepVulnFinding.packId`** stamped at every producer site
  (npm-audit / pip-audit / govulncheck / cargo-audit /
  dotnet-vulnerable / osv-scanner-deps via new `packId` parameter on
  `parseOsvScannerFindings` and `gatherOsvScannerDepVulnsResult`). The
  vuln-scan "Remediation Commands" block now ships actual runnable
  commands instead of bare `#` prose for every ecosystem.
- **`LanguageSupport.clocLanguageNames?`** (D073) — each pack
  declares the names cloc emits in its `--json` output. cloc's
  per-language summary + `totalLines` aggregation now filter to the
  active-pack set, so markup/data formats (JSON / XML / CSV /
  Markdown) stop deflating quality metrics. On the .NET WinForms benchmark: Comment
  Ratio 4.3% → 27.9% (a 1.6M JSON denominator vs C#'s 568K).

### Fixed — Tier 1 (credibility critical)

The post-shipment audit's master bug + its direct cascade:

- **D055** — `.dxkit-ignore` multi-segment paths flatten to basenames
  in cloc / graphify / grep. `app/vendor/generated/` silently
  became `{app, vendor, generated}`, so cloc then excluded every
  directory named `app` in the tree, killing 90% of source visibility.
  Fix: `getClocExcludeFlags` emits `--exclude-dir` (basenames) PLUS
  `--fullpath --not-match-d` (Perl regex on full path).
  `getPythonExcludeFilter` emits both a basename set AND a multi-
  segment path list for graphify's walker. Grep callers post-filter
  via `isExcludedPath()`.
- **D056** — Registry-driven greps (docCommentFiles, tlsBypassFindings)
  now post-filter through `isExcludedPath()`. Pre-fix the shell pipe
  only filtered hardcoded `node_modules` + `dist` — every other
  exclusion was silently ignored.
- **D057** — Cloc no longer writes `sourceFiles`. Generic.ts owns
  the source-file count; cloc owns line counts + language breakdown.
  Pre-fix `mergeLayer2` blindly overwrote generic's find-based 1537
  with cloc's broken 141. Class-fix (merger field-ownership claims,
  G_v4_8) deferred to 2.4.8.
- **D072** — Registry-greps now apply the SAME autogen filters
  (`autogeneratedSourcePatterns` basename glob + `isAutogeneratedByHeader`
  content marker) that `gatherGenericMetrics` uses for `sourceFiles`.
  Pre-D072 docCommentFiles counted designer.cs / .g.cs files in the
  numerator but not in `sourceFiles`'s denominator, producing 104%
  docRatio on the .NET WinForms benchmark even after D055.
- **D062** closure via **G_v4_4** above.

### Fixed — Tier 2 (visible UX bugs)

- **D060** — Weekly velocity fills empty weeks with 0-row entries
  between first and last week with commits. Pre-fix `W08 2, W09 1,
  W10 7, W14 1, W16 6, ...` had silent gaps that implied "data
  missing" when reality was zero commits.
- **D061** — Hot Files filters auto-generated files via the existing
  `autogeneratedSourcePatterns` registry. Pre-fix the .NET WinForms benchmark's hot
  list included `*.Designer.cs` files (WinForms designer regeneration
  noise).
- **D063** — BoM Risk column rendered to one decimal (`18.5`,
  `14.8`) in both Triage and Vulnerable Packages tables. Pre-fix
  `toFixed(0)` rounded 14.8 → 15, making it look like SharpCompress
  should appear in the ≥15 triage when it was actually 14.8 (below
  threshold).
- **D064** — BoM Reach column three-state: `✓` / `✗` / blank. Pre-
  fix blank silently merged "checked and not reachable" with "no
  data."
- **D032** — Two-part dashboard-input fix. `analyzeHealthWithMetrics`
  runs unconditionally (was gated on `--detailed`); every report
  command writes BOTH `-detailed.json` AND `-detailed.md`
  unconditionally. `--detailed` flag now only controls the
  success-log console output. Pre-fix a default `dxkit health . &&
  dxkit dashboard .` workflow showed stale tile numbers + stale tab
  content from whatever the last `--detailed` run had left behind.

### Fixed — Tier 3 (cosmetic)

- **D065** — Health "Add API documentation" recommendation no longer
  fires when `controllers === 0`. Pre-fix it triggered for any 100+
  source file repo, including desktop apps with no HTTP surface.
- **D068** — Dashboard "Critical Issues at a Glance" discloses
  "(showing N of M)" when the per-surface caps (3 vulns + 3 gaps +
  2 bom-triage) drop items. Pre-fix a customer with 20 CRITICAL
  untested files saw 3 and could reasonably infer "only 3 critical
  things in the repo."
- **D070** — BoM main report collapses the project-roots paragraph
  to a 5-root preview + count; the full list moves to the detailed
  report under a dedicated `## Project Roots (N)` section, one root
  per line for grep / sort.

### Recipe v4 status

- **G_v4_4** (per-pack `upgradeCommand`) — **delivered** (promoted
  from 2.4.8 because D062 fix was otherwise a switch-statement patch).
- Still queued for 2.4.8: G_v4_5 (per-pack
  `autogeneratedHeaderPatterns`), G_v4_6 (unified TLS bypass count +
  findings), G_v4_7 (`walkSourceFiles` unified helper, class-fix for
  D072), G_v4_8 (merger field-ownership claims, class-fix for D057),
  G_v4_inherited_G2opt2 / _G3 / _G7.

### Architecture — class lessons from the cascade

Two layering insights from D057 and D072, both with concrete class-
fix candidates queued for 2.4.8:

- **Layer ownership** — when two gather functions write the same
  field (e.g. generic.ts and cloc.ts both writing `sourceFiles`),
  the merger should reject overlap rather than last-write-wins.
  Tracked as G_v4_8.
- **Source-file definition uniformity** — every metric claiming
  "files matching X among source files" must share the predicate
  `sourceFiles` uses (exclusions + autogen-basename + autogen-header).
  Tracked as G_v4_7 (`walkSourceFiles` shared helper). Until it
  lands, every grep caller funnels through
  `isCountedSourceFile(cwd, relPath)` in `tools/generic.ts`.

## [2.4.6] - 2026-05-07

### Added — Ruby language pack (Phase 10k.2)

8th language pack, fully dynamic outside the JVM family. Stress-tests
the LP-recipe (v3) on a paradigm distinct from Java/Kotlin. Detection
is source-presence-driven (G9 — requires `.rb` files within depth 5,
not bare `Gemfile`).

All 5 capabilities wired:

- **imports** — `require` / `require_relative` / `autoload :Sym, 'path'`
  extraction. File-level resolver no-op (Ruby's `$LOAD_PATH` + Zeitwerk
  + metaprogramming make resolution fundamentally best-effort; mirrors
  rust/kotlin/csharp/java pattern). Best-effort contract documented
  in pack source.
- **testFramework** — Gemfile / Gemfile.lock substring scan with
  precedence rspec → minitest → test-unit. Glob-count fallback
  (`*_spec.rb` vs `*_test.rb` / `test_*.rb`) when no Gemfile exists.
- **coverage** — SimpleCov via `coverage/.resultset.json` (canonical)
  → `coverage/coverage.json` (simplecov-json formatter) → null.
  Multi-suite resultset handled via per-line max-union (matches
  SimpleCov's own merge semantics).
- **lint** — RuboCop `--format json`. Severity map: fatal→critical,
  error→high, warning→medium, convention/refactor→low.
- **depVulns** — osv-scanner against Gemfile.lock with `RubyGems`
  ecosystem filter. Routes through the cross-pack SSOT (see
  Architecture below). bundler-audit deliberately not used — its JSON
  is unstable upstream.

`licenses` deliberately omitted — no canonical pure-CLI license tool
for RubyGems analogous to pip-licenses.

Cross-ecosystem matrix wired with the standard 4 benchmark fixtures
(Secrets/BadLint/Duplications/UntestedModule — G4-scaffolded). New
`Ruby > osv-scanner surfaces nokogiri@1.10.0 advisories from
Gemfile.lock` benchmark added with a pinned-vulnerable Gemfile.lock
(nokogiri 1.10.0 + rack 2.0.1 + loofah 2.2.0). CI gains
`ruby/setup-ruby@v1` + `gem install rubocop`.

### Architecture

- **`gemPackage` registry probe field** — extends `ToolDefinition`
  for library-only Ruby gems (mirrors the existing `nodePackage`
  field). Probes via `gem list -i <name>`; used by SimpleCov which
  is required from `spec_helper.rb` rather than invoked as a CLI
  command. Future ecosystems with library-only tools follow the same
  pattern. Surfaced when `tools install simplecov` falsely reported
  "already installed" because the prior `binaries: ['ruby']`
  workaround couldn't distinguish "ruby present" from "simplecov
  gem installed."
- **`findInGemBin` registry probe step** — discovers Ruby gem bin
  directories dynamically via `gem env executable_directory` +
  `Gem.user_dir + "/bin"`. Memoized once per process (~150ms one-time
  cost). Handles ruby version differences (3.2.0 vs 3.3.0), install
  modes (system vs `--user-install`), and package managers (apt vs
  brew vs rbenv) with no static probePaths needed.
- **`osv-scanner-deps.ts` SSOT generalization** (renamed from
  `osv-scanner-maven.ts`). `parseOsvScannerFindings(raw, ecosystem)`
  and `gatherOsvScannerDepVulnsResult(cwd, source, ecosystem,
  manifestCandidates)` now take ecosystem + manifest candidates as
  parameters. Kotlin/Java pass `'Maven'` + Maven manifests; Ruby
  passes `'RubyGems'` + `['Gemfile.lock']`. CLAUDE.md rule #2 —
  fork-and-edit avoided. Same dedup semantics, same CVSS resolution
  path.

### Recipe v3 (final installment) — closed

- **G4** — scaffolder writes templated benchmark fixtures with
  per-language syntax tokens (PascalCase vs snake_case filenames,
  comment markers, AKIA constant placement). Saves ~30 min per new
  pack. Languages without a profile fall back to TODO stubs.
- **G6** — scaffolder appends `[Unreleased]` CHANGELOG stub on
  `npm run new-lang`. Idempotent. Forces release-notes thinking at
  scaffold time, not ship-tag day.
- **G1** — class-wide gate parser robustness audit. Auto-derived
  language lists in `check-architecture.sh` (LP-A1/A2/A3 patterns no
  longer drift as new packs land). Self-test pattern documented:
  every gate parsing TS declarations exits 1 with explicit failure
  when its parser produces an empty list. Surfaced its own bug —
  the scaffolder's `LANGUAGES` registry update produced a double
  comma under Prettier multi-line shape; fixed in the same series.

Three deferred items carried forward to v4 with explicit trigger
conditions: G2-Opt2 typed-null capability (Swift consumer), G3
BENCHMARK_LANGUAGES auto-edit (matrix > 8 packs), G7 pre-commit hook
polish (multi-gate diagnosis cost).

### Recipe v4 (working doc opened)

`tmp/recipe-v4-working-doc.md` (gitignored, ephemeral). Surfaced
during 10k.2:

- **G_v4_1** — scaffolder TEST_TEMPLATE conflates source-text vs
  tool-output parsers. Future contributors must re-derive the
  convention by reading existing packs.
- **G_v4_2** — TOOL_DEFS probe assumed CLI binary; library-only gems
  lacked detection. **DELIVERED in 10k.2.4** via the new `gemPackage`
  field.
- **G_v4_3** — SimpleCov HTML-only state currently indistinguishable
  from "tool didn't run." Outcome enum extension proposed.

Recipe-v4 is paying for itself: G_v4_2 surfaced and shipped in the
same session; G_v4_1 caught in a meta-conversation about test
discipline.

### Defects

- **D002** (Python subprocess fallback) — Ruby pack has no analog
  (osv-scanner reads Gemfile.lock directly, no `bundle env`/`bundle
  show` introspection ladder). Stays accepted-deferred.
- **D017** (NEW) — `dxkit bom <large-project> > file.json` produces
  0-byte output intermittently on a large reference repo (1700+ deps).
  EXIT=0, no error. Workaround: pipe through `cat`. Hypothesis:
  Node stdout buffer doesn't drain before process exit when output
  is large + stdout is a regular file. NOT a 2.4.6 ship blocker —
  workaround exists, intermittent, doesn't affect interactive use.
  Investigate in a follow-up commit.

### Pre-ship regression — clean

Sequential dxkit reports captured against dxkit-on-dxkit and
a large reference repo; 12 reports each diffed against the 2.4.5-fixed
baseline. Zero code regressions detected. All deltas explained:

- dxkit/test-gaps 16 → 32 — better data (Istanbul vs import-graph
  fallback in baseline).
- dxkit/vulnerabilities +3 gitleaks — expected (G4 AKIA placeholder
  strings in scaffolder source).
- platform/vulnerabilities -3 — platform-side refactor of
  user.controller.ts (not dxkit).
- BoM advisory deltas — OSV.dev upstream churn (8 days since 2.4.5
  ship).

Confidence: high. 1025 tests passing, full suite + all gates green
at every commit in the 10-commit branch.

## [2.4.5] - 2026-04-29

### Fixed (high-severity, discovered during 2.4.5 pre-ship regression)

- **`osv-scanner fix` was THREE bugs in one** (5-month-old bug shipped
  since 2.4.0 / Phase 10h.6). osv-scanner v2's `fix` subcommand invokes
  `npm install` internally to compute upgrade patches. dxkit was
  invoking it in the user's project cwd, which caused all three of the
  following:

  1. **Data mutation** — `npm install` wipes / reinstalls the cwd's
     `node_modules` (often with `--legacy-peer-deps` fallback when
     peer-deps don't resolve cleanly). Visible to users running
     back-to-back commands: `dxkit vulnerabilities` followed by `npm
     test` or any other step depending on stable `node_modules` would
     fail cryptically. Discovered when dxkit-on-dxkit crashed mid-run
     with `Cannot find module 'hosted-git-info'`.

  2. **Process orphan leak** — osv-scanner's `npm install` grandchildren
     outlived dxkit's 120s `execSync` budget. `execSync(..., {timeout})`
     SIGTERMs only the immediate child; npm install + its node-package
     subprocesses orphaned to PID 1 and kept eating CPU/memory until
     they finished or the shell exited. Each `dxkit vulnerabilities`
     invocation could leak 1-3 orphans; in CI this polluted subsequent
     steps.

  3. **Silent BoM under-reporting** — when osv-scanner's npm install
     left a partially-broken `node_modules` (peer-dep mismatches that
     `--legacy-peer-deps` couldn't fully resolve), dxkit's BoM
     aggregator subsequently couldn't enumerate the affected
     dependencies. Root-project deps got silently dropped from the
     BoM. On dxkit-on-dxkit comparison, 2.4.4 reported only 7 BoM
     entries (sub-fixture deps) vs 2.4.5's 24 (sub-fixtures + dxkit's
     own 17 root deps including `hosted-git-info`, `eslint`,
     `typescript`, etc.). `unfilteredTotalPackages` 22 → 353. The
     analyzed project's own deps were missing from BoM whenever the
     bug hit. Most repos that resolve peer-deps cleanly under
     `--legacy-peer-deps` weren't affected (the reference repo's BoM
     stayed correct at 145 packages); repos with subtle peer-dep
     issues silently lost root-dep enumeration.

  **Fix** (split across 10k.1.5b and 10k.1.5c):

  - **Temp-dir isolation (10k.1.5b)**: stage `package.json` +
    `package-lock.json` in a fresh temp dir before invoking osv-scanner,
    discard the temp dir after parsing JSON output. Project's tree is
    now read-only treatment (the contract dxkit's analyzers always
    claimed). Stops bug #1 (mutation) and #3 (BoM under-reporting,
    since `node_modules` no longer gets clobbered).

  - **Process-group SIGKILL on timeout (10k.1.5c)**: new
    `runDetached(cmd, args, opts)` helper in `src/analyzers/tools/runner.ts`
    spawns the child in its own process group via
    `spawn({ detached: true })` and `process.kill(-pid, 'SIGKILL')` on
    timeout — kills grandchildren atomically. Stops bug #2 (orphan
    leak). Reusable for any future tool that may fork grandchildren
    (PMD's JVM, mvn, gradle).

  Regression tests added: `test/osv-scanner-fix.test.ts` for the
  isolation contract; `test/runner.test.ts` for the process-group
  group-kill semantics (sleep-30-grandchild + 200ms timeout asserts
  elapsed < 2s — would block 30s if process-group regressed). Caught
  by the discipline the user pushed for: "never ship broken;
  understand the root cause and fix properly". The discipline was
  validated end-to-end — the same scan that found bug #1 also
  surfaced #2 and #3 once we knew where to look.

  **Forensic evidence preserved** at
  `tmp/regression/2.4.4/dxkit/bom.json` (gitignored — 2.4.4 baseline
  with under-reported BoM) vs `tmp/regression/2.4.5-fixed/dxkit/bom.json`
  (full enumeration after the fix).



Phase 10k.1 — Java language pack (recipe stress test #1, JVM-cousin
shape). 7th language pack lands the cross-ecosystem matrix at
**8 active language packs** including Java with full capability
coverage. Recipe v3 makes substantial progress (G2 + G5 + G9
delivered; G1 partial; G4/G6/G7 deferred). D008 + D011 + a vitest
hookTimeout flake closed in pre-flight commits.

No breaking changes for end users. New depVulns/lint/coverage/
imports/testFramework data on Java/Maven projects; existing analyzer
commands produce identical output for non-Java projects.

### Added

- **Java language pack** (Phase 10k.1) with five capability providers:
  - **depVulns** via `osv-scanner` against `pom.xml` /
    `gradle.lockfile` / `gradle/verification-metadata.xml`.
    Implementation lives in the new shared
    `src/analyzers/tools/osv-scanner-maven.ts` module that both
    kotlin and java packs delegate to (CLAUDE.md rule #2 SSOT).
  - **lint** via PMD 7.x with `rulesets/java/quickstart.xml`.
    `parsePmdOutput` tiers PMD's 1-5 priority into dxkit's
    critical/high/medium/low scheme via `mapPmdRuleSeverity`.
    Real-fixture-driven parser tests against captured PMD 7.24.0
    output at `test/fixtures/raw/java/pmd-output.json`.
  - **coverage** via JaCoCo XML — reuses the kotlin pack's parser
    unchanged (the parser was source-language-agnostic from day 1
    and is now hosted in `src/analyzers/tools/jacoco.ts`). Path
    candidates extended for Maven (`target/site/jacoco/jacoco.xml`,
    `target/site/jacoco-aggregate/jacoco.xml`) alongside the existing
    Gradle paths.
  - **imports** via regex extraction over `import [static]
    <fqn>(.<Class>|.*)?;` after stripping line + block comments.
    Best-effort resolution (matches kotlin/rust pack semantics —
    Java package paths don't 1:1 map to filesystem paths in all
    build layouts).
  - **testFramework** via build-file substring scan of pom.xml +
    build.gradle{,.kts} for canonical artifact names. Order honors
    mixed-state migration: junit-jupiter > spock > testng > junit4.
- **PMD (`pmd`) in TOOL_DEFS**. PMD 7.x as the canonical Java linter,
  with brew on macOS / GitHub releases zip on Linux / scoop on
  Windows. CI install step added.
- **Java cross-ecosystem benchmark fixture**
  (`test/fixtures/benchmarks/java/`) — five files (Secrets.java with
  fake AWS key, BadLint.java with PMD violations, Duplications.java
  with jscpd clone pair, UntestedModule.java for filename-match
  test-gap, pom.xml with `commons-collections:3.2.1` for the original
  "Mad Gadget" CVE-2015-7501 deserialization advisory + log4j-core
  for Log4Shell). Matrix wins on all four dimensions (secret/dup/
  test-gaps run unconditionally; lint matrix activates with
  `requires: 'pmd'`).
- **`scripts/check-docs-coverage.sh` (Recipe v3 / G5).** Pre-commit +
  CI gate that asserts every `LanguageId` in `src/languages/index.ts`
  appears in canonical doc anchors (CLAUDE.md path glob; README.md
  ecosystem coverage table row count + ID substring mention). Closes
  the kotlin-PR-#23 follow-up class of failure where a pack ships in
  main but docs go stale because nobody remembered to update them.
- **`vyuh-dxkit tools install <name>` and `--all` (D011).** Single-tool
  install for cross-stack development (e.g. installing `spotbugs` /
  `pmd` on a Node-only repo); `--all` enumerates every TOOL_DEFS
  entry. Unknown names fail loudly with an "Unknown tool" message +
  pointer to `tools list`. Used during this phase's PMD harvest.
- **CLAUDE.md merge-strategy guidance**. Codifies when PRs should
  squash-merge (single logical unit) vs rebase-merge (multiple
  independently-meaningful commits with prose-quality messages —
  what this PR did to preserve D008/D011/G2/G5/G9 + 5 capability
  commits as discrete history).

### Refactored (architectural improvement)

- **`src/analyzers/tools/jacoco.ts`** — extracted from kotlin pack
  in 10k.1.2. Owns `parseJaCoCoXml`, `findJaCoCoReport`,
  `gatherJaCoCoCoverageResult`. Both JVM packs delegate. Parser was
  always source-language-agnostic; just relocating to the right home.
- **`src/analyzers/tools/osv-scanner-maven.ts`** — extracted from
  kotlin pack in 10k.1.4. Same pattern. Owns
  `parseOsvScannerMavenFindings` + `gatherOsvScannerMavenDepVulnsResult`.
  Both JVM packs delegate. Parser was already ecosystem-filtered to
  Maven (not Kotlin-coupled); just relocating.
- **Capabilities contract is genuinely optional (Recipe v3 / G2).**
  `capabilities-contract.test.ts:117` previously asserted
  `providers.length === LANGUAGES.length` for the depVulns capability,
  forcing packs without depVulns to register null-stub providers.
  Now: `expect(providers.length).toBe(LANGUAGES.filter((l) =>
  l.capabilities?.depVulns).length)` — precise contract, packs can
  omit. Unblocks Swift's eventual graceful-degradation pattern.
  Java's null-stub from intermediate commits retired.
- **`detectJava` is source-presence-driven, not manifest-driven
  (Recipe v3 / G9).** Initial detection activated on bare `pom.xml`,
  which broke kotlin's matrix lint test because kotlin's fixture has
  pom.xml (for osv-scanner Maven). Both packs activated → lintTool
  came back as `'detekt, pmd'`. Fix: require either `src/main/java/`
  directory OR actual `.java` source within depth 5. Mixed Kotlin +
  Java projects still activate both packs (correct). G9 noted as a
  scaffolder-template fix candidate — the scaffolded `detect()` stub
  currently suggests "manifest signals" which is the bug we just hit.

### Fixed

- **D008 — stale test-fixture types + missing contract test.** 21 type
  errors surfaced when `tsc --noEmit` runs against `src + test`
  together (`DimensionScore.details` / `DuplicationStats.totalLines`
  field drift; `DepVulnFinding.source` → renamed to `.tool`;
  `mapLintSeverity` contract was narrower than every impl reality;
  spread-duplication cleanups). Adds `tsconfig.test.json` +
  `npm run typecheck:test` + wires into `.husky/pre-push` and
  `.github/workflows/ci.yml`. The contract test paid for itself in the
  same session — caught a `Record<LanguageId, boolean>` literal
  regression introduced 30 minutes earlier.
- **`scripts/check-cross-ecosystem-coverage.sh` Prettier robustness
  (Recipe v3 / G1, partial).** Auto-derive parser assumed single-line
  `LANGUAGES = [...]`. Prettier reformatted to multi-line at the 7th
  entry (line-length budget) and the gate parsed 0 entries silently.
  Switched to awk block extract — robust to both shapes. One
  instance fixed; class-wide audit of similar parsers deferred.
- **Vitest `hookTimeout` default of 10s caused C# `beforeAll` flakes.**
  `dotnet restore` against a cold NuGet cache routinely takes 18-44s
  on WSL2. Now matches `testTimeout` at 180s.

### Phase 10k roadmap

After 10k.1 (Java) ships in 2.4.5, **10k.2 (Ruby) ships in 2.4.6** as
recipe stress test #2 — fully dynamic language outside the JVM family.
Then **2.5.0 (Phase 10i — fingerprints + exec summary across 8-language
matrix)**. Phase 10j.2 (Swift/iOS) is **deferred to post-10rr / pre-3.0.0
opportunistic slot** because Linux/WSL2 development can't validate the
xcodeproj-shape majority without macOS access. See
`tmp/phase-10k-backend-langs-roadmap.md` for the full phase plan.

## [2.4.4] - 2026-04-27

Phase 10j.1 — first mobile language pack (Kotlin/Android), Recipe v2
scaffolder enhancements driven by lessons from adding it, and a fix
for D010 (inactive-pack provider invocation) which surfaced as a
test-suite performance regression.

No breaking changes for end users. New depVulns/lint/coverage data on
Kotlin/Maven projects; existing analyzer commands produce identical
output for non-Kotlin projects.

### Added

- **Kotlin (Android) language pack.** Full LP-recipe implementation with
  five capability providers:
  - **depVulns** via `osv-scanner` against `pom.xml` /
    `gradle.lockfile` (Maven ecosystem filtered out of polyglot scans
    so npm/PyPI findings stay attributed to their own packs).
  - **lint** via detekt's Checkstyle XML report — severity tiering
    derived from detekt's source-of-truth `CheckstyleOutputReportSpec`
    (error → high, warning → medium, info → low).
  - **coverage** via JaCoCo XML at the standard Gradle/Android paths
    (`app/build/reports/jacoco/...`, `build/reports/jacoco/test/...`).
  - **imports** via regex extraction (no resolver — Kotlin packages
    don't 1:1 map to file paths; mirrors the rust pack's choice).
  - **testFramework** via gradle build-deps text scan (Kotest > Spek >
    JUnit precedence).

  Standard cross-ecosystem benchmark fixture under
  `test/fixtures/benchmarks/kotlin/` with `gson:2.8.5` (alias
  CVE-2022-25647) + `log4j-core:2.14.0` known-vulnerable pinned
  deps. Matrix row + `cross-ecosystem benchmarks — Kotlin` describe
  block. detekt registry entry (`TOOL_DEFS`) ships brew + Linux-zip
  install commands. (`src/languages/kotlin.ts`,
  `test/languages-kotlin.test.ts`,
  `test/fixtures/{benchmarks,raw}/kotlin/`,
  `src/analyzers/tools/tool-registry.ts`)

- **CI: Java 17 (Temurin) + detekt installed on the Linux runner.**
  Kotlin matrix lint row now runs end-to-end in CI alongside Python /
  Go / Rust / C# rows. Java 17 toolchain is opt-in for contributors
  (`it.skipIf(!commandExists('java'))` gates the matrix lint test
  locally). (`.github/workflows/ci.yml`,
  `CONTRIBUTING.md` — toolchain table extended with three rows:
  `osv-scanner`, `java`, `detekt`)

- **Recipe v2 — scaffolder enhancements driven by Kotlin's pain.**
  `npm run new-lang <id> "<displayName>"` now also generates:
  - parser-test stubs in `test/languages-<id>.test.ts` with the
    fixture-loading helper, the C# defect provenance docstring, and
    commented-out test patterns for `parse<Tool>{Lint,Coverage,DepVulns}Output`,
    `map<Lang>Severity`, `extract<Lang>ImportsRaw`.
  - `test/fixtures/raw/<id>/HARVEST.md` template documenting the
    capture commands for real tool-output bytes (the parser-vs-real-output
    discipline that closes the C# defect class).
  - Richer `test/fixtures/benchmarks/<id>/README.md` with the standard
    5-file convention (manifest / BadLint / Duplications / Secrets /
    UntestedModule) and a TODO checklist.
  - Updated next-steps checklist surfaces the harvest step before
    parser implementation. (`scripts/scaffold-language.js`)

- **LP-A4 architecture rule.** Pre-commit + CI grep that catches
  hardcoded multi-language extension globs of the
  `'**/*.{ts,tsx,js,jsx,py,go,rs,cs}'` shape — the JSCPD_PATTERN bug
  that silently dropped the kotlin matrix duplication test until
  caught by the cross-ecosystem fixture run. Future regressions land
  with a clear error pointing at `LANGUAGES.flatMap(l => l.sourceExtensions)`
  as the right derivation. (`scripts/check-architecture.sh`)

### Fixed

- **D010 — inactive-pack provider invocation.** `providersFor()` now
  filters by `lang.detect(cwd)` when given a cwd (per-pack capabilities
  only; globals stay unconditional). Module-level memoization caches
  the active-pack list per cwd so 9 capability dispatches incur one
  detect-walk per pack instead of nine. Threaded through 16 analyzer
  callsites. **Intentionally NOT filtered**: the BoM's reachability
  pass in `gatherDepVulns` calls `providersFor(IMPORTS)` without a
  cwd, because the BoM aggregates findings across multiple project
  roots and reachability needs to walk every pack's source files
  regardless of outer-cwd activation. Filtering there silently
  dropped cross-language reachability and zeroed the "This Week's
  Triage" risk scoring — caught during the regression-check pass
  on dxkit's own BoM diff. Cross-ecosystem.test.ts: 444s peak →
  174s wall-clock after Recipe v2 (-228s, 51% reduction). Closes
  D010 (`tmp/known-defects.md`). (`src/languages/capabilities/index.ts`,
  `src/analyzers/{health,licenses,quality,security,tests}/...`)

- **`JSCPD_PATTERN` was hardcoded** with `'ts,tsx,js,jsx,py,go,rs,cs'`
  baked in at module load — adding a new pack required this exact
  cross-cutting edit and the kotlin matrix duplication test silently
  dropped for two commits because we forgot to add `kt`. The pattern
  now derives from `LANGUAGES.flatMap(l => l.sourceExtensions)` on
  every call. LP-A4 (above) catches future re-introductions.
  (`src/analyzers/tools/jscpd.ts`)

- **`detekt-cli` zip ships the binary as `bin/detekt-cli`, not
  `bin/detekt`** — the original `TOOL_DEFS.detekt` install command
  symlinked the wrong path and `chmod +x` errored out. Caught by the
  `vyuh-dxkit tools install` flow during real-tool harvest. Both
  binary names now declared in `binaries[]` and both symlinks created
  on Linux install. (`src/analyzers/tools/tool-registry.ts`)

### Changed

- **`DetectedStack.versions` migrated to
  `Partial<Record<LanguageId | 'node', string>>`** from the legacy
  fixed shape `{ python?, go?, node?, rust?, csharp? }`. Adding a new
  language pack no longer requires editing this field — the type
  auto-grows with `LanguageId`. The `'node'` carve-out preserves the
  legacy `NODE_VERSION` template-variable compat without forcing a
  breaking template rename (deferred to a future major).
  (`src/types.ts`)

- **`CoverageSource` union consolidated.** `src/analyzers/tests/types.ts`
  now extends `src/analyzers/tools/coverage.ts:CoverageSource` (with
  test-only `'filename-match'` / `'import-graph'` additions) instead
  of duplicating the artifact-source list. Adding a new coverage
  format means editing one place. Added `'jacoco'` for the kotlin
  pack. (`src/analyzers/tools/coverage.ts`,
  `src/analyzers/tests/types.ts`)

- **`scripts/check-cross-ecosystem-coverage.sh` auto-derives expected
  language count.** Reads `LANGUAGES.length` from
  `src/languages/index.ts` instead of a hardcoded constant. New packs
  no longer need to bump `EXPECTED_LANGUAGES` by hand.
  (`scripts/check-cross-ecosystem-coverage.sh`)

### Internal

- Tests: 849 → 895 (+46 from kotlin parser tests, cross-ecosystem
  matrix kotlin row, and indirect coverage of new pack-iterating
  consumers). Wall-clock: 122s → 174s — net +52s for kotlin's
  legitimate test work, after D010 fix recovered ~228s of
  inactive-pack overhead.

- Recipe-playbook test's synthetic id renamed from `'kotlin'` to
  `'playbook'` (a non-LanguageId placeholder that won't collide with
  any future real pack). The collision was the LP architecture's
  predicted "first real pack stress-test" — fix took five lines.

- `import-graph.test.ts` setup now writes a minimal `package.json` so
  the typescript pack's `detect()` activates — reflects post-D010
  production semantics where inactive packs' gathers don't run.

## [2.4.3] - 2026-04-26

Phase 10i.0-LP — language-pack architectural refactor. Two user-visible
fixes (graphify + dotnet auto-discovery), one developer-experience win
(test suite from 30 min flaky to 2 min deterministic), and an
architectural cleanup that makes adding a new language pack a one-command
scaffold (`npm run new-lang <id> "<displayName>"`) instead of a
13-file scavenger hunt. Closes audit items #1–#7 and #9–#14 (12 items)
plus **D009** and a doctor-check gap that had no D-id.

No breaking changes for end users. Internal architecture only — every
analyzer command (`health`, `vulnerabilities`, `bom`, etc.) produces
identical output before and after.

### Fixed

- **`graphify` "failed to run" in `health` and `quality` reports.** The
  graphifyy@0.5.0 release renamed the result-dict key of `god_nodes()`
  from `"edges"` to `"degree"` (same NetworkX node-degree semantic). The
  Python script in `buildGraphifyScript` raised `KeyError: 'edges'`,
  suppressed by the runner's `2>/dev/null`, surfacing only as
  `Unavailable: graphify (failed to run)` in every health/quality
  report — degrading complexity/cohesion/maintainability scoring
  silently. One-line key rename. (`src/analyzers/tools/graphify.ts`)

- **`~/.dotnet` missing from `getSystemPaths()` auto-discovery.**
  Microsoft's recommended non-sudo path is
  `dotnet-install.sh --install-dir $HOME/.dotnet`. Without this entry
  in the system-paths probe list, contributors and customers had to
  manually export `PATH=$HOME/.dotnet:$PATH` before dxkit detected
  dotnet. Added alongside the existing `~/.cargo/bin`, `~/go/bin`
  entries. (`src/analyzers/tools/tool-registry.ts`)

- **`vyuh-dxkit doctor` was silently skipping all C# toolchain checks.**
  The pre-LP toolchain-check section in `doctor.ts` had explicit
  branches for python/go/node/rust but **no `if (manifest.config.languages.csharp)` clause** — so .NET
  projects ran `doctor` and saw a clean bill of health regardless of
  whether dotnet was installed. Pack-driven iteration (LP.1) auto-fixes
  this: csharp pack now declares `cliBinaries: ['dotnet']` and doctor
  surfaces missing dotnet on .NET projects. No D-id (discovered + fixed
  in the same commit). (`src/doctor.ts`)

- **`cross-ecosystem.test.ts` was unusable on resource-constrained
  developer machines** — 30 min wall-clock with 15 spurious failures
  per run, blocking the progressive-regression workflow. Three root
  causes:

  1. Vitest 3.x's `pool: 'threads'` birpc channel between worker and
     main starves under heavy concurrent subprocess fan-out (this suite
     spawns ~22 network-bound child processes); workers can't ack
     `onTaskUpdate` within 60s and vitest emits `Timeout calling
     onTaskUpdate`, **failing completed-and-passing tests as a side
     effect** (vitest #8164). 13 of the 15 prior "failures" were this
     spurious RPC bug, not real assertion failures. Switched to
     `pool: 'forks'` — each test file in its own child Node process,
     no shared birpc channel.
  2. `testTimeout: 60000` was tight on cold-cache machines; both real
     non-spurious failures were `pip-audit` and `cargo-audit`
     exceeding 60s on first run. Bumped to 180s.
  3. The 22 subprocess invocations were redundant — multiple `it()`
     blocks across the file invoked the same `node dxkit <report>
     <fixture>` command. Added a per-(command, fixture) Promise-cache
     so each fixture's vulnerability/quality/test-gaps report runs
     once and is shared by all assertions; concurrent racing tests
     receive the same in-flight promise. Cuts subprocess count ~50%.

  Combined effect: full suite runs from **30 min with 15 spurious
  failures** to **2:30 with zero**. (`vitest.config.ts`,
  `test/integration/cross-ecosystem.test.ts`)

### Added

- **`npm run new-lang <id> "<displayName>"`** — language-pack
  scaffolder. Generates the 7 recipe files (pack stub, test stub,
  fixture skeleton, Claude rule file, template-config dir) and
  updates `src/types.ts` (extends `LanguageId` union) plus
  `src/languages/index.ts` (registers in `LANGUAGES`). Generated code
  is type-safe by construction — no casts. Prints a next-steps
  checklist for the work scaffolding can't automate (detect logic,
  capability providers, fixture content, CI toolchain install,
  CONTRIBUTING.md row). (`scripts/scaffold-language.js`,
  `package.json`)

- **`scripts/check-architecture.sh`** — three new pre-commit + CI
  rules enforcing pack-coupling discipline:
  - LP-A1: no hardcoded `IF_<LANG>` references outside the
    constants→generator pipeline
  - LP-A2: no direct `config.languages.<id>` lookups outside the
    registry-bridge files
  - LP-A3: no hardcoded `<lang>.md` rule-file strings outside packs
- **`test/languages-contract.test.ts`** — five new per-pack tests:
  metadata completeness (`permissions`, `cliBinaries`,
  `defaultVersion`, `projectYamlBlock`) plus the **D009 reverse-direction
  contract test** (every declared tool either invoked via TOOL_DEFS, by
  shell-command literal, by `node_modules/.bin/<binary>` path, or on
  the artifact-generating allowlist).
- **`test/recipe-playbook.test.ts`** — synthetic 6th-pack injection
  test. Defines a mock `kotlin` pack, mutates the `LANGUAGES` registry
  to include it, and asserts every pack-iterating consumer
  (generator, doctor, detect, project-yaml, constants, coverage,
  generic, grep-secrets, tool-registry) picks up its contributions.
  Empirical guarantee that the architecture is pack-driven.

- **5 new `LanguageSupport` capabilities** for pack metadata that
  consumers iterate (no per-language if-chains):
  `permissions: string[]`, `ruleFile?: string`,
  `templateFiles?: { template; output }[]`, `cliBinaries: string[]`,
  `defaultVersion: string`, `versionKey?: keyof DetectedStack['versions']`,
  `projectYamlBlock?: (ctx) => string`. Plus a coverage-parser capability
  via direct ownership: per-language parsers (Istanbul, coverage.py,
  Go cover-profile) moved out of `src/analyzers/tools/coverage.ts`
  into their respective pack modules.

### Changed

- **`DetectedStack.languages`** — refactored from a fixed-shape
  interface (`{ python, go, node, nextjs, rust, csharp }`) to
  `Record<LanguageId, boolean>`. The `nextjs` flag moves out of
  `languages` and is now exclusively the framework signal under the
  top-level `framework: 'nextjs'` field — preserved in the legacy
  `IF_NEXTJS` template variable for backwards compatibility.

  Adding a 6th language pack now extends the `LanguageId` union once
  and registers in `LANGUAGES`; **no fixed-shape interface to edit**.
  This is the missing piece that makes the LP "7-file recipe" actually
  7 files.

  Programmatic consumers of the `detect()` function should note that
  `stack.languages.node` and `stack.languages.nextjs` no longer exist;
  instead, `stack.languages.typescript` is `true` for both Node and
  Next.js projects (typescript pack matches any `package.json`), and
  `stack.framework === 'nextjs'` distinguishes Next.js. The published
  template variables `IF_NODE`, `IF_NEXTJS`, `NODE_VERSION` are
  unchanged.

- **`generator.ts`, `doctor.ts`, `detect.ts`, `coverage.ts`,
  `generic.ts`, `grep-secrets.ts`, `project-yaml.ts`, `constants.ts`,
  `tool-registry.ts`** — all per-language if-chains replaced with
  iteration over the `LANGUAGES` registry. 12 of the 14 LP-audit
  items closed across these files (the audit doc lives in `tmp/` if
  curious).

### Internal

- Phase 10i.0-LP closed audit items #1–#7, #9–#13 (the per-pack
  if-chain cluster + the medium-structural cluster).
- Phase 10f.4 closed audit item #14 (`DetectedStack.languages`
  interface refactor — the type-system surgery).
- D009 (declared-vs-used tool drift contract test) closed via the
  reverse-direction test in `languages-contract.test.ts`.

## [2.4.2] - 2026-04-25

Phase 10i.0 — cross-ecosystem matrix completion. Establishes the
"matrix layer" of `test/integration/cross-ecosystem.test.ts` — a
data-driven `BENCHMARK_LANGUAGES` table that drives uniform
per-language assertions for **every** report dimension. The 2.4.1
fixtures only validated `dxkit vulnerabilities`; this release adds
matrix coverage for **secrets, lint, duplications, and test-gaps**
across all 5 benchmark languages, plus a CI-enforced parity gate so
new feature dimensions can't ship without per-language coverage.

Closes **D016** — surfaced and fixed during 10i.0.2.

### Fixed

- **C# `dotnet-format` parser returned zero violations on every real
  .NET project** since the C# pack landed. The lint provider counted
  lines containing the substring `'Formatted'` to derive violation
  count; real `dotnet format --verify-no-changes` output uses
  `path/to/File.cs(line,col): error CODE: message [project]` — the
  string `'Formatted'` never appears. Same drift shape as 2.4.1's
  D005 C# vulnerabilities defect: parser written against synthetic
  output, never validated against real tool output. Fixed by
  matching the canonical `\): error \w+:` regex. Caught by adding
  the C# row to the new lint matrix; the row failed because the
  parser returned 0 despite exit code != 0 and visible violations
  in the output. (`src/languages/csharp.ts`, **D016**)

### Added

- **Cross-ecosystem matrix layer** (`test/integration/cross-ecosystem.test.ts`).
  New `BENCHMARK_LANGUAGES` table at the top of the file is the
  single source of truth for which languages participate and where
  each fixture's deliberate findings live. Each `describe('matrix —
  <report>')` block iterates the table to produce one uniform
  assertion per language — adding a new feature is one new
  optional field per row + one new `matrix —` describe; adding a
  6th language is one row append + one fixture dir + one CI install.
  No search-and-replace across describe blocks.

- **`matrix — secrets` (Phase 10i.0.1)** — 5 hardcoded fake AWS
  access keys (`AKIA1234567890ABCDEF` — patterned digits/letters
  that pass gitleaks' `aws-access-token` regex but fail real AWS
  validation and GitHub push protection). One per benchmark
  ecosystem. Asserts `dxkit vulnerabilities` surfaces a
  `SecretFinding` (category=secret, tool=gitleaks,
  rule=aws-access-token) for each.

- **`matrix — lint` (Phase 10i.0.2)** — 5 deliberate idiomatic
  linter violations (Python ruff F401 unused-import, Go gosimple
  S1002 bool-comparison, Rust clippy unused_variables, C#
  dotnet-format whitespace × 2). Asserts `dxkit quality` reports
  the expected linter and ≥1 lint finding. CI workflow now
  installs `ruff` (pipx), `golangci-lint` (curl install script),
  and `clippy` (rustup component) alongside the existing depVulns
  toolchains; `dotnet format` ships in the .NET 8 SDK.

- **`matrix — duplications` (Phase 10i.0.3)** — two near-identical
  helpers per fixture, sized comfortably above jscpd's
  `--min-lines 5 --min-tokens 50` defaults (initial pass had
  ~30-token bodies that fell below the threshold; widened on the
  way in). Asserts `metrics.duplication.cloneCount > 0`.

- **`matrix — test-gaps` (Phase 10i.0.4)** — one untested source
  module per fixture with no matching test file. Asserts
  `dxkit test-gaps` returns the file in `gaps[]` with
  `hasMatchingTest: false`. No coverage artifact committed —
  filename-match coverage source is the matrix's canonical
  fallback.

- **`scripts/check-cross-ecosystem-coverage.sh` parity gate**
  (Phase 10i.0.5) — parses the test file and verifies every
  (report × language) cell has BOTH metadata in
  `BENCHMARK_LANGUAGES` and a matching `matrix — <report>`
  describe. Exits non-zero with a specific cell-pointer error
  message if any are missing. Wired into both `.github/workflows/ci.yml`
  and `.husky/pre-commit` so contributors catch parity gaps locally
  before push. Documented as a 4-step recipe in the script header
  for adding a new matrix dimension.

- **`.dxkit-ignore`** at repo root excludes `test/fixtures/benchmarks/`
  from dxkit's own self-scan (`vyuh-dxkit vulnerabilities .` from
  this repo) so the deliberate fixture findings don't false-positive
  in dxkit's own report. Cross-ecosystem.test.ts is unaffected — it
  scans fixture dirs as cwd, where the repo-root `.dxkit-ignore`
  doesn't apply.

### Changed

- **Bumped `vitest` 2.1.4 → 3.2.4 and `@vitest/coverage-v8` 2.1.9 →
  3.2.4 together** (matched 3.2.4 pair, peer-deps clean). vitest 3
  introduces a hardcoded 60s `onTaskUpdate` ack timeout on the
  worker→main birpc channel (vitest-dev/vitest #8164) — a sync-
  blocked test thread (`execSync` shelling out for >60s) starves the
  channel and vitest exits non-zero with an unhandled error even when
  every test passes. Refactored `cross-ecosystem.test.ts` to use
  `util.promisify(exec)` for all shell-outs (pip-audit, govulncheck,
  dotnet restore, cargo-audit) so the runner stays responsive.

- **Default `vitest.config.ts` `testTimeout` 30s → 60s.** The
  cross-ecosystem suite shells out to network-dependent registries
  (npm/pypi/crates.io/nuget); 30s was tight enough to flake on
  slow-network days (pip-audit observed at 27-34s on the
  `requests@2.20.0` fixture). Unit tests are unaffected — they fail
  fast on assertion errors; only hangs care about the timeout.

- **`.gitignore`** adds `test/fixtures/benchmarks/**/target/` so
  cargo's build dir doesn't get committed when contributors run the
  Rust matrix locally.

- **CONTRIBUTING.md toolchain table** grows a "Matrix rows" column
  and `ruff` / `golangci-lint` / `gitleaks` rows, since each is now
  a matrix-dimension toolchain (not just a depVulns one).

## [2.4.1] - 2026-04-25

Phase 10h.6.8 — cross-ecosystem benchmark validation. Builds five
committed reference projects (`test/fixtures/benchmarks/{python,go,
rust,csharp,csharp-multi}/`) with deliberately pinned vulnerable deps
and runs `dxkit vulnerabilities` against each as a regression test.
Surfaced four real defects against the 2.4.0 non-TS code paths;
this release ships fixes for all four.

Closes **D005** (no Python/Go/Rust/C# benchmark projects), open since
Phase 10h.3.

### Fixed

- **C# pack returned zero findings on real `dotnet list package
  --vulnerable` output** since 10h.3.6. The parser read
  `pkg.advisories` + `adv.advisoryUrl`; real dotnet 8 SDK output uses
  `pkg.vulnerabilities` + `adv.advisoryurl` (lowercase). Unit tests
  passed because they used the (wrong) synthetic shape. Schema
  interfaces renamed to match real output (`DotnetAdvisory` →
  `DotnetVulnerability`); existing tests updated. **Customer impact**:
  any .NET project run through `vyuh-dxkit vulnerabilities`,
  `vyuh-dxkit bom`, or the dependencies dimension of `vyuh-dxkit
  health` was silently reporting zero dep-vulns. (`src/languages/csharp.ts`)

- **Python pack emitted duplicate findings for advisories that
  pip-audit lists per affected version range.** Same `(package,
  version, id)` triple was emitted multiple times with identical
  fingerprints. Fixed by source-side dedup in the gather function.
  Surfaced by `requests==2.20.0` in the benchmark fixture, where
  `PYSEC-2023-74` and others appeared twice. (`src/languages/python.ts`)

- **Python pack left `topLevelDep` empty on direct deps when no venv
  was installed.** A `requirements.txt`-only project had no `pip show`
  graph to walk, so even the package literally listed in
  requirements.txt got no attribution. Added `requirements.txt` parser
  fallback (`parseRequirementsTxtTopLevels`) that gives direct deps
  self-attribution (`pkg → [pkg]`) when no venv is available.
  Transitives still stay unset without a venv — that's accurate to the
  data we have. (`src/languages/python.ts`)

- **Rust pack emitted comma-separated semver ranges as
  `upgradePlan.parentVersion`** instead of a clean version. cargo-audit
  emits `versions.patched` entries like `">=1.8.4, <1.9.0"` for
  patched-version-line ranges. The previous regex stripped only the
  leading `>=`, leaving `"1.8.4, <1.9.0"` — unusable as a `cargo
  update --precise <X>` argument. New helper
  `extractMinPatchedVersion` extracts the explicit `>=` floor or falls
  back to the first semver-shaped token. Surfaced by `tokio@0.1.22`
  in the benchmark fixture. (`src/languages/rust.ts`)

### Added

- **Five committed benchmark fixtures** at `test/fixtures/benchmarks/`:
  `python/` (`requests==2.20.0`), `go/` (`gin-gonic/gin v1.6.0`),
  `rust/` (`tokio = "0.1.9"`), `csharp/` (`Newtonsoft.Json 9.0.1`),
  and `csharp-multi/` (a 2-project solution validating Phase 10h.6.7's
  D003 fix on real `dotnet restore` output rather than synthetic JSON).
  Each fixture has a `README.md` documenting expected scanner output
  and the specific defect it guards against.

- **`test/integration/cross-ecosystem.test.ts`** — runs
  `dxkit vulnerabilities` against every fixture; asserts the
  hotfix-validated behaviors (no duplicates, clean parentVersion,
  correct topLevelDep, real-shape parsing, sibling-project graph
  merge). Each ecosystem's tests `skipIf(!commandExists(...))`, so
  contributors without `cargo` / `dotnet` / `go` / `pip-audit` /
  `govulncheck` see them skip locally with a clear message; CI
  installs all four toolchains and runs the full matrix. ~150s
  end-to-end.

- **CI workflow** (`.github/workflows/ci.yml`) now installs Python +
  Go + Rust + .NET + their respective audit tools (`pip-audit`,
  `govulncheck`, `cargo-audit`) ahead of the test step. cargo-audit
  is cached across runs; the others are fast enough to install per
  job.

- **CONTRIBUTING.md — "Cross-ecosystem benchmarks" section** —
  documents toolchain requirements (none required for routine dxkit
  dev; each is needed only when modifying that language's pack),
  per-fixture regeneration steps, and the local-vs-CI run model.
  Also clarifies: prefer `npm ci` over `npm install` for development
  setup, and avoid `--legacy-peer-deps` (the lockfile resolves cleanly
  without it; the flag silently bumped vitest 2.x → 3.x in earlier
  re-orient instructions).

- **Unit tests** for the four parser helpers added/changed:
  - `parseRequirementsTxtTopLevels` (7 tests in
    `test/languages-python-depvulns.test.ts`)
  - `extractMinPatchedVersion` (5 tests in
    `test/languages-rust-depvulns.test.ts`)
  - new patched-range case for `parseCargoAuditOutput` (1 test)
  - existing C# test suite re-validated against the corrected
    `vulnerabilities` / `advisoryurl` schema

### Changed

- `.gitignore` adds `test/fixtures/benchmarks/**/obj/` and
  `test/fixtures/benchmarks/**/bin/` so .NET build artifacts don't
  get committed when contributors run `dotnet restore` locally
  for inspection.

### Notes

The benchmark suite establishes the pattern for cross-language
validation as future report types (bom, licenses, quality, test-gaps,
dev-report) are made agent-ready in Phase 10i. Per the roadmap,
Phase 10i.0 (target 2.4.2) extends these fixtures with non-dep-vuln
scenarios (one secret, one lint warning, one duplication, one
untested file per language) so each 10i.x sub-commit can assert its
feature across the full language matrix.

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
- reference-repo smoke: all 4 sheets render correctly, exec summary
  surfaces 3 ship-blockers + 9 sprint-risk findings + pm2 flagged
  copyleft-strong, `@loopback/rest` surfaces as highest-leverage upgrade
  (27 transitive advisories, worst CRITICAL).

## [2.3.1] - 2026-04-24

Patch release fixing three install-robustness issues reported on a
real reference-repo install:

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

### Validation on the polyglot reference repo

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
  the product subdirectory entirely. Side-benefit: naturally
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
  reference repo: 71/71 findings attributed across 31 vulnerable
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

- Release validated against the TypeScript reference benchmark.
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
