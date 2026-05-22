# Getting Started

End-to-end: install dxkit, install the tools it drives, run your
first report on an existing repo.

## 1. Install dxkit

Requires Node.js ≥ 18.

**Canonical first install** (collapses install + scaffold into one
step):

```bash
npm init @vyuhlabs/dxkit
```

This installs `@vyuhlabs/dxkit` as a devDependency in your repo,
runs `vyuh-dxkit init --full --yes`, and lands all nine `dxkit-*`
agent skills + devcontainer + git hooks + CI workflows. The post-
install hook also auto-activates `core.hooksPath = .githooks` so
teammates who clone + `npm install` get hooks wired automatically.

If you want dxkit available as a bare command in your shell (not
just as a project-local install):

```bash
npm install -g @vyuhlabs/dxkit
```

Verify:

```bash
vyuh-dxkit --version
```

**Convention used throughout the docs:** examples use the short
`vyuh-dxkit <cmd>` form (assumes global install). To run any example
without installing globally, swap in `npx vyuh-dxkit <cmd>`.

To upgrade an existing install later:

```bash
vyuh-dxkit upgrade           # plan + execute the binary + scaffold refresh
```

## 2. Install the external tools

DXKit doesn't reimplement scanners — it drives best-in-class tools
(gitleaks, semgrep, cloc, jscpd, ruff, eslint, govulncheck,
osv-scanner, and more) and stitches their output together.

First, see what's detected on your machine:

```bash
cd /path/to/your/repo
vyuh-dxkit tools
```

Output shows each tool's status:

```
LAYER 1 (always-required):
  ✓ cloc           1.96      (homebrew)
  ✓ gitleaks       8.18.4    (homebrew)
  ✗ semgrep        not found

LAYER 2 (language-specific, only required for active packs):
  ✓ eslint         8.57.0    (node_modules/.bin)
  ✓ ruff           0.5.7     (pipx)
  ✗ govulncheck    not found  (go pack active in this repo)
```

To install everything missing for the current repo's stack:

```bash
vyuh-dxkit tools install
```

This prompts before each install and uses your platform's preferred
installer (brew on macOS, pipx for Python tools, `go install`, etc.).

To install ALL tools (for development on dxkit itself, or to
pre-provision a multi-stack machine):

```bash
vyuh-dxkit tools install --all
```

## 3. Run your first report

The single fastest way to see what dxkit produces:

```bash
vyuh-dxkit health
```

This runs the 6-dimension health audit. On a medium-sized codebase it
takes 1-4 minutes. Output:

```
  vyuh-dxkit health
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  → Analyzing /path/to/your/repo...
  → detect
  → generic (Layer 0)
  → package.json
  → layer2 (parallel)
  → coverage
  → capabilities

  Overall: 73/100 (Grade: C)

  Testing                ███████████░░░░░░░░░  55/100  fair
  Code Quality           ████████████████░░░░  80/100  excellent
  Documentation          █████████░░░░░░░░░░░  45/100  fair
  Security               ██████████████████░░  90/100  excellent
  Maintainability        ██████████████░░░░░░  70/100  good
  Developer Experience   ████████████████████  100/100 excellent

  ✓ Report saved to .dxkit/reports/health-audit-2026-05-14.md
```

The full breakdown lives in `.dxkit/reports/`:

- `health-audit-<date>.md` — short summary
- `health-audit-<date>-detailed.md` — every metric, ranked remediations
- `health-audit-<date>-detailed.json` — machine-readable shape

## 4. Run the rest

Once you've seen health, the natural next steps:

```bash
vyuh-dxkit vulnerabilities   # security deep-scan
vyuh-dxkit test-gaps         # untested-file ranking
vyuh-dxkit quality           # lint + duplication + slop
vyuh-dxkit bom               # full SBOM with CVE × upgrade plan
```

Each writes to `.dxkit/reports/`. Then assemble everything:

```bash
vyuh-dxkit dashboard
```

Opens `.dxkit/reports/dashboard.html` as a single browsable view.

If you want to run **everything** in one shot:

```bash
vyuh-dxkit report
```

This is the full audit (`health` + `vulnerabilities` + `test-gaps` +
`quality` + `dev-report` + dashboard). On a medium codebase: 5-15
minutes. On large JS-heavy codebases the `jscpd` (duplicate-code)
phase dominates — expect 20-30 min.

## 5. Wire commit-time guardrails

Once you've seen the reports, the next step for a brownfield repo is
to lock in today's state as the floor and block any new regressions
from landing — without forcing a cleanup sprint first.

```bash
# Install hooks + devcontainer + GitHub Actions PR-gate + baseline-refresh
# + nine dxkit-* agent skills + AGENTS.md.
vyuh-dxkit init --full

# Or pick à la carte:
vyuh-dxkit init --with-hooks --with-ci

# Capture today's findings as the brownfield anchor.
vyuh-dxkit baseline create

# Commit the anchor + workflow files.
git add .dxkit/baselines/main.json .githooks .github/workflows/dxkit-*.yml
git commit -m "chore: enable dxkit guardrails"
```

Hook activation is now automatic on `npm install` via the postinstall
chain (added in 2.5.1). If you ever need to activate manually (e.g.
after deleting `node_modules/`):

```bash
vyuh-dxkit hooks activate    # idempotent; refuses to clobber husky/lefthook
```

For unbypassable CI enforcement, add the guardrail workflow as a
required status check on your default branch:

```bash
vyuh-dxkit setup-branch-protection
```

If your team uses Codespaces, configure prebuilds so fresh containers
start in ~30s instead of re-running the full devcontainer build:

```bash
vyuh-dxkit setup-prebuild
```

From this point:

- Every `git push` runs the full `guardrail check` (pre-commit is
  opt-in via `--with-precommit-hook` — slow on large repos until
  incremental scoped scanning lands; see
  [`guardrail`](commands/guardrail.md#hooks) for the trade-off).
- Every PR is gated by the `dxkit-guardrails.yml` workflow, which
  posts a markdown comment.
- Every merge to `main` auto-regenerates `.dxkit/baselines/main.json`
  so the next PR's anchor reflects merged state.

One-off bypass:

```bash
DXKIT_SKIP_HOOKS=1 git push ...      # dxkit-specific (audit-friendly)
git push --no-verify ...             # standard git bypass
```

Turn dxkit hooks off entirely (per-clone) without uninstalling:

```bash
git config --unset core.hooksPath
```

Customize what blocks vs. warns by writing a
[`.dxkit/policy.json`](configuration/policy.md) — auto-discovered when
present.

See [`baseline`](commands/baseline.md) and [`guardrail`](commands/guardrail.md)
for the full surface.

## 6. Suppress individual findings

When the guardrail blocks a finding you can't fix today — a false
positive, an intentional test fixture, a real risk mitigated
externally — use the [allowlist](commands/allowlist.md). Every
entry carries a typed category and a required reason:

```bash
# Inline annotation (for source-anchored findings)
vyuh-dxkit allowlist add src/auth/oauth.ts:42 \
    --category=test-fixture \
    --reason="placeholder in unit test"

# File-level entry (for cross-file findings or accepted-risk / deferred)
vyuh-dxkit allowlist add \
    --fingerprint=<id-from-guardrail-output> \
    --kind=dep-vuln \
    --category=accepted-risk \
    --reason="WAF rule mitigates this CVE" \
    --expires=2026-08-22
```

The guardrail's block message prints the exact `allowlist add`
command to paste for every blocked finding — copy-paste rather
than constructing by hand. Periodic `vyuh-dxkit allowlist audit`
surfaces stale + soon-to-expire entries.

## 7. What to do when something goes wrong

```bash
vyuh-dxkit doctor
```

Diagnoses common issues — missing tools, version mismatches, package
manager misconfig, etc. It's the first stop when a report fails or
produces no output.

If you've hit a false positive, missing finding, dxkit bug, or docs
gap, open a pre-filled GitHub issue:

```bash
vyuh-dxkit issue --type=false-positive --about="..."
vyuh-dxkit issue --type=bug --about="..."
```

See [`vyuh-dxkit issue`](commands/issue.md) for full details.

## What's next

- Per-command pages in [`commands/`](commands/) describe options +
  output shape in detail.
- [Allowlist reference](commands/allowlist.md) — per-finding
  suppression with typed categories + expiry.
- [Exclude noisy paths](configuration/dxkit-ignore.md) from analysis
  with `.dxkit-ignore`.
- [Language pack detection](configuration/language-packs.md) explains
  which tools activate for which file types.
