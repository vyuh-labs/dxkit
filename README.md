# dxkit

**A deterministic stop condition and code-graph context layer for AI coding agents.**

Autonomous coding loops face two control problems: orienting in the code while
they make a change, and deciding whether that change made the repository worse
before they stop.

dxkit addresses both. While the agent works, it provides a code graph of
callers, callees, blast radius, and the files a change touches. Then, when the
agent tries to stop, dxkit baselines existing findings, reruns trusted checks,
and blocks only net-new detector-backed regressions with a concrete repair
reason.

In our loop benchmark, vanilla Claude Code-style loops stopped with net-new
debt in **11 of 16 runs**. A prompt that told the agent to self-check still
escaped **9 of 16**. With dxkit's Stop-gate, we observed **0 of 16** escapes:
when the loop tried to stop dirty, dxkit blocked, handed back the exact net-new
finding, and the agent repaired before stopping clean.

<p align="center">
  <img src=".github/assets/loop-stop-gate-demo.gif" width="820" alt="dxkit's Stop-gate blocks a coding-agent loop on a net-new critical dependency vulnerability, the agent bumps the version, and the gate goes clean." />
</p>
<p align="center"><sub>Recorded from a real run on a synthetic repo, shortened for readability. Blocked and repaired inside the same warm loop.</sub></p>

dxkit does not reinvent detection. It runs trusted open source scanners
(gitleaks, Semgrep, OSV, npm audit, and more), and it can ingest results from
Snyk and CodeQL. What dxkit adds is the agent-loop layer around those tools: a
per-stop, baseline-relative verdict of whether this change introduced a new
finding, returned to the agent with the exact repair reason while the loop is
still warm.

```bash
npm init @vyuhlabs/dxkit -- --claude-loop --yes   # install dxkit + register the Claude Code Stop hook
npx vyuh-dxkit baseline create                    # grandfather today's findings
npx vyuh-dxkit loop doctor                         # verify the gate is wired
```

The stop verdict has no model in the path: same input, same verdict.
Existing debt stays grandfathered; only net-new regressions block.

> The agent-facing pieces (the skills like `dxkit-onboard` and `dxkit-fix`, the Stop-gate, and "ask Claude to fix dxkit" guidance) activate when your agent session is **rooted in the repo**, meaning it started from the repo directory. Open your agent there, not in a parent folder.

[Read the benchmark](docs/benchmarks.md) · [Try it on your repo](#try-it-on-your-repo) · [Run the fixture gate](#run-a-local-fixture-gate)

<p>
  <a href="https://www.npmjs.com/package/@vyuhlabs/dxkit"><img alt="npm" src="https://img.shields.io/npm/v/@vyuhlabs/dxkit"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="deterministic gate" src="https://img.shields.io/badge/gate-deterministic-blue">
  <img alt="local-first" src="https://img.shields.io/badge/local--first-success">
</p>

---

## The problem: loops do not know when they made things worse

An autonomous loop runs until the agent decides it is done. The common checks in
that loop (tests, linters, scanners, CI-style commands) usually answer whether
something is broken or flagged. They do not, by themselves, maintain a
brownfield baseline and answer the loop-level question: did this change
introduce something net-new? So an agent can add a feature, leave a new untested
path or a hardcoded credential behind, run the tests, see green, and declare
success.

In our benchmark this happened in most vanilla runs, and telling the agent to
check its own work only helped a little.

## What dxkit does

1. **Build a structural code graph.** dxkit gives the agent callers, callees,
   blast radius, and relevant files so it can orient before editing.
2. **Baseline today's debt.** `baseline create` records current findings, so
   pre-existing issues are grandfathered and never block.
3. **Run a deterministic Stop-gate on every stop.** A Claude Code Stop hook
   reruns the guardrail against that baseline. Same input gives the same
   verdict; no model decides whether the gate passes.
4. **Feed net-new findings back to the agent.** If the change introduced a
   finding, the gate blocks the stop and hands the agent the exact finding to
   fix: do not refresh the baseline, do not touch unrelated debt, fix what this
   branch introduced. The loop stops only when clean.

## Why only net-new findings?

Grandfathered does not mean accepted.

dxkit blocks only net-new findings for two reasons: agent-loop attribution and
brownfield adoption.

First, an autonomous coding loop needs a scoped stop condition. When an agent
tries to declare done, the relevant question is not "is this entire repository
debt-free?" It is:

> did this loop make the repository worse than the baseline?

If the gate asks the agent to fix every pre-existing finding before it may stop,
the repair target becomes noisy and unbounded. The agent may churn unrelated
code, spend context on old debt, or refresh the baseline to escape. dxkit instead
holds the loop accountable for the change it just made: fix what this branch
introduced, do not touch unrelated debt, and do not move the baseline.

Second, dxkit is designed for brownfield repositories. Existing debt may include
hundreds or thousands of findings. If the first gate required a repo to reach
zero findings, most teams could not adopt agentic development workflows until
after a large cleanup project. That is backwards. The first control invariant is
simpler and stricter:

> this agent must not make the repository worse than the baseline.

`baseline create` records the current state so existing findings remain visible
and auditable, but they do not block the current loop. When an agent changes the
repo, dxkit blocks only findings introduced by that change. This lets teams adopt
agentic workflows immediately, prevent regression from day one, and pay down the
old baseline as a separate, deliberate workstream.

A baseline refresh is a governance action, not a repair action. If the Stop-gate
blocks, the agent should fix the net-new finding it introduced and should not move the
baseline.

## Who this is for

Use dxkit if you let coding agents:

- run unattended or semi-attended,
- fix CI or review comments in loops,
- touch brownfield repos that already carry debt,
- or work where "new debt" matters more than "all debt."

## What dxkit is, and is not

**It is a deterministic verification layer.** It baselines today's findings,
fingerprints them across churn, and blocks only net-new regressions.

**It is not a scanner replacement.** It runs and ingests scanners (gitleaks,
Semgrep, CodeQL, Snyk, SARIF) and makes their findings enforceable. It does not
claim to find more bugs than they do.

**It is not an LLM judge.** No model decides whether the gate passes. The model
can repair findings. The gate itself is deterministic, and the prompt does not
grow as the baseline grows.

**It is not a guarantee of safe code.** It blocks detector-backed net-new
findings it can observe. You still need tests, review, scanners, and judgment.

## Built on tools you already trust

dxkit is an orchestration and enforcement layer, not another scanner. It runs
established open source tools and treats their output as one stream. Which tools
run depends on the languages in your repo. dxkit covers **8 ecosystems**
(TypeScript / JavaScript, Python, Go, Rust, C# / .NET, Java, Kotlin, Ruby).

Universal, on every repo:

- secrets: gitleaks
- code patterns: Semgrep
- dependency advisories: OSV.dev
- size, duplication, and the code graph: cloc, jscpd, graphify

Per language, dxkit adds that ecosystem's own linter and audit tool. For
example, npm audit + ESLint (JS / TS), pip-audit + ruff (Python), govulncheck +
golangci-lint (Go), cargo-audit + clippy (Rust), `dotnet list --vulnerable`
(C#), osv-scanner + PMD (Java), osv-scanner + detekt (Kotlin), and
bundler-audit + RuboCop (Ruby). The full per-language matrix is in **Per-pack
capabilities** below.

For deep interprocedural analysis, it ingests findings from **Snyk Code** and
**CodeQL** (or any SARIF file), fingerprints them the same way as native
findings, and runs them through the same baseline and gate. You keep the
detectors you already have. dxkit makes their findings enforceable inside CI
and inside the agent loop.

| Layer     | Examples                                               | Job                                                     |
| --------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Detection | gitleaks, Semgrep, OSV, npm audit, Snyk, CodeQL, SARIF | Find issues                                             |
| dxkit     | baseline, fingerprint matcher, Stop-gate, loop ledger  | Decide whether this change introduced something net-new |
| Agent     | Claude Code or another coding loop                     | Repair the exact finding and try to stop again          |

## Try it on your repo

The Stop hook runs dxkit on every stop, so install dxkit into the repo. This
one command adds it as a devDependency and registers the hook additively, so your
existing `.claude` settings are preserved:

```bash
npm init @vyuhlabs/dxkit -- --claude-loop --yes
npx vyuh-dxkit baseline create      # grandfather today's findings
npx vyuh-dxkit loop doctor          # verify the gate is wired safely and dxkit resolves
# then run Claude Code as you normally would. The Stop-gate fires on every stop.
npx vyuh-dxkit loop ledger summarize  # afterwards: blocked vs allowed, repaired-after-block
```

When the agent tries to stop, dxkit runs the net-new gate against the baseline.
Existing findings are grandfathered; only findings this change introduced block.

> **pnpm with a release-age policy?** If your `pnpm-workspace.yaml` sets
> `minimumReleaseAge`, a just-published dxkit is blocked until it ages in. Add
> the package to `minimumReleaseAgeExclude` first so the install resolves — this
> is your supply-chain policy, so dxkit does not edit that file for you.
>
> **Upgrading** on such a repo: keep the exclusion in place across the bump. If
> you swap a pinned old version for the new one _before_ installing, the stale
> lockfile entry violates the policy mid-install and can leave `node_modules` on
> the new version while your manifests still reference the old one (a broken
> bin). Exclude the package (not a version), run the upgrade, and you're done —
> no version juggling.

## Run a local fixture gate

Want to see the Stop-gate before installing dxkit into your repo?

```bash
npx -y @vyuhlabs/dxkit@latest demo loop-guardrail
```

This runs the **real** gate on a temporary fixture repo: baseline → introduce a
net-new secret → BLOCK → repair → CLEAN, then it tears the fixture down. No API
key and no Claude Code, and your own repo is never touched. It needs gitleaks
installed and takes about 20 seconds; without gitleaks it shows a clearly
labelled illustration instead. (It does a one-time `npx` download, so it is not
fully offline, though the gate itself is.)

### Presets: what blocks the loop

```text
security-only  (default)  secrets and critical or high vulnerabilities. Bounded, must-fix, cheap to gate.
full-debt      (opt-in)   also gates test gaps and maintainability regressions. Repairs can be expensive.
```

The default is `security-only`. The headline escape-rate benchmark used
`full-debt` (it gated both the secret trap and the test-gap trap); the default
install starts narrower so a first run does not trap users in expensive
test-generation loops. Switch with
`npm init @vyuhlabs/dxkit -- --claude-loop --loop-preset full-debt`.

## Give the agent a map, not just a gate

The Stop-gate controls what a loop is allowed to ship. The code graph controls
how the agent does the work in between. When dxkit scaffolds a repo it builds a
code graph and installs skills that drive real development off it, so the agent
orients by querying structure instead of grepping and re-reading whole files.

- **Build a feature** (`dxkit-feature` skill): query the graph for where the
  feature plugs in, what patterns already exist, and what the change will
  touch, then implement against those patterns and run the analyzers on the
  result before it stops.
- **Fix a finding** (`dxkit-action` skill): take a flagged finding, pull its
  callers, callees, and blast radius from the graph, repair it, and confirm the
  change did not introduce something net-new.

The agent gets callers, callees, and blast radius up front as a budget-bounded
slice, not a pile of file reads. It is the same graph, the same baseline, and
the same identity contract the gate already uses.

What the benchmarks actually show is predictable spend, not guaranteed cheaper
spend. On a large repo the median was roughly tied, the worst-case session used
about **57% fewer tokens**, and the variance was **roughly halved**. On a small
repo the overhead was about zero. The graph caps the expensive tail. It does
not promise a lower average, and it does not make the agent write better code on
its own.

This is a different axis from detection. Snyk, SonarQube, and CodeQL tell you
what is wrong. They do not give the agent a map of the code or bound how much it
spends finding its way around. dxkit does both: the gate bounds what the loop
ships, the graph bounds how the loop works.

## The numbers

Three independent benchmark results, one theme: dxkit makes agent work more
predictable.

| Layer                      | What it bounds                       | Observed result                                                                                                                     |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Stop-gate**              | net-new detector-backed debt         | vanilla loops escaped **11/16** times, prompt-only checklist escaped **9/16**, dxkit escaped **0/16**                               |
| **Deterministic identity** | false "net-new" findings under churn | caught **all 3** seeded regressions with **0/2** false blocks on clean edits; **0 false net-new** on tested line shifts and renames |
| **Graph context**          | large-repo exploration tails         | median roughly tied, but large-repo mean tokens **30% lower**, worst case **57% lower**, variance roughly halved                    |

**Deferral has a re-orientation cost.** A fourth arm of the
loop-safety study measured the "detect on CI, fix later" model: on the test-gap
task, deferring a net-new finding to a cold session cost **~49% more in
equivalent cost** and **~51% more turns** than repairing it inside the warm loop,
because the cold fixer has to re-orient in a context it no longer holds. (The
secret-task premium pointed the same way but was weak (mean +19%, median
slightly negative), so we lean on the robust test-gap result.) So the gate is not
just safer than deferring, it is plausibly cheaper too.

**And the gate is fast enough to run on every stop.** dxkit 2.14.0 scopes the
Stop-gate scan to the active preset's blockable finding kinds and re-scans only
the changed files, reusing cached results for everything unchanged. The verdict
is identical to a full scan; the cost is seconds per stop, not minutes, even on
large repositories.

> **Benchmark caveats:** the loop-safety study uses controlled synthetic tasks
> plus real-repo validation, detector-backed findings, and Sonnet runs. It is
> not a CVE corpus, not a claim of better detection, and not a guarantee that
> dxkit catches every possible bug. The claim is narrower: for findings the
> detector observes, dxkit gives the loop a deterministic net-new stop decision.

Full methodology, reproducibility notes, artifact status, and caveats are in
**[docs/benchmarks.md](docs/benchmarks.md)**.

## Why not just Snyk, SonarQube, or CodeQL?

Use them. dxkit can ingest their findings. The difference is tempo and control,
not detection. Cloud scanners are strong detection engines, and they usually
run on a CI or PR cadence. A coding-agent loop needs a local stop decision
every time the agent tries to declare done.

| Loop Stop-gate need                                         | dxkit | Cloud or CI scanners                   |
| ----------------------------------------------------------- | ----- | -------------------------------------- |
| Runs locally on every stop, in seconds                      | yes   | usually CI or cloud cadence            |
| Deterministic verdict, no model in the gate                 | yes   | varies (some add an LLM judge)         |
| Grandfathers existing debt                                  | yes   | tool-dependent                         |
| Feeds the exact block reason back to the warm agent session | yes   | usually a human-facing dashboard or PR |

The goal is not to replace scanners. It is to make their findings enforceable
at the speed of the agent loop.

## Beyond loops

The same deterministic core powers the rest of dxkit: pre-push and CI
guardrails, brownfield baselines, durable finding identity, SARIF, CodeQL, and
Snyk ingest, a six-dimension health report, code-graph context, and a set of
Claude Code skills. See **[the docs](docs/README.md)**.

## Languages

dxkit covers 8 ecosystems. Detection is automatic from your manifests and
source; each language brings its own native linter, dependency-audit tool, and
coverage parser, layered on the universal scanners (gitleaks, Semgrep, OSV,
cloc, jscpd, graphify).

| Language                | Detected by                 | Native linter + audit                     |
| ----------------------- | --------------------------- | ----------------------------------------- |
| TypeScript / JavaScript | `package.json`              | ESLint, npm audit                         |
| Python                  | `pyproject.toml`, `*.py`    | ruff, pip-audit                           |
| Go                      | `go.mod`                    | golangci-lint, govulncheck                |
| Rust                    | `Cargo.toml`                | clippy, cargo-audit                       |
| C# / .NET               | `*.csproj`, `*.sln`         | dotnet-format, `dotnet list --vulnerable` |
| Java                    | `pom.xml`, `src/main/java/` | PMD, osv-scanner                          |
| Kotlin                  | `*.gradle{.kts,}`, `*.kt`   | detekt, osv-scanner                       |
| Ruby                    | `Gemfile`, `*.rb`           | RuboCop, bundler-audit                    |

<details>
<summary><strong>Per-pack capabilities</strong>: coverage import, import-graph, severity tiers (click to expand)</summary>

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
defaults for those packs. Resolvers are tracked on the [roadmap](docs/roadmap.md).

² C# uses `dotnet-format` for formatting violations only. A real
severity-tiered C# linter (Roslyn analyzers or StyleCop) is on the
roadmap. Today every C# formatting violation is counted at `low` tier
so it does not inflate the Code Quality score.

</details>

## Reproduce the deterministic tier

The deterministic results (the net-new gate decision and the finding-identity
matcher) reproduce offline with no API key, so you do not have to trust our
numbers. These harnesses live in `benchmarks/`:

```bash
node benchmarks/bench-guardrail.mjs config.json        # block/allow on seeded findings
node benchmarks/bench-netnew-isolation.mjs config.json # net-new isolation under churn
node benchmarks/bench-matcher.mjs config.json          # false net-new on line shifts + renames
```

See `benchmarks/README.md` to point them at a repo. The agent-driven harnesses
(loop safety, cost of deferral, gate-vs-LLM, and the graph-context sessions) need
a model subscription or API key and are published under `benchmarks/agentic/`.
Full methodology, the per-study reports, caveats, and repro steps:
**[docs/benchmarks.md](docs/benchmarks.md)**.

## Credits

dxkit stands on excellent open source tools. It orchestrates them, it does not
replace them. Thank you to the maintainers of
[graphify](https://github.com/safishamsi/graphify) (the code graph),
[gitleaks](https://github.com/gitleaks/gitleaks),
[Semgrep](https://github.com/semgrep/semgrep),
[OSV-Scanner](https://github.com/google/osv-scanner),
[jscpd](https://github.com/kucherenko/jscpd), and
[cloc](https://github.com/AlDanial/cloc). Each tool is installed separately and
keeps its own license.

## Contributing and roadmap

- Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Roadmap: [docs/roadmap.md](docs/roadmap.md)
- License: MIT
