# `vyuh-dxkit vulnerabilities`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Deep security scan. Aliases: `vuln`. Produces a complete security
report — secrets, code patterns, dependency CVEs, TLS bypasses, and
remediation guidance.

## Usage

```bash
vyuh-dxkit vulnerabilities [path] [options]
vyuh-dxkit vuln [path]  # alias
```

## What gets scanned

| Source               | Tool                                                                                      | What it finds                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Secrets in source    | gitleaks (800+ patterns)                                                                  | hardcoded API keys, JWTs, private keys, etc.                                               |
| Static code patterns | semgrep `p/security-audit` ruleset                                                        | eval, SQLi, XSS, SSRF, CORS misconfig, more                                                |
| TLS bypass idioms    | per-pack regex (registry-driven)                                                          | `rejectUnauthorized: false`, `InsecureSkipVerify: true`, `OpenSSL::SSL::VERIFY_NONE`, etc. |
| Dependency CVEs      | npm-audit, pip-audit, osv-scanner, govulncheck, cargo-audit, depending on the active pack | upstream advisories with CVSS, KEV, EPSS enrichment                                        |
| Repo artifacts       | find/git                                                                                  | `.env` tracked in git, `.key`/`.pem` files on disk                                         |

## Options

| Option            | Effect                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--detailed`      | Write the detailed report + JSON                                                                                                                                                                                           |
| `--json`          | Stdout JSON                                                                                                                                                                                                                |
| `--no-save`       | Skip writing files                                                                                                                                                                                                         |
| `--graph-context` | Attach each finding's module + blast radius to the detailed report (needs a graph; fail-open — see [`context`](context.md))                                                                                                |
| `--attribute`     | Attach a "Who to ask" column (git blame → active-owner model; inactive authors routed to the current owner). Opt-in; names + @handles, never emails. Historical only — net-new findings are introduced by your own change. |

## Output

Three artifacts:

- `vulnerability-scan-<date>.md` — short summary
- `vulnerability-scan-<date>-detailed.md` — every finding with
  file/line attribution + EPSS + KEV + reachability + composite
  risk score
- `vulnerability-scan-<date>-detailed.json` — same data, machine
  readable; per-finding fingerprints for diff tooling

## Reading the report

The short report opens with a count summary:

```markdown
## Summary

- 0C 1H 3M 0L code findings (from semgrep + TLS-bypass registry)
- 2C 30H 23M 15L dependency findings (npm-audit + osv.dev enrichment)
- 0 hardcoded secrets
- 0 private key files
- 0 .env files tracked in git
```

Per-finding rows in detailed reports include:

```markdown
| CVE-ID   | Package@Version | Risk | Severity | Fix                |
| -------- | --------------- | ---: | -------- | ------------------ |
| GHSA-XXX | lodash@4.17.4   | 78.4 | HIGH     | upgrade to 4.17.21 |
```

`Risk` is a composite 0-100 score (CVSS × EPSS × KEV × reachability).
See [the scoring guide](../SCORING.md) for how the composite is computed.

## Capability-driven, not language-hardcoded

Each language pack contributes its own dependency scanner + TLS-bypass
patterns. Adding a new language pack auto-extends what
`vulnerabilities` covers — no changes here are needed.

If a pack's scanner isn't installed (`govulncheck` missing on a Go
repo), the report will say so explicitly via `toolsUnavailable` and
cap the Security score at 65/100 with a visible notice. Don't infer
"no vulnerabilities" from "no findings" — check the availability
section first.

## Performance

Most of the runtime is `semgrep` (registry rules + Python startup
overhead) and the per-pack dep-vuln scanner. Medium repo: 1-3 min.

## See also

- [`bom`](bom.md) — same data through a different lens (package-centric)
- [`health`](health.md) — Security dimension summary
