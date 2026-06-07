# Why dxkit

dxkit does not try to replace SonarQube, Snyk, Semgrep, GitHub Advanced Security, Trivy, Gitleaks, or OSV-Scanner. It does three things they do not.

## 1. It assumes your repo is messy

Other code quality tools want clean codebases. Add them to a 5-year-old repo and they flag hundreds of pre-existing findings. The team disables the gate within a week, or accepts an endless "fix everything before we can ship" cleanup sprint.

dxkit captures today's findings as a baseline. From that moment forward, the gate fires only on net-new regressions. Existing debt is grandfathered. The team fixes old issues at their own pace. The gate stays useful because it stays reasonable.

This works the same on a day-one greenfield repo (baseline near zero, every regression matters from commit 1) and a 10-year-old brownfield repo (baseline locks in years of debt, only new problems block).

## 2. It gates deterministically

No LLM in the grading path. The score, the matcher, and the classifier are deterministic over normalized analyzer input. The same inputs produce the same outputs every time, across machines, across runs, across CI.

This matters specifically for AI-agent workflows. If the gate that decides whether to ship AI-generated code is itself an LLM, the agent can game the grader. A deterministic gate cannot be argued with. It is the only kind of stop signal that actually stops.

It also matters for compliance. Every deduction in the score is traceable to a specific finding from a specific tool, with a citation back to its methodology (CVSS for severity weighting, ratio thresholds for tests, etc.). Auditors can reproduce any score.

## 3. It scaffolds your AI agent

Most static analysis tools find issues and stop there. dxkit also writes the project-context layer that lets an AI agent operate intelligently on the codebase:

- `AGENTS.md` (open standard, read by Claude Code, Codex, Cursor, Aider)
- Twelve `dxkit-*` conversational skills for Claude Code that wrap the CLI into read, act, verify loops
- Per-stack devcontainer with the toolchain pre-installed
- A guardrail check that emits structured JSON the agent can self-verify against

The score, the baseline, the guardrail, and the skill flows form a closed loop. The agent reads the report. It acts on the findings. The guardrail verifies the action did not regress anything else. The agent self-stops when clean.

Without this loop, an AI agent fixing your code is doing it semi-blind. It cannot tell what is pre-existing versus net-new. It cannot verify its fix did not regress something else. It has no objective stop signal. dxkit provides all three.

## Open methodology

dxkit is built on open methodology. Every scoring decision references a public standard:

- ISO/IEC 25010 (product quality model)
- ISO/IEC 5055 (code quality measures)
- SQALE (technical debt evaluation)
- CVSS v4 (vulnerability severity, FIRST reference port included)
- CWE taxonomy
- OpenSSF Scorecard (project security posture)

Scores are evidence-backed and traceable to the findings that produced them. See [`docs/SCORING.md`](SCORING.md) for the per-dimension methodology and citations.

## 4. It orchestrates any detection engine — it doesn't compete with them

dxkit's bundled SAST is intraprocedural and won't match a proprietary interprocedural engine like Snyk Code or CodeQL on taint findings (path traversal, information exposure, SSRF, injection). dxkit's answer isn't to out-detect them — it's to **ingest** whatever engine you can run and own the layer on top:

- **Engine-agnostic.** `vyuh-dxkit ingest` takes Snyk Code (a quota-free REST read), CodeQL, or any SARIF, and makes those findings first-class — fingerprinted, deduped against native findings, baselined, and guardrailed.
- **Grounded in your code graph.** Ingested findings get blast radius + callers attached (`--graph-context`), so a fix targets the taint's source boundary and re-tests the right callers. That's context the source engine's own autofix doesn't have.
- **In your repo, in your loop.** Detection runs where it's licensed (your Snyk for private repos; CodeQL for open source / GHAS); enforcement and the agentic fix loop run locally. No lock-in to one vendor's platform.

Snyk and CodeQL _detect_; dxkit makes their output enforceable and fixable.

## What dxkit is not

- It is not a SaaS. Every scan runs locally. Nothing leaves the repo.
- It is not an LLM-graded code review tool. There is no LLM in the grading path.
- It is not a replacement for the underlying scanners. It runs gitleaks, semgrep, osv-scanner, jscpd, cloc, graphify, and per-ecosystem dep tools — and ingests interprocedural engines (Snyk Code, CodeQL) on top. It aggregates, deduplicates, and scores their output.
- It is not a one-size-fits-all gate. Three baseline modes (`committed-full`, `committed-sanitized`, `ref-based`) match different repo postures. Five typed allowlist categories handle per-finding exceptions. The brownfield policy is fully tunable via `.dxkit/policy.json`.

## See also

- [`README.md`](../README.md) for the product pitch and quick install
- [`docs/SCORING.md`](SCORING.md) for the deterministic scoring rubric
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the system design
- [`docs/roadmap.md`](roadmap.md) for what is shipped and what is planned
