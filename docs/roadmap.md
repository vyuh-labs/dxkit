# Roadmap

What dxkit ships today and what is planned next. For per-release detail see [`CHANGELOG.md`](../CHANGELOG.md).

## Shipped

### Core engine

- [x] Local repo analysis across 8 language packs (TypeScript / JavaScript, Python, Go, Rust, C# / .NET, Java, Kotlin, Ruby)
- [x] Six-dimension deterministic scoring (Security, Code Quality, Tests, Documentation, Maintainability, Developer Experience)
- [x] Per-finding fingerprinting with git-aware identity matching
- [x] Multi-axis fingerprints (domain, location, content, semantic) with confidence-scored match reasons
- [x] Brownfield policy classifier with `tooling_drift` and `config_drift` reclassification
- [x] CVSS v4 base-score computation (FIRST reference port)

### Workflow integration

- [x] `baseline create` + `guardrail check` commands
- [x] Three baseline modes with visibility-aware defaults (`committed-full`, `committed-sanitized`, `ref-based`)
- [x] Per-finding allowlist with five typed categories and inline + file-level surfaces
- [x] Strict stale-annotation detection (`stale-allow` IdentityKind)
- [x] Git hooks (pre-push default, pre-commit opt-in)
- [x] GitHub Actions PR-gate workflow with sticky markdown comment
- [x] Post-merge baseline-refresh workflow gated on PR-check pass
- [x] CLI tools for `setup-branch-protection` and `setup-prebuild`
- [x] `vyuh-dxkit issue` CLI for GitHub-routed issue reports

### Agent integration

- [x] `AGENTS.md` (open standard, read by Claude Code, Codex, Cursor, Aider)
- [x] A suite of `dxkit-*` Claude Code skills for the read, act, verify loop
- [x] Devcontainer with pinned per-stack toolchains
- [x] Optional install scripts for AI agent CLIs

### Repo explore + graph context (2.7)

- [x] `vyuh-dxkit explore` for querying the code graph (entry-points, hot-files, communities, file, feature, api-surface)
- [x] `vyuh-dxkit context <query>` for a token-budgeted structural slice, plus a fail-open PreToolUse hook that feeds it to coding agents automatically
- [x] Interactive Graph tab in the dashboard (graphify's viewer, bundled to work offline)
- [x] `--graph-context` on vulnerabilities, test-gaps, and quality, attaching each finding's module and blast radius to the detailed report (suppressed where a language's call graph cannot be resolved, so a "no callers" reading is never mistaken for "safe to change")

### Graphify pair + agent skills (2.8)

- [x] `vyuh-dxkit context <file:line>` command that returns a curated source chunk under a token budget, centered on the requested line, plus the enclosing symbol's callers/callees and blast radius. Replaces "agent ingests 15k-line file" with "agent ingests 500 focused lines."
- [x] Package-level reachability for dep-vuln triage. Marks a finding `reachable` when its package is imported anywhere in source; the flag feeds the composite risk score. (Refinements pending — see below.)

Both build on the graph foundation that 2.7 shipped.

### Agent skills

- [x] `dxkit-feature` skill — drives net-new development the way `dxkit-action` drives fixes: orient via the code graph (`context` / `explore`) to find where a feature plugs in and what it touches, then run the analyzers + `guardrail check` on the change so the feature doesn't ship a regression. Degrades gracefully to grep + read when no graph is present; verification never depends on the graph.
- [x] `dxkit-docs` skill — generates the documentation a repo is missing: reads the Documentation dimension's gaps, orients on the real code via the graph, then writes a grounded README / docstrings / API + architecture docs and re-runs the slop check so generated prose doesn't trade Documentation score for Quality score.

## Shipped in 2.9 — Deep SAST (engine-agnostic interprocedural findings)

dxkit's bundled SAST (community semgrep) is intraprocedural: it cannot follow
taint across function boundaries, so it misses the interprocedural class of
finding — path traversal, information exposure, SSRF, injection — that a
proprietary engine like Snyk Code or an interprocedural engine like CodeQL
catches. Rather than try to out-detect those engines, 2.9 makes dxkit the
**engine-agnostic orchestration layer**: ingest any engine's findings, make
them first-class (fingerprinted, baselined, guardrailed, graph-linked), and
fix them through the agent loop — enriched with the repo's own code graph in a
way the source engine's own autofix cannot match. dxkit does not compete with
detection engines; it makes their output enforceable and fixable.

### Engine-agnostic ingestion

- [x] Normalized external-finding ingestion: one pipeline for findings from
      Snyk Code, CodeQL, Semgrep Pro, or any SARIF-emitting tool. Findings enter
      through a single normalize layer, receive identity from the canonical
      fingerprint helpers, and flow into the same aggregate → baseline → guardrail
      → report → graph-context path as native findings (no engine-specific
      branches downstream).
- [x] `vyuh-dxkit ingest` (`--from-snyk` / `--sarif <file>` / `--codeql`),
      writing a sanitized snapshot under `.dxkit/external/` that is committed so
      every developer and CI run reads it without needing an engine token.

### Snyk Code ingestion (works on the free tier)

- [x] Snyk Code reader on every plan — the REST API reads already-computed
      findings quota-free where available (Enterprise); on Free/Team plans it
      automatically falls back to `snyk code test` (one test per run). Either way
      a `SNYK_TOKEN` is added once as a CI secret and a refresh workflow commits
      the snapshot so all users benefit without a local token.

### CodeQL on-demand (open-source / GitHub Advanced Security)

- [x] CodeQL runner that builds a database and runs the per-language security
      suite on demand (CI / pre-release, not the hook path), emitting SARIF into
      the same ingestion pipeline. License-gated: free for open-source repos and
      for private repos under GitHub Advanced Security; dxkit detects repo
      visibility and prompts for consent before running on private code.

### Recipe + selection + governance

- [x] Per-pack engine declaration in `LanguageSupport` (which engines apply to
      a language, CodeQL query suite, whether a build is required) so adding a
      language or engine extends the recipe rather than branching analyzer code.
- [x] License-aware engine resolver that picks the engine from repo visibility,
      GitHub Advanced Security availability, and token presence — the same
      canonical-resolver pattern the baseline modes use.
- [x] Ingested findings linked to the code graph (`--graph-context`) so the
      agent fix loop sees blast radius and callers for an external engine's
      findings, then verifies the fix by re-running the analyzer and tests.
- [x] `dxkit-ingest` skill (token setup, pull, refresh, license guidance) and
      `dxkit-action` updated to triage and fix ingested + graph-linked findings.

Also in 2.9 — hardening that makes the guardrail actually fire on brownfield
repos: `init`/`update` declare `@vyuhlabs/dxkit` as a devDependency so hooks +
CI resolve a pinned local binary (not a stale global); `hooks activate`
restores the hook's executable bit (git silently ignores a non-executable
hook) and `doctor` verifies it; hook activation chains after an existing
`postinstall`.

## Shipped in 2.9.1–2.9.4 — governance depth + the agent loop

Follow-ups that made the ingested + native findings genuinely enforceable and
the fix loop targetable.

### Cross-tool dedup + allowlist as a real gate (2.9.1)

- [x] Cross-tool dedup — two engines flagging one weakness at one site collapse
      to a single finding (canonical-rule map + same-location CWE bridge),
      keeping the higher severity and recording every contributing tool.
- [x] The allowlist suppresses findings from the guardrail verdict (was
      audit-only), expiry-aware, with robust matching across dedup so run-to-run
      nondeterminism can't orphan an acceptance.
- [x] Inbound Snyk ignore sync — a finding dismissed upstream (SARIF
      `result.suppressions`) no longer re-surfaces; ingested findings honor the
      same `.dxkit-ignore` path exclusions as native ones.

### Allowlist lifecycle + Snyk credential ergonomics (2.9.2)

- [x] `allowlist remove <fingerprint>` and `allowlist audit --against-baseline`
      (orphaned-entry bucket, flag-for-review never auto-removed).
- [x] `allowlist export --snyk` — outbound ignore sync: writes a `.snyk` policy
      for allowlisted Snyk Code findings, round-trip stable with the inbound reader.
- [x] Opt-in `.env` loading scoped strictly to `SNYK_*` keys for
      `ingest --from-snyk` (real env / CI secret always wins).
- [x] `dxkit-allowlist` skill; skills + docs steer baseline refreshes to CI.

### Targetable fix loop + test generation (2.9.3)

- [x] Scoped fixes — `dxkit-action` burns down one category at a time
      (dependency/BOM, security, code quality, tests, docs), running the report
      that partitions that dimension and prioritizing within scope.
- [x] `dxkit-test` skill — the testing mirror of `dxkit-docs`: reads the
      blast-radius-weighted test-gaps worklist, orients via the graph, and writes
      meaningful tests that close the highest-risk gaps without coverage theater.
- [x] Test-gap blast-radius weighting — `test-gaps --graph-context` surfaces the
      most-depended-on untested files first within each tier (ordering only; the
      Tests score is unchanged).
- [x] `dxkit-pr` skill — opens a PR with a diff-grounded title + body (features,
      fixes, findings closed), the dxkit guardrail/allowlist/score signals, and a
      tailored reviewer checklist. `dxkit-feature` now offers to write tests for a
      new surface (user-confirmed) and hands off to `dxkit-test`.

### Connecting findings + PRs to people (2.9.4)

Both grounded on a new active-owner model (`src/analyzers/developer/ownership.ts`):
recency-weighted git history, bots + departed contributors filtered, the change
author excluded, a bus-factor signal. Renders names + GitHub @handles, never emails.

- [x] **`vyuh-dxkit reviewers`** — suggests reviewers for a change from the
      active-owner model blended with `CODEOWNERS`, with a bus-factor warning and
      an inactive-owner fallback. Consumed by `dxkit-pr`. Beats naive last-touch
      blame by being activity-weighted + active-only.
- [x] **`--attribute` "who to ask"** on the detailed vulnerability / test-gaps /
      quality reports — line-level findings are git-blamed and routed through the
      owner model (inactive author → current owner); file-level findings (test
      gaps) attribute to the file's current owner. Opt-in; net-new findings need no
      blame (the introducer is the PR author). Honesty: blame is last-touch.

## Next release — Reachability refinements (carried from 2.8)

- [ ] Per-ecosystem reliability gating: only mark a finding `reachable: false` when its language pack resolves imports reliably (TS / Python / Go). For packs whose import resolution is unreliable (C# namespaces ≠ package names, etc.), leave `reachable` unset rather than risk a false "unreachable" that hides a real vuln.
- [ ] Reachable-first report framing: a `"N reachable / M total"` summary line and reachable-first sort in the vulnerability report (the per-finding `reachable` glyph already renders). _Considered for 2.9.3 and deferred: the dependency table already discounts unreachable advisories 0.25× inside the composite `riskScore`, so this is a presentation refinement (a hard reachable-first sort tier + the summary lens) rather than new signal._

## In progress — Correctness floor (loop-safety liveness gate, 2.23.0)

The guardrail proves "no net-new findings" (secrets, CVEs, SAST, coverage). It
does not prove the code still **compiles and its affected tests still pass**, so
an autonomous agent loop can satisfy the finding gate while shipping code that
does not build. The correctness floor closes that gap: a liveness check that runs
before an agent may declare "done", blocking only on failures that are net-new
versus an entry snapshot of the already-broken set (a pre-existing failure never
blocks, and there is no baseline artifact to maintain).

- [x] Pack-declared, runner-executed contract (`LanguageSupport.correctness`,
      required field): each pack builds a `syntaxCheck` and an `affectedTests`
      command; the runner owns the fail-closed-on-real-failure /
      fail-open-on-infrastructure (missing toolchain, timeout) policy in one
      place. No per-language command is hardcoded outside the pack (Rule 6).
- [x] All 8 packs shipped and verified against real toolchains, at the affected
      granularity each ecosystem supports: TS/JS and Python fine-grained;
      Go package; Rust crate; C# project; Java and Kotlin build-module (one
      shared Maven/Gradle provider); Ruby file-level compile + CI-full.
- [x] Loop Stop-gate wired (entry-snapshot diff, affected scope, default-on) with
      a per-command wall-clock budget so a slow suite degrades to a skip, not a
      block.
- [ ] Adaptive surface resolver for the CI and pre-push surfaces (default-on
      unless a test-CI is already detected; fail toward on when uncertain).
- [ ] Pre-push (merge-base) and CI (full-scope) floor wiring.

### Uninstall / clean removal (pre-3.0)

- [ ] `vyuh-dxkit uninstall` + a `dxkit-uninstall` skill that non-intrusively
      removes the full dxkit footprint (`.dxkit/`, installed skills and hooks,
      the git pre-push guardrail, the CI workflow, and the additive blocks dxkit
      merged into `settings.json` / `CLAUDE.md` / `.gitignore`) by reversing each
      installer, never a blanket wipe and never touching user code. Dry-run by
      default with confirmation; deletes only dxkit-authored files. On removal it
      offers to open a prefilled GitHub issue for feedback via the existing
      `vyuh-dxkit issue` path, so nothing is ever sent without the user's action.

## Future

### Cross-agent reach (decision pending)

- [ ] MCP server repackaging so Codex, Cursor, Aider, and other MCP-capable agents can invoke dxkit flows via their built-in MCP support. Decision pending customer signal on non-Claude-Code agent usage.

### Per-pack capability parity

- [ ] Import-graph resolvers for Rust, C#, Kotlin, Java, Ruby. Currently TS, Python, and Go have full reachability and import-graph test-gap credit. The other packs use the fallback path.
- [ ] Severity-tiered C# linter (Roslyn analyzers or StyleCop)
- [ ] License providers for Kotlin, Java, Ruby

### Scaling

- [ ] Scoped + incremental scanning for fast pre-commit on monorepos
- [ ] Symbol-level coverage gaps across all 8 packs
- [ ] SARIF export for GitHub code-scanning interop

### Deep SAST reachability (interprocedural)

Today `reachable` is a **dependency** concept only — "is the vulnerable package
imported in source." Code/SAST findings carry no reachability signal, and that's
a deliberate gap, not an oversight:

- dxkit's bundled SAST is community **semgrep (intraprocedural)** — it cannot do
  the interprocedural taint analysis that "is this vulnerable code path reachable
  from an attacker-controlled entry point" requires.
- dxkit's own **graphify call graph is too sparse for taint** today (~28%
  method-edge resolution measured during the Snyk-parity investigation).

Code-path reachability is high value — it's the primary false-positive-noise
reducer the premium engines (Snyk Code, CodeQL dataflow, Endor) compete on. The
realistic path for dxkit is therefore **to surface the reachability the INGESTED
engine already computed** (Snyk Code / CodeQL encode it), not to compute our own:

- [ ] Carry an ingested finding's engine-reported reachability through
      `src/ingest/` → `SecurityFinding`, and render/sort code findings reachable-first
      when the source engine provides it.
- [ ] (Longer term) Densify the graphify call graph enough to attempt native
      intraprocedural→interprocedural reachability; gated on call-graph quality.

### Attribution + reviewer recommendation — remaining

The core shipped in 2.9.4 (see Shipped above). Deferred follow-ons:

- [ ] **GitHub API handle resolution.** Today @handles resolve offline from
      `…@users.noreply.github.com` emails; a real-email author has no handle.
      Optionally resolve commit→login via the GitHub API where `gh` is
      authenticated (network, opt-in) to fill the gap.
- [ ] **Blast-radius ownership blend in `reviewers`.** Expand the candidate set
      to owners of the touched files' dependents (the graph knows the callers),
      not just the touched files themselves — a change's reviewers include the
      people whose code it could break.

### AI readiness

- [ ] Semantic anchors and function-body hashes for cross-file refactor detection
- [ ] AI Readiness banner that scores the agent-readiness of a codebase (deferred to 3.0)

## How to influence the roadmap

- File a feature request via `npx vyuh-dxkit issue --type=feature-request --about="..."`. The CLI pre-fills a GitHub Issue you review and submit.
- Open a discussion on the [vyuh-labs/dxkit](https://github.com/vyuh-labs/dxkit) repo for design conversations.
