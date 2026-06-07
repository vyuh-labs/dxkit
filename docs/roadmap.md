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
- [x] Twelve `dxkit-*` Claude Code skills for the read, act, verify loop
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

## Next release: 2.9 — Deep SAST (engine-agnostic interprocedural findings)

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

- [ ] Normalized external-finding ingestion: one pipeline for findings from
      Snyk Code, CodeQL, Semgrep Pro, or any SARIF-emitting tool. Findings enter
      through a single normalize layer, receive identity from the canonical
      fingerprint helpers, and flow into the same aggregate → baseline → guardrail
      → report → graph-context path as native findings (no engine-specific
      branches downstream).
- [ ] `vyuh-dxkit ingest` (`--from-snyk` / `--sarif <file>` / `--codeql`),
      writing a sanitized snapshot under `.dxkit/external/` that is committed so
      every developer and CI run reads it without needing an engine token.

### Snyk Code ingestion (works on the free tier)

- [ ] Snyk REST API reader — pulls a project's already-computed Code findings
      using a `SNYK_TOKEN`, consuming no Snyk test quota (it reads stored results,
      it does not re-scan). An admin adds the token once as a CI secret; a refresh
      workflow commits the snapshot so all users benefit without a local token.

### CodeQL on-demand (open-source / GitHub Advanced Security)

- [ ] CodeQL runner that builds a database and runs the per-language security
      suite on demand (CI / pre-release, not the hook path), emitting SARIF into
      the same ingestion pipeline. License-gated: free for open-source repos and
      for private repos under GitHub Advanced Security; dxkit detects repo
      visibility and prompts for consent before running on private code.

### Recipe + selection + governance

- [ ] Per-pack engine declaration in `LanguageSupport` (which engines apply to
      a language, CodeQL query suite, whether a build is required) so adding a
      language or engine extends the recipe rather than branching analyzer code.
- [ ] License-aware engine resolver that picks the engine from repo visibility,
      GitHub Advanced Security availability, and token presence — the same
      canonical-resolver pattern the baseline modes use.
- [ ] Ingested findings linked to the code graph (`--graph-context`) so the
      agent fix loop sees blast radius and callers for an external engine's
      findings, then verifies the fix by re-running the analyzer and tests.
- [ ] `dxkit-ingest` skill (token setup, pull, refresh, license guidance) and
      `dxkit-action` updated to triage and fix ingested + graph-linked findings.

### Reachability refinements (carried from 2.8)

- [ ] Per-ecosystem reliability gating: only mark a finding `reachable: false` when its language pack resolves imports reliably (TS / Python / Go). For packs whose import resolution is unreliable (C# namespaces ≠ package names, etc.), leave `reachable` unset rather than risk a false "unreachable" that hides a real vuln.
- [ ] Reachable-first report framing: a `"N reachable / M total"` summary line and reachable-first sort in the vulnerability report (the per-finding `reachable` glyph already renders).

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

### AI readiness

- [ ] Semantic anchors and function-body hashes for cross-file refactor detection
- [ ] AI Readiness banner that scores the agent-readiness of a codebase (deferred to 3.0)

## How to influence the roadmap

- File a feature request via `npx vyuh-dxkit issue --type=feature-request --about="..."`. The CLI pre-fills a GitHub Issue you review and submit.
- Open a discussion on the [vyuh-labs/dxkit](https://github.com/vyuh-labs/dxkit) repo for design conversations.
