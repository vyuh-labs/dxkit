# dxkit

**AI-native developer experience toolkit for any codebase.**

Make your existing codebase safe for Claude Code, Codex, and other AI
coding agents. Equip the agent with repo-native context. Guard every
commit and PR with deterministic checks. **One command scaffolds the
agent DX; one baseline turns on the guardrails.** Works across major
language stacks, greenfield or brownfield.

```bash
npm init @vyuhlabs/dxkit
```

<p>
  <a href="https://www.npmjs.com/package/@vyuhlabs/dxkit">
    <img alt="npm version" src="https://img.shields.io/npm/v/@vyuhlabs/dxkit">
  </a>
  <img alt="license" src="https://img.shields.io/github/license/vyuh-labs/dxkit">
  <img alt="deterministic" src="https://img.shields.io/badge/scoring-deterministic-blue">
  <img alt="local-first" src="https://img.shields.io/badge/local-first-green">
  <img alt="brownfield" src="https://img.shields.io/badge/brownfield-baseline%20guardrails-orange">
  <img alt="agentic" src="https://img.shields.io/badge/agentic-ready-purple">
</p>

---

## The problem

AI coding agents are powerful, but shipping their work safely is hard:

- The agent's environment isn't reproducible — different machine,
  different result.
- The agent has no project-specific context — your conventions are
  tribal knowledge it can't access.
- Strict gates assume a clean codebase. Real codebases have years of
  debt, and absolute gates either get disabled or block every PR.
- Most "AI code review" tools rely on another LLM to grade the work —
  non-deterministic, gameable, and a black box.
- Bad agent changes silently land because the only enforcement is
  human attention.

dxkit closes that loop end-to-end, deterministically, with no LLM in
the grading path.

---

## What `npm init @vyuhlabs/dxkit` creates

```bash
npm init @vyuhlabs/dxkit
```

This collapses install + scaffold into a single command: it installs
`@vyuhlabs/dxkit` as a devDep and runs `vyuh-dxkit init --full --yes`.
The full install lands a coordinated set of pieces:

```text
.devcontainer/        Reproducible environment — per-stack pinned
                      toolchains (only the languages your project
                      uses), dxkit's scanner toolchain auto-installed,
                      install scripts for AI agent CLIs (auth stays
                      user-owned).
.githooks/            pre-push guardrail hook (pre-commit opt-in via
                      --with-precommit-hook). Postinstall auto-
                      activates `core.hooksPath` so teammates who
                      clone + `npm install` get hooks wired too.
.github/workflows/    PR-gate workflow + post-merge baseline-refresh
                      workflow (refresh runs only after the PR-gate
                      passes — see "Safety + trust" below).
AGENTS.md             Open-standard project context file read by
                      Claude Code, Codex, Cursor, Aider, and any
                      AGENTS.md-compliant agent.
CLAUDE.md             Claude Code shim that points at AGENTS.md.
.claude/skills/       Nine dxkit-* skills covering the full lifecycle:
                      learn / init / config / hooks / reports /
                      action / fix / update / onboard. Claude Code
                      auto-discovers via skill frontmatter.
.dxkit/               reports, baselines, and (optional) policy.
.vyuh-dxkit.json      install manifest.
```

After install:

```bash
vyuh-dxkit baseline create            # capture today's state
git add .dxkit/baselines/main.json .githooks .github/workflows/dxkit-*.yml
git commit -m "chore: enable dxkit guardrails"
```

From this point:

- Every push runs the full guardrail check (pre-commit hook is
  opt-in via `--with-precommit-hook` — slow on large repos until
  scoped incremental scanning lands).
- Every PR is gated by GitHub Actions, which posts a markdown summary
  as a comment.
- After the PR-gate workflow passes and the PR merges, the baseline
  is refreshed so the next PR is gated against the up-to-date state.

Bypass + disable mechanisms:

```bash
DXKIT_SKIP_HOOKS=1 git push ...      # one-off bypass
git push --no-verify ...             # standard git bypass
git config --unset core.hooksPath    # disable all dxkit hooks (per-clone)
rm .githooks/pre-commit              # disable just pre-commit (keep pre-push)
```

> **Additive by default.** Existing hooks, devcontainer, or workflows
> are never destroyed. dxkit detects them and writes sidecar `.dxkit`
> files with merge instructions. `--force` overrides if you want.

---

## 60-second demo

```text
$ npm init @vyuhlabs/dxkit
✓ Created: 11 files (AGENTS.md, CLAUDE.md, .claude/skills/dxkit-*, ...)
✓ Git hooks: installed 1 file(s)
✓ Devcontainer: installed 3 file(s)
✓ CI guardrails workflow: installed 1 file(s)
✓ CI baseline-refresh workflow: installed 1 file(s)

$ vyuh-dxkit baseline create
✓ Wrote .dxkit/baselines/main.json — 89 findings (32s)
```

Your AI agent has access to dxkit's reports and the nine lifecycle
skills that init scaffolded. A typical request to the agent:

```text
Read the latest dxkit health report. Pick one safe quality
improvement. Apply the change. Then run `vyuh-dxkit guardrail check`
to confirm nothing regressed. Show me what you did.
```

The agent introduces a change that breaks the guardrail:

```text
$ vyuh-dxkit guardrail check
Guardrail BLOCKED — 2 new regressions

Baseline:    .dxkit/baselines/main.json  (89 findings)
Current:     91 findings · matcher: git-aware

Blocking (2)
  ADDED [medium] large-file   src/regression.ts
       no-prior-match: identity fingerprint not present in the baseline
  ADDED [medium] test-gap     src/regression.ts
       no-prior-match: identity fingerprint not present in the baseline

Summary
  Pairs:    91 (blocking: 2, warning: 0, persisted: 89, resolved: 0)
  Verdict:  BLOCKED
  Exit:     1
```

The agent reads the failure, fixes it, and re-runs:

```text
$ vyuh-dxkit guardrail check
Guardrail PASSED — 0 new regressions

Summary
  Pairs:    89 (blocking: 0, warning: 0, persisted: 89, resolved: 0)
  Verdict:  PASSED
  Exit:     0
```

---

## Quickstart

```bash
# Canonical first install — collapses install + scaffold into one step
npm init @vyuhlabs/dxkit

# Or install dxkit globally + scaffold manually
npm install -g @vyuhlabs/dxkit
vyuh-dxkit init --full
vyuh-dxkit baseline create
vyuh-dxkit guardrail check --changed-only

# Upgrade an existing install later
vyuh-dxkit upgrade           # plan + execute combined
```

À la carte if you only want specific pieces:

```bash
vyuh-dxkit init --with-dxkit-agents       # just the nine dxkit-* skills + AGENTS.md
vyuh-dxkit init --with-hooks              # just the pre-push hook
vyuh-dxkit init --with-precommit-hook     # add the pre-commit hook (opt-in; slow on large repos)
vyuh-dxkit init --with-devcontainer       # just the per-stack devcontainer
vyuh-dxkit init --with-ci                 # just the PR-gate workflow
vyuh-dxkit init --with-baseline-refresh   # just the auto-refresh
vyuh-dxkit init --with-pr-review          # AI PR-review workflow (opt-in, needs API key)
```

Post-install, two more CLIs polish the safety surface:

```bash
vyuh-dxkit setup-branch-protection   # mark dxkit-guardrails as required check on default branch
vyuh-dxkit setup-prebuild            # configure Codespaces prebuild (cold-start ~7 min → ~30s)
```

---

## Baseline mode: greenfield to 10-year-old codebases

Real codebases are messy. dxkit doesn't ask whether your repo is
perfect — it asks whether each change made it worse.

|                  | **Greenfield day 1**                   | **Brownfield (years of debt)**                            |
| ---------------- | -------------------------------------- | --------------------------------------------------------- |
| Baseline         | Captured near zero                     | Captures today's debt as the floor                        |
| Behavior         | Every regression matters from commit 1 | Existing debt is grandfathered; net-new regressions block |
| Cleanup pressure | Stay clean, easily                     | Improve incrementally; no required cleanup sprint         |

The classifier distinguishes:

| Status              | Meaning                                   | Default    |
| ------------------- | ----------------------------------------- | ---------- |
| `added`             | Net-new finding introduced by this change | **blocks** |
| `relocated`         | Same finding, moved (line drift, rename)  | passes     |
| `persisted`         | Same finding, same place — pre-existing   | passes     |
| `removed` / `fixed` | Was there, now gone                       | passes     |
| `tooling_drift`     | New only because scanner version changed  | warns      |
| `config_drift`      | New only because dxkit config changed     | warns      |
| `uncertain`         | Below confidence threshold                | warns      |

Customize via [`.dxkit/policy.json`](docs/configuration/policy.md) —
auto-discovered when present, compiled-in defaults otherwise.

---

## Git-aware identity matching

A regression check is only useful if the matcher can tell _old issue
that moved_ from _new issue that appeared_. Line numbers alone aren't
stable — add a 20-line comment block at the top of a file and every
issue below it "moves."

dxkit uses layered identity, in priority order:

1. **Domain fingerprints** for entities whose identity is intrinsic:
   - dependency vulnerabilities → `(package, version, advisory-id)`
   - secrets → `(scanner-rule, fingerprint(value))` so a leaked
     token recognises itself when moved
   - licenses → `(package, version, license-type)`
   - duplicate blocks → normalized content hash
2. **Location fingerprints** with a 3-line bucket for code findings.
3. **Git-aware line mapping** across commits, including `-M` file
   renames and ±2 line fuzz windows.
4. **Content-hash fallback** when git history isn't reachable
   (shallow clones, archived snapshots).

Every match pair carries a **confidence in [0, 1]** and structured
**reasons** (`exact-id`, `git-line-exact`, `git-line-fuzz`,
`git-rename`, `content-hash`, ...). No LLM in the grading path —
the matcher and classifier are deterministic over normalized
analyzer input; the same inputs produce the same classifications.

---

## Reproducible environment

Agents need a stable environment to be reliable. `init --with-devcontainer`
generates a Codespaces-ready setup:

- Pinned language toolchains (Node 22, Python 3.12, Go 1.21, .NET 8,
  Ruby 3.3, Java 17, Rust stable) layered via standard devcontainer
  features — small image footprint, fast Codespaces prebuild.
- `post-create.sh` runs `vyuh-dxkit tools install --yes` to provision
  the scanner toolchain pinned in dxkit's registry (gitleaks, semgrep,
  cloc, jscpd, ruff, osv-scanner, and more — language-aware, only the
  ones your stack needs).
- Install scripts for the AI coding-agent CLIs you want available
  inside the container. The scripts only install the binaries — auth
  remains user-owned and is never baked into the image.
- Every piece is a regular script you can edit after install.

---

## What dxkit analyzes

Beyond the baseline + guardrail surface, dxkit ships deterministic
analyzers across eight language packs (Python, TypeScript, Go, Rust,
C#, Kotlin, Java, Ruby), with graceful degradation when a tool isn't
available for your stack:

| Command           | Question it answers                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- |
| `health`          | "What's the overall shape of this codebase?" — 6-dimension score                      |
| `vulnerabilities` | "What security issues are there?" — secrets, SAST, dependency audit, EPSS/KEV context |
| `test-gaps`       | "Which untested files are riskiest?"                                                  |
| `quality`         | "Where's the technical debt + duplication?"                                           |
| `bom`             | "Full dependency × license × CVE × upgrade view" (license columns: 5 packs today)     |
| `licenses`        | "What licenses are in my dependency tree?" (TS, Python, Go, Rust, C# today)           |
| `dev-report`      | "Who's working on what, where are the hot files?"                                     |
| `dashboard`       | "Single HTML view of everything I've run"                                             |
| `report`          | Run every analyzer + dashboard in one shot                                            |

Composable aggregate gates apply to every analyzer:

```bash
vyuh-dxkit health           --fail-on-score 60
vyuh-dxkit vulnerabilities  --fail-on-severity high
vyuh-dxkit bom              --fail-on-severity critical
```

Every `--json` output carries a `schema: 'dxkit.<kind>-report.v1'`
banner so consumers can version-gate.

<details>
<summary><strong>Per-pack capabilities</strong> (click to expand)</summary>

| Language | Detection                             | Coverage import     | Import-graph                                 | Native tools                        | Lint severity tiers    | Vuln severity tiers                           |
| -------- | ------------------------------------- | ------------------- | -------------------------------------------- | ----------------------------------- | ---------------------- | --------------------------------------------- |
| TS / JS  | `package.json`                        | ✅ Istanbul         | ✅ import/require/re-export                  | eslint, npm audit, vitest-coverage  | ✅ ESLint rule ID      | ✅ npm audit native                           |
| Python   | `pyproject.toml`, `setup.py`, `*.py`  | ✅ coverage.py      | ✅ import/from                               | ruff, pip-audit, coverage           | ✅ ruff code prefix    | ✅ pip-audit + OSV.dev (CVSS v3+v4)           |
| Go       | `go.mod`                              | ✅ coverprofile     | ✅ import blocks                             | golangci-lint, govulncheck          | ✅ `FromLinter` family | ✅ govulncheck embedded + OSV.dev             |
| Rust     | `Cargo.toml`                          | ✅ lcov + cobertura | ⚠️ use statements, extracted only¹           | clippy, cargo-audit, cargo-llvm-cov | ✅ clippy group        | ✅ cargo-audit native                         |
| C#       | `*.csproj`, `*.sln`                   | ✅ cobertura XML    | ⚠️ using declarations, extracted only¹       | dotnet-format (formatter)           | ⚠️ format-only²        | ✅ dotnet list --vulnerable                   |
| Kotlin   | gradle/`*.gradle{.kts,}`, `*.kt`      | ✅ JaCoCo XML       | ⚠️ import statements, extracted only¹        | detekt, osv-scanner (Maven)         | ✅ detekt severity     | ✅ osv-scanner + OSV.dev (Maven)              |
| Java     | `pom.xml`, `src/main/java/`, `*.java` | ✅ JaCoCo XML       | ⚠️ import statements, extracted only¹        | PMD, osv-scanner (Maven)            | ✅ PMD priority tiers  | ✅ osv-scanner + OSV.dev (Maven)              |
| Ruby     | `*.rb`                                | ✅ SimpleCov JSON   | ⚠️ require/require_relative, extracted only¹ | rubocop, bundler-audit, osv-scanner | ✅ rubocop severity    | ✅ bundler-audit + osv-scanner (Gemfile.lock) |

¹ Rust, C#, Kotlin, Java, and Ruby populate `imports.extracted` but the
file-level resolver is a no-op. Downstream analyses that need an edge graph
(reachability, import-graph test-gap credit) degrade to conservative
defaults for those packs; resolvers are tracked on the roadmap.

² C# uses `dotnet-format` for formatting violations only. A real severity-
tiered C# linter (Roslyn analyzers / StyleCop) is roadmap; today every
C# formatting violation is counted at `low` tier so it doesn't inflate
the Quality/Slop score.

</details>

---

## Why dxkit

dxkit doesn't try to replace SonarQube, Snyk, Semgrep, GitHub
Advanced Security, Trivy, Gitleaks, or OSV-Scanner. It does three
things they don't:

1. **It scaffolds your AI agent.** Most tools find issues; dxkit
   _also_ writes the project-context layer (entry-point doc, project
   skills, commands, language-specific rules, specialized subagents)
   that lets your agent operate on the codebase intelligently.
2. **It gates at commit time, deterministically.** No LLM in the
   grading path. The matcher and classifier are deterministic over
   normalized analyzer input.
3. **It assumes your repo is messy.** Other tools want clean
   codebases and block every PR until you fix everything. dxkit
   captures the floor, grandfathers existing debt, and only blocks
   regressions introduced from here forward — usable on day-one
   greenfield and 10-year-old brownfield codebases alike.

Built on **open methodology**: ISO/IEC 25010, ISO/IEC 5055, SQALE,
CVSS v4 (FIRST reference port), CWE taxonomy, OpenSSF Scorecard.
Scores are evidence-backed and traceable to the findings that
produced them.

---

## Real-world validation

The 2.5.0 release was pre-ship audited on three production codebases:

- TypeScript backend
- TypeScript frontend
- Large .NET WinForms project

Across **6,919 baseline findings**, the audit:

- identified four drift classes between aggregate reports and
  per-finding identity sets
- brought roughly **3,000 previously untracked findings into
  guardrail coverage**
- matched identity-set counts exactly to report aggregates for
  every finding kind

Details in [`CHANGELOG.md`](CHANGELOG.md#250---2026-05-18).

---

## Safety + trust

dxkit is local-first.

- **No SaaS required.** Your code never leaves the machine.
- **No repo upload.** Analyzers run in-process or shell out to
  locally-installed scanners; results stay on disk.
- **Secret values are never written to disk.** dxkit stores a
  non-reversible fingerprint for matching only — the scanner sees
  the value once and discards it after hashing.
- **Agent auth stays user-owned.** Install scripts ship the CLIs;
  authentication happens in your session and is never baked into
  the image or stored by dxkit.
- **CI guardrails are the enforcement layer.** Local hooks provide
  fast feedback but are bypassable (`git commit --no-verify`); the
  GitHub Actions PR-gate runs server-side and can be made a required
  check via branch protection.
- **Post-merge baseline refresh is gated.** The refresh workflow
  runs only after the PR-gate workflow succeeds on the merging
  commit. **Use branch protection to make the PR-gate a required
  check** so a bypassed merge can't codify a regression into the
  baseline.

---

## Docs

- [Getting started](docs/getting-started.md)
- [`baseline` command](docs/commands/baseline.md)
- [`guardrail` command](docs/commands/guardrail.md)
- [`.dxkit/policy.json` configuration](docs/configuration/policy.md)
- [Scoring methodology](docs/SCORING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [All commands](docs/README.md)

---

## Roadmap

- [x] Local repo analysis (8 language packs)
- [x] Agent project scaffolding (entry-point doc, skills, commands,
      conventions, specialized subagents — single-agent today)
- [x] Optional install scripts for AI coding-agent CLIs in the
      devcontainer
- [x] Per-finding fingerprinting + git-aware matching
- [x] Baseline + guardrail commands
- [x] Brownfield policy classifier
- [x] Git hooks (pre-push default; pre-commit opt-in)
- [x] GitHub Actions PR-gate + gated baseline-refresh workflows
- [x] Devcontainer with pinned toolchains
- [x] Nine dxkit-\* skills + AGENTS.md (open-standard, read by every
      AGENTS.md-compliant agent — Claude Code, Codex, Cursor, Aider)
- [ ] First-class plugin packaging for the Claude Code marketplace + MCP server for cross-agent reach (2.6, decision-pending)
- [ ] Scoped + incremental scanning — fast pre-commit on monorepos
      (2.6)
- [ ] Symbol-level coverage gaps across all 8 packs (2.6)
- [ ] SARIF export for GitHub code scanning interop (2.6)
- [ ] Reachability-aware dep-vuln triage
- [ ] **Per-pack capability parity** — bring every cell in the
      capability table to a green tick (2.7 / 3.0):
  - Import-graph resolvers for Rust, C#, Kotlin, Java, Ruby
    (so reachability + import-graph test-gap credit work for
    every pack, not just TS/Python/Go)
  - Severity-tiered C# linter (Roslyn analyzers or StyleCop)
  - License providers for Kotlin, Java, Ruby
- [ ] AI Readiness banner — semantic anchors, function-body hashes,
      cross-file refactor detection (3.0)

---

## Contributing

dxkit aims to be the standard agentic-development layer for any
codebase. We'd love help with:

- Additional language pack support
- Agent-CLI integrations (the 2.6 work)
- Monorepo detection
- Devcontainer templates per stack
- Custom guardrail policies
- SARIF output
- More specialized subagents

Start with the [contributing guide](CONTRIBUTING.md) and
[good first issues](https://github.com/vyuh-labs/dxkit/labels/good%20first%20issue).

---

## License

MIT. See [LICENSE](LICENSE).

---

## Try it

```bash
npm init @vyuhlabs/dxkit
```

If dxkit helps you ship AI-assisted changes more safely, star the
repo — it helps others find it too.
