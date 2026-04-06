# @vyuhlabs/dxkit

AI-native developer experience toolkit for any repository. Adds Claude Code agents, skills, commands, and quality hooks to existing projects in seconds.

## Quick Start

```bash
# Auto-detect your stack and set up everything
npx @vyuhlabs/dxkit init --detect

# Interactive mode (prompts for config)
npx @vyuhlabs/dxkit init

# Full mode (DX + quality + hooks + CI)
npx @vyuhlabs/dxkit init --full --yes
```

## What It Does

Running `init` auto-detects your tech stack and generates a complete `.claude/` directory with:

```
.claude/
  settings.json          # Permissions, deny list, learning hooks
  agents/                # Active agents (auto-trigger on matching questions)
    knowledge-bot.md     # Answers codebase questions
    onboarding.md        # Interactive onboarding buddy
    quality-reviewer.md  # Reviews code before committing
    doc-writer.md        # Audits and writes documentation
  agents-available/      # Dormant agents (activate with /enable-agent)
    codebase-explorer.md # Deep architecture analysis
    code-reviewer.md     # PR review and security audit
    test-writer.md       # Writes tests for existing code
    test-gap-finder.md   # Identifies untested critical code
    dependency-mapper.md # Maps import chains and blast radius
    health-auditor.md    # 6-dimension codebase health audit
    vulnerability-scanner.md # CWE-classified security scan (Snyk-comparable)
    dev-report.md        # Developer activity + quality attribution
    dashboard-builder.md # HTML dashboard from all reports
    hooks-configurator.md # Git hooks from DXKit commands
    debugger.md          # Root cause analysis
  commands/              # 26 slash commands (see below)
  skills/                # Domain knowledge
    codebase/            # Auto-generated architecture overview
    learned/             # Evolving gotchas, conventions, deny list
  rules/                 # Path-scoped rules (per language + framework)
CLAUDE.md                # Main context file for Claude Code
.ai/
  sessions/              # Session checkpoints
  reports/               # Generated reports (health, vulnerabilities, etc.)
.github/
  workflows/
    pr-review.yml        # Automated PR review (opt-in)
```

## Supported Languages

| Language | Detection | Linters | Test Runner |
|---|---|---|---|
| Node.js / TypeScript | `package.json` | ESLint, Prettier, tsc | Auto-detected (Jest, Mocha, Vitest, Ava, Tap) |
| Python | `pyproject.toml`, `setup.py`, `*.py` | ruff, mypy | pytest |
| Go | `go.mod` | golangci-lint, go vet | go test |
| C# | `*.csproj`, `*.sln` | dotnet format, Roslyn | dotnet test |
| Rust | `Cargo.toml` | clippy, rustfmt | cargo test |

Multi-language repos fully supported — detects and generates rules/commands for all languages present.

## Supported Frameworks

Auto-detected with framework-specific path-scoped rules:

- **LoopBack** — Controller/model/repository patterns, decorator conventions
- **Express** — Middleware/routing conventions, error handling patterns
- **NestJS**, **Fastify**, **Koa**, **Hapi** — Detected (rules coming soon)
- **FastAPI**, **Django**, **Flask** — Detected (rules coming soon)
- **Gin**, **Echo**, **Fiber** — Detected (rules coming soon)

## Supported Tools

Auto-detected and integrated when present:

- **Google Cloud** (gcloud) — SDK commands, security rules
- **Infisical** — Secrets management, never-leak rules
- **Pulumi** — IaC with preview-before-apply safety
- **Docker** — Container commands

## Commands (30)

### Development Workflow
| Command | Description |
|---|---|
| `/session-start` | Start an AI-assisted dev session |
| `/session-end` | End session, create checkpoint, evolve skills |
| `/ask <question>` | Ask about the codebase (delegates to knowledge-bot) |
| `/learn` | Capture a gotcha, convention, or thing to avoid |

### Quality & Testing
| Command | Description |
|---|---|
| `/quality` | Run language-specific linters + AI review |
| `/test` | Run tests (auto-detected runner) |
| `/check` | Full pre-commit validation (quality + tests + AI review) |
| `/fix` | Auto-fix formatting and lint issues |
| `/build` | Build the project |
| `/test-gaps` | Find critical untested code paths |

### Analysis & Reports
| Command | Description | Output |
|---|---|---|
| `/health` | 6-dimension codebase health audit | `.ai/reports/health-audit-*.md` |
| `/vulnerabilities` | CWE-classified security scan (Snyk-comparable) | `.ai/reports/vulnerability-scan-*.md` |
| `/dev-report` | Developer activity + security attribution | `.ai/reports/developer-report-*.md` |
| `/docs audit` | Documentation gap analysis | `.ai/reports/docs-audit-*.md` |
| `/deps` | Dependency map + blast radius | `.ai/reports/dependency-map-*.md` |
| `/dashboard` | Generate HTML dashboard from all reports | `.ai/reports/dashboard.html` |
| `/export-pdf` | Convert markdown reports to PDF | `.ai/reports/*.pdf` |

### Planning & Execution — Fix Loop
| Command | Description | Output |
|---|---|---|
| `/plan` | Analyze reports → propose KPIs → generate improvement plans | `.ai/plans/` |
| `/execute-plan <name>` | Execute a fix plan task by task with session checkpoints | `.ai/plans/progress/`, `.ai/sessions/` |

### Feature Development Loop
| Command | Description | Output |
|---|---|---|
| `/feature <description>` | Design new feature → implementation plan | `.ai/features/` |
| `/build-feature <slug>` | Build feature from plan with tests and conventions | `.ai/features/progress/`, `.ai/sessions/` |

### Exploration & Onboarding
| Command | Description |
|---|---|
| `/onboarding` | Interactive onboarding buddy for new developers |
| `/explore-codebase` | Deep architecture exploration |
| `/help` | List all commands and agents |

### Setup & Hooks
| Command | Description |
|---|---|
| `/setup-hooks` | Configure git hooks (quality, test, vulnerability) — consistent with DXKit reports |
| `/stealth-mode` | Gitignore DXKit files + install hooks (DXKit local-only, hooks for all devs) |
| `/setup-pr-review` | Set up automated PR review GitHub Action |
| `/fix-issue <number>` | Investigate and fix a GitHub issue |
| `/doctor` | Diagnose environment issues |
| `/enable-agent <name>` | Activate a dormant agent |

## Agents

### Active by Default (4)
These agents auto-trigger when Claude detects a matching question:

- **knowledge-bot** — "How does auth work?" "Where are payments handled?"
- **onboarding** — "I'm new, help me get started" "What does this project do?"
- **quality-reviewer** — "Review my changes" "Check quality before I commit"
- **doc-writer** — "What needs documentation?" "Help me write docs"

### Dormant (16) — activate with `/enable-agent`
- **codebase-explorer** — Deep architecture analysis, generates documentation
- **code-reviewer** — PR review and security audit (read-only)
- **test-writer** — Writes tests for existing code
- **test-gap-finder** — Identifies critical untested code paths, prioritized by risk
- **dependency-mapper** — Maps import chains and blast radius of changes
- **health-auditor** — Comprehensive codebase health audit (scores 6 dimensions)
- **vulnerability-scanner** — CWE-classified security scan with Snyk-comparable depth
- **dev-report** — Developer activity, quality patterns, security attribution
- **dashboard-builder** — Generates HTML dashboard from all reports
- **strategic-planner** — Analyzes reports, proposes KPIs, generates improvement plans
- **plan-executor** — Executes fix plans task by task with session checkpoints
- **feature-planner** — Designs new features, generates implementation plans
- **feature-builder** — Implements features from plans with tests and conventions
- **hooks-configurator** — Configures scoped git hooks from DXKit commands
- **debugger** — Systematic root cause analysis

## Reports

All analysis commands save timestamped reports to `.ai/reports/`:

```bash
.ai/reports/
  health-audit-2026-03-30.md          # Scores: tests, quality, docs, security, DX
  vulnerability-scan-2026-03-30.md     # CVEs, hardcoded secrets, dependency risks
  developer-report-2026-03-30.md       # Team activity, ownership, security attribution
  test-gaps-2026-03-30.md              # Critical untested code, prioritized by risk
  docs-audit-2026-03-30.md             # Documentation gaps and recommendations
  dependency-map-2026-03-30.md         # Import chains, most-depended-on files
```

Export options:
- **HTML dashboard**: `/dashboard` — beautiful dark-themed dashboard with sidebar navigation
- **PDF**: `/export-pdf all` — converts all reports to PDF

## Learning System

DXKit includes a continuous learning system that improves over time:

1. **Stop Hook** — After each conversation, Claude is reminded to capture learnings
2. **`/learn` command** — Explicitly save gotchas, conventions, or things to avoid
3. **`/session-end`** — Creates checkpoint and evolves skill files
4. **Evolving files** — Append-only, never overwritten even with `--force`:
   - `.claude/skills/learned/references/gotchas.md`
   - `.claude/skills/learned/references/conventions.md`
   - `.claude/skills/learned/references/deny-recommendations.md`

## PR Review Automation

DXKit generates a GitHub Action that automatically reviews PRs using Claude Code:

1. Set `ENABLE_AI_REVIEW=true` as a GitHub Actions variable
2. Add `ANTHROPIC_API_KEY` to repo secrets

Reviews appear as PR comments with issues rated as critical/warning/suggestion.

## Git Hooks (Consistent with Reports)

`/setup-hooks` configures git hooks that run the **exact same tools** as your DXKit reports:

```
commit  → pre-commit  → lint staged files only         (fast, ~5s)
push    → pre-push    → test affected areas only        (medium, ~30s)
PR      → CI workflow  → full quality + tests + security (thorough, ~3m)
```

- User chooses which checks to enable: quality, test, vulnerability
- Hooks read from your `/quality`, `/test`, `/vulnerabilities` commands — no hardcoded tools
- Supports scoped testing: Jest `--changedSince`, Vitest `--changed`, pytest `--testmon`
- Works for all devs (plain bash, no Claude Code needed at runtime)

### Stealth Mode

`/stealth-mode` keeps DXKit local-only:
- `.claude/`, `.ai/`, `CLAUDE.md` gitignored — not committed
- `.githooks/` committed — all devs get the hooks
- One-time setup: `git config core.hooksPath .githooks`

## Vulnerability Scanner (Snyk-Comparable)

The `/vulnerabilities` command runs a comprehensive security scan with CWE classification:

| Category | CWE | What It Checks |
|---|---|---|
| Command Injection | CWE-78 | `exec()`, `child_process`, unsanitized input |
| Decompression Bomb | CWE-409 | zlib/tar/decompress without size limits |
| Uncontrolled Recursion | CWE-674 | JSON/XML/YAML parsers without depth limits |
| Arbitrary File Upload | CWE-434 | multer/formidable/busboy without validation |
| Buffer Overflow | CWE-120 | Native modules (binding.gyp, .node files) |
| Resource Exhaustion | CWE-770 | Missing rate limits, body size limits, WebSocket payload |
| Hardcoded Secrets | CWE-798 | Passwords, API keys, tokens in source |
| Prototype Pollution | CWE-1321 | Via dependency audit CWE extraction |
| + 15 more CWE categories | | Parsed from `npm audit --json` CWE fields |

Reports include a **Findings by CWE Category** table for direct comparison with Snyk/Sonar output.

## Smart Detection

- **Test runner** — Detects Jest, Mocha, Vitest, Ava, Tap, pytest, go test from scripts and dependencies
- **Framework** — Detects LoopBack, Express, NestJS, FastAPI, Gin, etc. with framework-specific rules
- **Test presence** — Counts test files vs source files, warns about minimal coverage
- **Multi-language** — Detects all languages including Python from `.py` files (no config file required)
- **Language breakdown** — Shows file count per language in codebase skill for accurate analysis

## CLI Reference

```bash
npx @vyuhlabs/dxkit init --detect        # Auto-detect, minimal prompts
npx @vyuhlabs/dxkit init                  # Interactive
npx @vyuhlabs/dxkit init --full --yes     # Everything, no prompts
npx @vyuhlabs/dxkit update               # Re-generate (preserves evolved files)
npx @vyuhlabs/dxkit update --rescan      # Re-run codebase analysis
npx @vyuhlabs/dxkit doctor               # Verify setup
```

### Init Options

| Flag | Description |
|---|---|
| `--detect` | Auto-detect stack, minimal prompts |
| `--yes` | Accept all defaults |
| `--dx-only` | Just `.claude/` + `CLAUDE.md` (default) |
| `--full` | Everything: DX + quality + hooks + CI |
| `--force` | Overwrite existing files (except evolved) |
| `--name <n>` | Override project name |
| `--no-scan` | Skip codebase analysis |

## Example: Node.js/TypeScript Project

```bash
cd my-loopback-app
npx @vyuhlabs/dxkit init --detect --yes
```

Output:
```
✓ Languages: node
✓ Framework: loopback
✓ Tests: mocha (npm test)
✓ Created: 61 files
```

Then in Claude Code:
```
/help                                    # See everything
/ask How does the auth middleware work?   # Codebase Q&A
/health                                  # Full health audit
/vulnerabilities                         # Security scan
/dev-report                              # Team activity report
/quality                                 # ESLint + AI review
/onboarding                              # New developer guide
```

## Example: Multi-Language Repo (Python + Go + TypeScript)

```bash
cd my-monorepo
npx @vyuhlabs/dxkit init --detect --yes
```

Generates:
- Quality commands with `npx eslint .` + `ruff check .` + `golangci-lint run`
- Test commands with `npm test` + `pytest` + `go test`
- Path-scoped rules for `.ts`, `.py`, and `.go` files
- Language breakdown in codebase skill: "TypeScript: 200, Python: 50, Go: 30"

## Two Workflows: Fix Loop and Feature Loop

### Fix Loop: Reports → KPIs → Plans → Execution

For improving existing code (security fixes, quality improvements, test coverage):

```
# 1. Init DXKit
npx @vyuhlabs/dxkit init --detect --yes

# 2. Generate reports
/health                                 # Codebase health (6 dimensions)
/vulnerabilities                        # Security scan (CWE-classified)
/test-gaps                              # Untested critical code

# 3. Generate improvement plans
/plan                                   # Propose KPIs + actionable plans

# 4. Execute plans with session management
/execute-plan security                  # Work through security fixes

# 5. Track progress
/dashboard                              # HTML dashboard with all reports
```

### Feature Loop: Description → Design → Plan → Build

For developing new features:

```
# 1. Design a new feature
/feature add user roles with admin, editor, viewer tiers

# Agent reads codebase, finds similar patterns, generates:
# .ai/features/user-roles.md with full implementation plan

# 2. Review and adjust the plan (edit the md file if needed)

# 3. Build the feature
/build-feature user-roles

# Agent executes tasks: model → migration → repository → service → tests → controller
# Session checkpoints after each task
# Progress tracked in .ai/features/progress/user-roles.md
```

Both loops use the session framework — checkpoints, skill evolution, progress tracking.

## Daily Development Workflow

```
/session-start                          # Load context, plan work
git checkout -b feature/my-feature      # Create branch
/ask How does the payment flow work?    # Understand the code
# ... develop with full context ...
/quality                                # Lint + AI review
/test                                   # Tests
/learn auth tokens expire after 24h     # Capture gotcha
git add -A && git commit                # Commit
/session-end                            # Checkpoint + evolve skills
```

## How It Works

1. **Detection** — Scans for config files, source files, and tools to determine languages, frameworks, and test runners
2. **Template Processing** — Processes `.md.template` files through a conditional engine, generating language-specific commands
3. **Codebase Scanning** — Analyzes source files to find entry points, API routes (including LoopBack/Express/FastAPI decorators), test patterns, and language breakdown
4. **Generation** — Writes 60+ files non-destructively (never overwrites without `--force`, evolving files always preserved)
5. **Manifest** — Saves state to `.vyuh-dxkit.json` for `update` and `doctor` commands

## License

MIT
