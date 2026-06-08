---
name: dxkit-ingest
description: Bring an external interprocedural-SAST engine's findings (Snyk Code, CodeQL, or any SARIF) into dxkit so they're fingerprinted, baselined, guardrailed, graph-linked, and fixable. Use when the user says "ingest Snyk", "pull our Snyk Code findings", "import a SARIF file", "run CodeQL and bring it in", or asks why dxkit's SAST finds less than Snyk/CodeQL.
---

# dxkit-ingest

dxkit's bundled SAST (community semgrep) is **intraprocedural** — it cannot follow tainted data across function boundaries. The findings that dominate a Snyk Code or CodeQL report (path traversal, information exposure, SSRF, injection) are **interprocedural** and live outside that engine. This skill brings those findings INTO dxkit so they become first-class: fingerprinted, deduped against native findings, written to the baseline, enforced by the guardrail, linked to the code graph, and fixable through `dxkit-action`.

dxkit is not re-detecting — it's orchestrating. The detection engine stays whatever the customer can run; dxkit owns the governance + agentic-fix loop on top of it.

## Pick the engine (license-aware)

Run the resolver's logic before ingesting:

| Situation | Engine | Why |
|---|---|---|
| Customer already runs **Snyk** (any tier, incl. free) | **Snyk Code via REST** | Reads stored findings — consumes **no** Snyk test quota. Their own license. |
| **Open-source** repo | **CodeQL on-demand** | CodeQL's CLI is licensed for open source. |
| **Private** repo with **GitHub Advanced Security** | **CodeQL on-demand** | GHAS covers private-repo CodeQL. Confirm consent first. |
| Private repo, no GHAS, no Snyk | stay on community semgrep | No licensed interprocedural engine available. Don't run CodeQL on private code without GHAS. |

**Never run CodeQL against a non-public repo without confirming the user has GitHub Advanced Security.** dxkit prompts for this; honor it.

## Path A — ingest Snyk Code

```bash
# Token: a Snyk API token from Snyk → Account settings → API token.
# dxkit reads it from the ENVIRONMENT — it does NOT auto-load a .env file.
export SNYK_TOKEN=...        # in CI, add this once as a repo/org Actions secret
# org/project resolve from the flag, then .vyuh-dxkit.json, then the
# environment (SNYK_ORG_ID / SNYK_PROJECT_ID) — so an exported shell needs
# no flags. The project id is the project page URL in the Snyk UI.
npx vyuh-dxkit ingest --from-snyk --org <org-id> --project <project-id>
```

`--from-snyk` works on **every Snyk plan**, two ways:

- **REST API (quota-free)** — reads stored findings without consuming the
  org's Snyk Code test quota. But REST API access is a **Snyk Enterprise**
  entitlement; on Free/Team plans the read returns 403.
- **CLI fallback (free/team)** — on that 403 dxkit automatically falls back to
  `snyk code test` (the Snyk Code *product* entitlement that free includes),
  which writes SARIF dxkit ingests. This **does** cost one Snyk Code test from
  the quota per run, and only needs the org (no project id). Pass `--snyk-cli`
  to force this path and skip the REST attempt. dxkit installs the Snyk CLI on
  demand if it's missing.

So on a free-tier customer, `--from-snyk` "just works" — it tries REST, hits
403, and runs the CLI test. Either way it writes `.dxkit/external/snyk-code.json`.
**Commit it** — every developer and CI run then reads the findings WITHOUT a
token; only whoever runs `ingest` (ideally one CI refresh job) needs it.

If `SNYK_TOKEN` is unset, dxkit says so explicitly — `export` it (or set the CI
secret); it will not read a `.env` file for you.

## Path B — ingest a SARIF file (any engine)

For CodeQL, a Snyk SARIF export, Semgrep Pro, Bearer, or anything that emits SARIF 2.1.0:

```bash
npx vyuh-dxkit ingest --sarif results.sarif      # engine auto-detected from the SARIF
npx vyuh-dxkit ingest --sarif results.sarif --engine codeql   # or force the label
```

### Producing the SARIF with CodeQL (OSS / GHAS only)

CodeQL is heavy (~database build + analysis; tens of minutes). Run it on demand / in CI, never on the pre-push hook.

```bash
codeql database create db --language=javascript-typescript --source-root=.
codeql database analyze db \
  codeql/javascript-queries:codeql-suites/javascript-security-extended.qls \
  --format=sarifv2.1.0 --output=codeql.sarif
npx vyuh-dxkit ingest --sarif codeql.sarif
```

Compiled languages (Java, C#, Kotlin, Go) need a working build for CodeQL extraction; JS/TS, Python, Ruby do not.

## After ingesting — the loop

```
[1] Ingest        → .dxkit/external/<engine>.json (commit it)
[2] See them      → npx vyuh-dxkit vulnerabilities --graph-context
[3] Fix them      → hand off to dxkit-action (graph-linked: blast radius + callers)
[4] Lock the line → baseline picks them up; guardrail blocks net-new regressions
```

Ingested findings flow through the same aggregate as native findings, so they appear in the vulnerability report (with the engine as the `tool`), get a stable fingerprint, dedupe against any overlapping semgrep finding, and — with `--graph-context` — carry the enclosing symbol + blast radius the agent needs to fix safely. That graph enrichment is the part the source engine's own autofix doesn't have.

## Keeping it fresh (CI)

Add a scheduled refresh (mirrors `dxkit-baseline-refresh`): a CI job with the `SNYK_TOKEN` secret runs `ingest --from-snyk` and commits the updated snapshot. The bundled `--with-deep-sast-refresh` workflow (`workflow_dispatch`) does exactly this; its `method` input picks `api` (Enterprise, quota-free) or `cli` (free/team, one test per run). The ingested findings are a point-in-time snapshot of the engine's last scan — re-ingest after the engine re-scans.

## Hand-offs

- To fix the ingested findings → `dxkit-action` (it reads them like any code finding).
- For token / secret setup questions → `dxkit-config`.
- For the broader read→act→verify loop → `dxkit-reports` then `dxkit-action`.
