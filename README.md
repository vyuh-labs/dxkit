# dxkit

**A deterministic Stop-gate for autonomous coding loops.**

Coding agents keep editing until they decide to stop. Tests and linters catch
broken code, but they do not know whether the agent made the repo worse than
the baseline. So loops can quietly ship new secrets, untested paths, and other
detector-backed regressions, then report success.

In our loop benchmark, vanilla Claude Code-style loops stopped with net-new
debt in **11 of 16 runs**. A prompt that told the agent to self-check still
escaped **9 of 16**. With dxkit's Stop-gate, we observed **0 of 16** escapes:
when the loop tried to stop dirty, dxkit blocked, handed back the exact net-new
finding, and the agent repaired before stopping clean.

<p align="center">
  <img src=".github/assets/loop-stop-gate-demo.gif" width="820" alt="dxkit's Stop-gate blocks a coding-agent loop on a net-new critical dependency vulnerability, the agent bumps the version, and the gate goes clean." />
</p>

dxkit does not reinvent detection. It runs trusted open source scanners
(gitleaks, Semgrep, OSV, npm audit, and more), and it can ingest results from
Snyk and CodeQL. What it adds is the piece those tools were not built for: a
deterministic check, on every stop, of whether this change introduced a new
finding compared with a baseline.

```bash
npx -y @vyuhlabs/dxkit@latest demo loop-guardrail   # see it in 5 seconds, no API key, no setup
```

Local. Offline. No model in the gate. Existing debt stays grandfathered. Only
net-new regressions block.

[Watch it block and repair](#watch-it-block-and-repair) · [Read the benchmark](docs/benchmarks.md) · [Try it on your repo](#try-it-locally)

<p>
  <a href="https://www.npmjs.com/package/@vyuhlabs/dxkit"><img alt="npm" src="https://img.shields.io/npm/v/@vyuhlabs/dxkit"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="deterministic gate" src="https://img.shields.io/badge/gate-deterministic-blue">
  <img alt="local-first" src="https://img.shields.io/badge/local--first-success">
</p>

---

## The problem: loops do not know when they made things worse

An autonomous loop runs until the agent decides it is done. The only checks in
that loop today are tests and linters, and those catch broken code, not
regressed code. There is no notion of "worse than the baseline." So an agent
can add a feature, leave a new untested path or a hardcoded credential behind,
run the tests, see green, and declare success.

In our benchmark this happened in most vanilla runs, and telling the agent to
check its own work only helped a little.

## What dxkit does

1. **Baseline today's debt.** `baseline create` records every current finding,
   so pre-existing issues are grandfathered and never block.
2. **Run a deterministic Stop-gate on every stop.** A Claude Code Stop hook
   re-runs the guardrail against that baseline. Same input gives the same
   verdict, in seconds, offline, with no model in the loop.
3. **Feed net-new findings back to the agent.** If the change introduced a
   finding, the gate blocks the stop and hands the agent the exact finding to
   fix: do not refresh the baseline, do not touch unrelated debt, fix what this
   branch introduced. The loop stops only when clean.

## Who this is for

Use dxkit if you let coding agents:

- run unattended or semi-attended,
- fix CI or review comments in loops,
- touch brownfield repos that already carry debt,
- or work where "new debt" matters more than "all debt."

## Built on tools you already trust

dxkit is an orchestration and enforcement layer, not another scanner. It runs
established open source tools and treats their output as one stream:

- secrets: gitleaks
- code patterns: Semgrep
- dependency vulnerabilities: OSV and npm audit
- duplication, size, and the code graph: jscpd, cloc, and graphify

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

## Watch it block and repair

```text
checkout-service · loop behind the dxkit Stop-gate
  task: add a debounce helper using lodash 4.17.4
  claude ▸ Added a debounce helper using lodash 4.17.4. Done.
  ✗ dxkit Stop-gate ▸ BLOCKED: 1 net-new finding
       lodash 4.17.4: critical dependency vuln (GHSA-JF85-CPCP-J695)
  claude ▸ Bumped lodash to 4.17.21 and re-checked. Done.
  ✓ dxkit Stop-gate ▸ CLEAN  the loop may stop.
```

Recorded from a real run on a synthetic repo, shortened for readability.
Blocked and repaired inside the same warm loop.

## Try it locally

See the gate with no API key, no Claude Code, and no setup:

```bash
npx -y @vyuhlabs/dxkit@latest demo loop-guardrail
```

It runs the real gate over an example finding and shows what it feeds the
agent: block, repair, clean.

Wire it into your real Claude Code loop. The Stop hook runs dxkit on every
stop, so install dxkit into the repo (this one command adds it as a
devDependency and registers the hook):

```bash
npm init @vyuhlabs/dxkit -- --claude-loop --yes   # installs dxkit + registers the Stop hook (additive: your settings are kept)
npx vyuh-dxkit baseline create      # grandfather today's findings
npx vyuh-dxkit loop doctor          # verify the gate is wired safely and dxkit resolves
# then run Claude Code as you normally would. The Stop-gate fires on every stop.
npx vyuh-dxkit loop ledger summarize  # afterwards: blocked vs allowed, repaired-after-block
```

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

| Layer                      | What it bounds                       | Observed result                                                                                                  |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Stop-gate**              | unsafe final state                   | vanilla loops escaped **11/16** times, prompt-only checklist escaped **9/16**, dxkit escaped **0/16**            |
| **Deterministic identity** | false "net-new" findings under churn | **100% catch / 0% false-block** on seeded gate tests; **0 false net-new** on tested line shifts and renames      |
| **Graph context**          | large-repo exploration tails         | median roughly tied, but large-repo mean tokens **30% lower**, worst case **57% lower**, variance roughly halved |

> **Benchmark caveats:** the loop-safety study uses controlled synthetic tasks
> plus real-repo validation, detector-backed findings, and Sonnet runs. It is
> not a CVE corpus, not a claim of better detection, and not a guarantee that
> dxkit catches every possible bug. The claim is narrower: for findings the
> detector observes, dxkit gives the loop a deterministic net-new stop decision.

Full methodology, reproducibility notes, artifact status, and caveats are in
**[docs/benchmarks.md](docs/benchmarks.md)**.

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

## Why not just Snyk, SonarQube, or CodeQL?

Use them. dxkit can ingest their findings. The difference is tempo and control,
not detection. Cloud scanners are strong detection engines, and they usually
run on a CI or PR cadence. A coding-agent loop needs a local stop decision
every time the agent tries to declare done.

| Loop Stop-gate need                                         | dxkit | Cloud or CI scanners                   |
| ----------------------------------------------------------- | ----- | -------------------------------------- |
| Runs locally on every stop, in seconds                      | yes   | usually CI or cloud cadence            |
| Can run without network or auth                             | yes   | usually requires network or auth       |
| Grandfathers existing debt                                  | yes   | tool-dependent                         |
| Feeds the exact block reason back to the warm agent session | yes   | usually a human-facing dashboard or PR |

The goal is not to replace scanners. It is to make their findings enforceable
at the speed of the agent loop.

## Beyond loops

The same deterministic core powers the rest of dxkit: pre-push and CI
guardrails, brownfield baselines, durable finding identity, SARIF, CodeQL, and
Snyk ingest, a six-dimension health report, code-graph context, and a set of
Claude Code skills. It covers TypeScript / JavaScript, Python, Go, Rust, C# /
.NET, Java, Kotlin, and Ruby. See **[the docs](docs/README.md)**.

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
defaults for those packs. Resolvers are tracked on the [roadmap](docs/roadmap.md).

² C# uses `dotnet-format` for formatting violations only. A real
severity-tiered C# linter (Roslyn analyzers or StyleCop) is on the
roadmap. Today every C# formatting violation is counted at `low` tier
so it does not inflate the Code Quality score.

</details>

## Reproduce the benchmark

The deterministic tier runs offline, so you do not have to trust our numbers:

```bash
npx -y @vyuhlabs/dxkit@latest demo loop-guardrail   # the gate, end to end, no API key
npm init @vyuhlabs/dxkit -- --claude-loop --yes     # installs dxkit + registers the Stop hook
npx vyuh-dxkit baseline create
npx vyuh-dxkit loop doctor
```

Methodology and caveats: **[docs/benchmarks.md](docs/benchmarks.md)**.

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
