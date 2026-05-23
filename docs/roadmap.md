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
- [x] Nine `dxkit-*` Claude Code skills for the read, act, verify loop
- [x] Devcontainer with pinned per-stack toolchains
- [x] Optional install scripts for AI agent CLIs

## Next release: 2.7

### Graphify pair (deferred from 2.6)

- [ ] `vyuh-dxkit context <file:line>` command that returns a curated AST chunk under a token budget. Replaces "agent ingests 15k-line file" with "agent ingests 500 focused lines."
- [ ] Reachability Tier-1 for dep-vuln triage. Lifts severity based on whether customer code actually calls the vulnerable surface.

Both build on the same graphify-symbols extension foundation.

### Cross-agent reach (decision pending)

- [ ] MCP server repackaging so Codex, Cursor, Aider, and other MCP-capable agents can invoke dxkit flows via their built-in MCP support. Decision pending customer signal on non-Claude-Code agent usage.

## Future

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
