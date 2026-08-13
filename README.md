# dxkit

## The deterministic Definition-of-Done gate for coding agents

**Agents can say "done." dxkit verifies the change against your
repository's policy — build, tests, security, and repo-specific rules —
outside the model. It blocks attributable net-new violations and returns
the exact evidence while the agent still has the context to fix them. If
required evidence is missing, dxkit refuses to claim a pass.**

Every run ends `PASSED`, `BLOCKED`, or `CANNOT GATE`.

**In controlled agent-loop runs, ungated agents stopped with a seeded
regression still in the tree in 11 of 16 runs. With the gate armed: 0 of
16 observed.** (n=16 per arm, seeded detector-backed tasks —
[methodology, claim boundaries, and artifacts](docs/benchmarks.md))

<p align="center">
  <img src=".github/assets/loop-stop-gate-demo.gif" width="820" alt="dxkit blocks a coding-agent loop on a net-new regression, returns the finding to the agent, and allows the stop after the agent repairs it." />
</p>
<p align="center"><sub>Recorded from a real run on a synthetic repository, shortened for readability. Blocked and repaired inside the same warm loop.</sub></p>

<p>
  <a href="https://www.npmjs.com/package/@vyuhlabs/dxkit"><img alt="npm" src="https://img.shields.io/npm/v/@vyuhlabs/dxkit"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="deterministic gate" src="https://img.shields.io/badge/gate-deterministic-blue">
  <img alt="local-first" src="https://img.shields.io/badge/local--first-success">
</p>

Claude Code Stop hook today · any agent through git hooks or CI ·
local-first · no telemetry · MIT.

## Choose your path

| I want to…                                          | Start here                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Gate an agent working in my **existing repository** | `npx -y @vyuhlabs/dxkit evaluate` (read-only) → `npm init @vyuhlabs/dxkit -- --claude-loop`         |
| Gate code my **application or pipeline emits**      | `vyuh-dxkit gate <tree> --policy dod.json --json` → [embedding guide](docs/learn/gate-embedding.md) |

## The control problem

- The same model that writes a change decides when it is done. Prompted
  self-checks are instructions, not enforcement — in the benchmark above,
  a self-check prompt still left 9 of 16 seeded regressions in the tree.
- CI discovers failures after the loop has ended and the working context
  has gone cold. The repair then starts from scratch.
- On an existing codebase, repo-wide scanners cannot tell old debt from
  what this change introduced — so every change drowns in someone else's
  backlog, or the scanner gets turned off.

dxkit's answer: before the agent finishes, evaluate the actual tree
against repository-owned policy, block attributable new regressions,
disclose insufficient evidence, and return the exact repair reason while
the context is still warm. Instructions tell the agent what it should do;
**dxkit establishes what the repository will accept as done.** CI stays
the shared integration boundary — think of dxkit as CI inside the agent
loop, with old debt separated from new.

## How dxkit decides

Every verdict is computed from the same eight-part model: the **subject**
(the tree or change), the **prior** (the accepted baseline), the
**policy** (your Definition of Done), the **observation** (which checks
actually ran, with tool and config identity), the **attribution** (does a
finding belong to this change), the **decision**, the **evidence**
(fingerprints, skip causes, policy hash, receipt), and any **exceptions**
(typed, owned, expiring).

| Verdict       | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `PASSED`      | Every required check was observed against this tree and no policy-blocking regression was added.     |
| `BLOCKED`     | This change introduced a failure that violates policy — named, fingerprinted, with the way out.      |
| `CANNOT GATE` | Required evidence is missing, stale, or unattributable — dxkit refuses to guess in either direction. |

Watch all three in about thirty seconds, no repo, no git, no external
scanner:

```bash
mkdir demo && cd demo
cat > dod.json << 'EOF'
{ "extends": "security-only", "id": "demo.dod", "version": "1",
  "checks": [{ "name": "no_placeholder", "pattern": "\\bTODO\\b" }] }
EOF
echo '// TODO wire the discount path' > handlers.js

npx -y @vyuhlabs/dxkit gate . --policy dod.json --trusted   # BLOCKED: the TODO, fingerprinted
sed -i 's/TODO wire/wired/' handlers.js
npx -y @vyuhlabs/dxkit gate . --policy dod.json --trusted   # PASSED
npx -y @vyuhlabs/dxkit gate . --policy dod.json             # CANNOT GATE (exit 2): the required
                                                            # correctness floor cannot run on an
                                                            # untrusted tree, so dxkit refuses to
                                                            # certify it rather than pass around it
```

No project files are changed by any of this (`npx` fetches the package;
useful external detectors are provisioned separately and every skip is
disclosed, never silently counted as a pass).

## What "done" means

A policy file is your executable Definition of Done. It declares the
base posture it refines, the checks that must run, and what blocks:

```jsonc
{
  "extends": "security-only", // or "full-debt" / "default" — the declared base
  "id": "acme.dod",
  "version": "1",
  "floor": { "required": true }, // compile + affected tests must be OBSERVED (the default)
  "checks": [
    { "name": "arch", "command": "scripts/check-arch.sh", "required": true },
    { "name": "no_placeholder", "pattern": "\\bTODO\\b" }, // built-in text rule, no spawn
  ],
}
```

- `security-only` (the default posture) blocks net-new secrets, critical
  and high code findings, critical dependency vulnerabilities, and
  known-malicious packages at any severity. Everything else net-new warns
  — nothing net-new is ever silent. `full-debt` also blocks net-new test
  gaps and quality regressions.
- Before the finding gate, a **correctness floor** runs: does the change
  still compile, do the tests it affects still pass? A pre-existing
  failure never blocks; a net-new one does.
- **Required vs optional is explicit.** A required check that did not run
  — untrusted tree, missing toolchain — turns the verdict into
  `CANNOT GATE` with the cause and remedy named. An optional check that
  cannot run passes with the skip disclosed. `vyuh-dxkit policy show`
  renders the effective policy, per-rule provenance, and the fallbacks.

## The attribution contract

`net-new` is a proof obligation, not a scan diff. A difference between
two scans has six possible causes, and just one of them is your change:

| A finding delta can mean...                    | dxkit rules it out with...                            |
| ---------------------------------------------- | ----------------------------------------------------- |
| the change introduced it                       | **the one cause that blocks**                         |
| the scan didn't fully observe the current side | per-kind observation disclosures, never silent        |
| the finding moved (line shift, rename)         | git-aware identity matching with durable fingerprints |
| a scanner changed underneath you               | per-kind recall contexts (tool + plugin + config)     |
| dxkit itself changed what it can see           | versioned observation epochs                          |
| a truncated or partial prior report            | multiset-aware pair matching                          |

When the other five cannot be ruled out, the verdict is `CANNOT GATE`:
named cause, named remedy. A `PASSED` over an attribution gap is not
constructible, and a tool upgrade is never blamed on whoever opened the
next PR:

```text
Guardrail CANNOT GATE — 3 findings on block-rule kind (secret) cannot be attributed
  · secret: gitleaks 8.18.4 → 8.21.0 since the baseline was captured
  · dispatch the baseline-refresh workflow to re-capture the anchor from CI
```

Existing findings are **grandfathered, not approved**: baselined with
durable fingerprints on day one, visible and auditable, never blocking
unrelated work. Only what a change adds from here can block. Paying down
the backlog is a separate, deliberate workstream (`vyuh-dxkit debt`), and
a baseline refresh is a governance action, not a repair action. That is
what the name means — dx as in calculus: dxkit gates what a change does
to your repository, not what your repository already was.

## Evidence

The loop-safety benchmark, on controlled seeded-regression tasks:

| Loop condition            | Dirty stops observed |
| ------------------------- | -------------------: |
| Agent alone               |              11 / 16 |
| Agent + self-check prompt |               9 / 16 |
| Agent + dxkit Stop-gate   |  **0 / 16 observed** |

n=16 per arm; synthetic, detector-backed tasks; part of the experiment
ran the opt-in `full-debt` posture. This shows an observed reduction in
dirty stops under the tested conditions, not universal correctness —
[the claim ledger](docs/benchmarks.md) states each claim's boundary, and
the recorded fixtures replay offline without an API key.

Blocked, for real:

- **dxkit gates its own development.** Its CI guardrail
  [blocked PR #134](https://github.com/vyuh-labs/dxkit/pull/134) on real
  findings; the failed and passing runs are in that PR's checks history.
  We fixed the findings, not the gate.
- **A lint-cleanup agent introduced vulnerabilities; the gate caught it.**
  In a production remediation run, the guardrail blocked the PR and
  returned the exact findings; nothing landed.
- **Advisories published the same hour** as one of dxkit's own release
  checks were flagged and routed to a decision lane — neither silently
  absorbed nor blamed on the release PR.

A verdict is reproducible given the same tree, policy, baseline,
toolchain, and advisory snapshot — and each of those identities is
stamped on the verdict, so "same input" is checkable, not vibes.

## Supported integrations

- **Agents**: the Stop-hook integration ships for Claude Code today. The
  pre-push hook and CI guardrail are agent-neutral and gate the change
  whatever tool wrote it. Further agent adapters are planned, starting
  with Codex.
- **Detectors**: dxkit runs or ingests gitleaks, Semgrep, OSV, Snyk Code,
  CodeQL, SonarQube, and any SARIF — one fingerprint scheme, one
  baseline, one verdict. It does not claim to out-detect them.
- **Languages**: eleven ecosystems (TypeScript/JS, Python, Go, Rust, C#,
  Java, Kotlin, Ruby, Swift, PHP, ABAP) — [the support matrix](docs/README.md).
- **Pipelines**: the frozen `verdict.v1` JSON is the embed contract —
  status, exit code, policy identity, per-finding fingerprints, per-check
  skip causes, and a receipt to store as evidence. One-shot trees,
  tree-vs-original diffs, and whole workspaces
  ([wave gating](docs/learn/wave-gating.md)).

## Install, verify, uninstall

```bash
npx -y @vyuhlabs/dxkit evaluate        # read-only: replays your recent merges through
                                       # the gate — evidence first, setup second
npm init @vyuhlabs/dxkit -- --claude-loop   # install: agent context, Stop hook, scanners,
                                            # and today's baseline (init names each step)
npx vyuh-dxkit doctor                  # verify the wiring, get repo-grounded advice
npx vyuh-dxkit uninstall               # restore the exact pre-dxkit state (dry-run first)
```

The first baseline also records your repo's pre-existing build/test state,
which means running your build and test suite once (bounded; `init` names
the exact commands before they run — `--no-floor` defers that to CI).
Variants: `--full` for pre-push + CI instead of the loop; `--dx-only` for
agent context with no gate; `init --gate-only` for embedders (writes only
the policy file). Everything is additive and reversible.

## Extend and contribute

Custom checks and text rules are first-class gate citizens
([`vyuh-dxkit checks`](docs/commands/checks.md)); repo-specific
extractors, inventories, and delivery sinks plug in as
[extensions](docs/learn/gate-embedding.md) in any language; new language
packs are a scaffold plus a contract test
([CONTRIBUTING.md](CONTRIBUTING.md)). Deliberate releases, every one
through the full gate suite including dxkit's own guardrail
([RELEASES.md](RELEASES.md)).

## Beyond the gate

The gate is the product; these compose with it, and none of them is
required to use it:

- **The map**: `vyuh-dxkit describe` renders your code graph and HTTP
  contract as one self-contained HTML page — the structure an agent (or a
  new teammate) should read before editing. The same graph powers
  affected-test selection and blast-radius context.
- **Repair lanes**: scheduled baseline refresh, deterministic dependency
  bumps, and budget-bounded remediation agents — every attempt lands only
  through a PR that passes the same floor and guardrail a human change
  faces, with model, prompt, and spend disclosed
  ([`vyuh-dxkit remediate`](docs/commands/remediate.md)).
- **The one-page tour**: `npx -y @vyuhlabs/dxkit learn --serve` — every
  command, policy knob, and guide on one searchable offline page.
- **Health reports**: six scored dimensions with structured deductions
  ([docs](docs/README.md)).

When _not_ to use dxkit: a repo with no tests and no standards to
enforce gives the gate little to hold a change to — start with `evaluate`
and let the evidence decide. dxkit is a pre-review completion gate, not a
replacement for human review, and passing checks do not prove a feature
matches intent — encode intent as checks and it will hold the agent to
them.

## Credits

dxkit stitches excellent tools together — gitleaks, semgrep, osv-scanner,
cloc, jscpd, abaplint, tree-sitter, and more — and adds the baseline,
identity, attribution, and verdict machinery around them. MIT.
