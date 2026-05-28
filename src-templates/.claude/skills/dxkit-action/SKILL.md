---
name: dxkit-action
description: Read a dxkit report and execute fixes — prioritize findings by severity, plan the fix sequence, run the fix, verify the score moved, re-baseline if appropriate. Use when the user says "fix these findings", "act on the health report", "close out these vulnerabilities", or after dxkit-reports has surfaced something concrete.
---

# dxkit-action

This skill takes a dxkit report and drives the fix loop with the user. Reach for it after `dxkit-reports` has surfaced concrete findings.

## The action loop

```
[1] Read the report          → understand what's flagged
[2] Prioritize               → severity + reachability + blast radius + cost
[3] Plan                     → ordered list of edits
[4] Execute                  → fix one finding at a time
[5] Verify                   → re-run the analyzer, confirm score moved
[6] Decide on baseline       → commit fix or accept-as-baseline
```

Don't skip [5]. Re-running the analyzer is the only way to confirm the fix landed correctly.

For the richest input, read the **detailed** report with graph context attached:

```bash
npx vyuh-dxkit vulnerabilities --detailed --graph-context   # or test-gaps / quality
```

`--graph-context` adds a "Graph context" column (the module a finding lives in + its blast radius — how many files call into it) so you can plan the fix without separately discovering structure. It's a structural HINT, not ground truth — read "Graph context" below for how to use it safely.

## Priority order

Walk findings in this order (highest to lowest):

1. **CRITICAL** secrets (leaked credentials) — these are public-internet-facing. Stop everything and rotate.
2. **CRITICAL / HIGH** SAST findings in primary-architecture paths (controllers/handlers/services for backend; components/pages for frontend).
3. **CRITICAL / HIGH** dep-vulns with known exploits + a patched version available.
4. **HIGH** test-gap findings on primary-architecture files.
5. **MEDIUM** SAST / dep-vuln.
6. **LOW** anything (often defer to backlog).

Skip items where reachability is "no" (graphify can't find a call path) UNLESS the finding is a secret leak (those don't depend on reachability).

## Graph context (structural blast radius)

When the report was generated with `--graph-context`, each finding carries a "Graph context" cell: the module/role it belongs to and its **blast radius** (`role · N caller files`) — how many other files call into the finding's file. Use it to sharpen prioritization and planning, under three hard rules.

**1. Additive only — it never overrides severity or reachability.** Blast radius is a tie-breaker between findings of similar severity, not a re-ranking of the priority list above. Among two HIGH findings, fix the one with the larger blast radius first (more depends on it). A LOW finding never jumps a HIGH one because its blast radius is bigger.

**2. A blank or zero blast radius is NOT "safe to change".** The cell reads `blast radius n/a (call graph)` for languages whose call graph the analyzer can't resolve (C# is the known case — cross-assembly references aren't followed, so heavily-used files look like they have zero callers). Treat n/a — and even a literal `0 caller files` — as **unknown**, never as evidence the file is safe to edit freely. When blast radius is n/a, fall back to the module/role label (that part is reliable) and verify callers the normal way (grep / read) before a risky edit. Do **not** deprioritize a real finding just because its blast radius is empty.

**3. Confirm the symbol before you act on it.** The context may name an enclosing symbol (the function the finding sits in). It's a best-effort guess (the graph stores declaration lines, not end lines), so open the file and confirm the finding is actually inside that symbol before editing or writing a test against it.

Used within those rules, the win is concrete: a high blast radius tells you which caller files to re-check and re-test in step [5] after the fix, and the module label orients you fast. Same-name symbols can inflate the count — a suspiciously huge number is usually conflation, not reality.

## Common fix recipes

### Secret in code

```bash
# 1. Rotate the credential immediately (in the issuing provider's UI)
# 2. Remove the secret from the file
# 3. If the secret was committed: `git filter-repo` or BFG to scrub history
# 4. Re-scan to confirm gitleaks no longer reports it
npx vyuh-dxkit vulnerabilities --json | jq '.summary.findings'
```

Don't try to redact the secret in place — the git history still has it. Rotation is the only true fix.

If the "secret" is actually a placeholder in test code (e.g., `"sk_test_xxxxxxxxxxxx"` with no real credential value), confirm with the developer and allowlist via `dxkit-allow:test-fixture` — see "Allowlisting (when fix is not viable)" below.

### SAST finding (semgrep)

```bash
# 1. Read the finding's rule + line range from the report
# 2. Open the file, understand why semgrep flagged it
# 3. Either FIX (preferred) or ALLOWLIST (carefully — see below)
```

If the finding is a true false positive or intentional pattern (test fixture, mitigated externally), suppress via dxkit's allowlist — NOT via semgrep's `// nosemgrep:`. The dxkit allowlist is the canonical surface (single source of truth across every scanner), carries a typed category + reason, and is audit-trackable through `vyuh-dxkit allowlist audit`. See "Allowlisting (when fix is not viable)" below.

### Dependency vulnerability

```bash
# Find the patched version (osv-scanner / npm-audit / etc. report it)
npm install <pkg>@<patched-version>
# Re-run the scan
npx vyuh-dxkit vulnerabilities
```

For peer-dep conflicts: `npm install <pkg>@<patched-version> --legacy-peer-deps` (matches the post-create.sh fallback chain).

For Python: `pip install --upgrade <pkg>=<patched>` then re-pip-freeze. For Go: `go get <pkg>@<patched>` then `go mod tidy`. For Ruby: edit Gemfile, `bundle update <pkg>`. For Rust: `cargo update -p <pkg> --precise <patched>`.

If no patched version exists OR the upgrade breaks other constraints AND the risk is mitigated externally (network policy, WAF, runtime guard), allowlist with `category=mitigated-externally` and a reason describing the mitigation. If the team is accepting the risk while waiting on a fix, `category=accepted-risk` + an expiry tied to the fix deadline.

### Test gap

```bash
# 1. Read the source file the test-gap analyzer flagged
# 2. Write a test that exercises the file's primary contract
# 3. Run the test runner to confirm it passes
npm test  # or pytest, go test, cargo test, etc.
# 4. Re-run test-gaps to confirm the file dropped off the list
npx vyuh-dxkit test-gaps
```

Don't write tests that just import the module — write tests that exercise behavior. Useless tests inflate the count but don't move the dimension.

### Slop / code-pattern finding

```bash
# Read the slop check report at .dxkit/reports/
# Most slop hits are in committed AI-generated prose: README sections,
# CHANGELOG entries, doc comments. Rewrite by hand to remove the patterns.
```

If the finding is a false positive, add `// slop-ok: <reason>` on the offending line (or `# slop-ok` for non-JS).

## Allowlisting (when fix is not viable)

**Fix first.** The allowlist is the SECOND option, not the first. When you reach for it, choose deliberately — every allowlist entry is a future maintenance burden the customer's team will revisit.

Five typed categories signal WHY the suppression is in place:

| Category | Meaning | Where it lives |
|---|---|---|
| `false-positive` | Scanner is wrong about this code | Inline annotation OR file-level |
| `test-fixture` | Intentional pattern in a fixture / test file | Inline annotation OR file-level |
| `mitigated-externally` | Real risk but neutralized at runtime (WAF, env, etc.) | Inline annotation OR file-level |
| `accepted-risk` | Real risk, accepted by the team, signed off | File-level only (needs expiry + acknowledged severity) |
| `deferred` | Real, will fix later, tracked work | File-level only (needs expiry) |

`accepted-risk` and `deferred` require an `expiresAt` date because they describe assertions that should age out — by default the CLI sets 90 days. `false-positive`, `test-fixture`, and `mitigated-externally` describe assertions that don't naturally stale; they may omit expiry.

### The two surfaces

**Inline annotation** is the natural fit for source-anchored findings (secrets, code, config, dep-vuln, hygiene) with an inline-compatible category. The annotation lives next to the line it suppresses:

```python
api_key = "sk_test_xxxx"  # dxkit-allow:test-fixture reason="placeholder in unit test"
```

Or, for long source lines, above:

```typescript
// dxkit-allow:false-positive reason="regex matches intentional placeholder"
const apiKey = "sk_test_xxxx";
```

The grammar is uniform across every language; only the comment marker varies (`#` for python/ruby, `//` for typescript/go/rust/csharp/kotlin/java). Don't type it by hand — let dxkit insert it for you (see CLI below).

**File-level allowlist** lives at `.dxkit/allowlist.json` and is the surface for:

- Cross-file or whole-file findings (duplication, coverage-gap, test-gap, god-file, large-file, stale-file)
- Findings with no stable single-line attachment (dep-vuln, secret-hmac)
- Any `accepted-risk` or `deferred` suppression regardless of kind

### Add an allowlist entry (canonical path)

Don't hand-edit the annotation comment or the JSON file — let the CLI insert it correctly:

```bash
# Inline annotation at file:line — for source-anchored findings
# with an inline-compatible category
npx vyuh-dxkit allowlist add src/auth/oauth.ts:42 \
    --category=test-fixture --reason="placeholder in unit test"

# File-level entry — for everything else (kind + fingerprint required;
# both come straight from the guardrail check's output)
npx vyuh-dxkit allowlist add --fingerprint=a3f9c0e8b7d2e1f4 \
    --kind=dep-vuln --category=accepted-risk \
    --reason="WAF rule X mitigates this CVE" --expires=2026-08-22
```

The guardrail's block message gives you the exact command to paste for every blocked finding — file path + line for inline-compatible kinds, fingerprint + kind for everything else. Just copy-paste.

### When the finding only carries an id (sanitized / ref-based baseline)

If you're seeing a blocked finding labelled `<sanitized>` (in `baseline show` output) OR with no `file`/`line` columns in the PR-comment table, the repo's baseline mode is `committed-sanitized` or `ref-based` and the human-readable locator was stripped at write time. Two options:

- **Inspect the finding in the current scan.** The fingerprint pairs against the live scan's output, which is rich (always). Re-run the matching analyzer (`vyuh-dxkit vulnerabilities`, `vyuh-dxkit health`, etc.) and grep the JSON output for the fingerprint — that finding has full file:line context.
- **Allowlist by fingerprint anyway.** File-level allowlist entries only need fingerprint + kind, both of which the guardrail message still provides. The category + reason apply regardless of whether the locator is visible at baseline time.

The fingerprint contract is preserved across all three modes — `committed-full`, `committed-sanitized`, `ref-based` all produce the same identity bytes for the same finding. Sanitization only strips the human-readable rendering; it doesn't change which findings pair across runs.

### Review what's allowlisted

```bash
npx vyuh-dxkit allowlist list             # all entries (text)
npx vyuh-dxkit allowlist show <fingerprint>  # one entry's full detail
npx vyuh-dxkit allowlist audit            # expired / soon-to-expire / missing-rationale
npx vyuh-dxkit allowlist prune            # remove expired entries
```

Run `audit` periodically — `accepted-risk` and `deferred` entries that pass their expiry should either be re-justified (renew expiry) or pruned (remove the entry; the underlying finding will re-flag on the next scan).

### Stale annotations

If the underlying finding is fixed but the inline annotation lingers, the next scan emits a `stale-allow` finding pointing at the orphaned comment. The remediation is always to remove the annotation — dxkit refuses to allowlist a stale-allow finding (allowlisting the warning that an annotation is stale would defeat the entire model).

## Verification — never skip

After each fix:

```bash
# Re-run the SPECIFIC analyzer that flagged the finding
npx vyuh-dxkit vulnerabilities  # or quality / test-gaps / health
```

The fix is verified when:
- The specific finding fingerprint disappears from the report.
- The dimension score moves in the right direction.
- (Optional) The dashboard's diff view confirms the count dropped.

If the finding's still there: the fix didn't work, try again.

## Baseline decisions

Once a finding is processed (fixed, allowlisted, or accepted), the workflow depends on which path you took:

| Scenario | Action |
|---|---|
| Fix landed via a code change | Commit the code. Baseline + allowlist are unchanged. Future scans confirm the fix held. |
| Genuine false positive OR intentional pattern | `vyuh-dxkit allowlist add` with `category=false-positive` or `test-fixture`. Commit the annotation / allowlist file. Baseline is unchanged. |
| Real risk neutralized externally (WAF, runtime guard) | `vyuh-dxkit allowlist add` with `category=mitigated-externally` + a reason describing the mitigation. Baseline unchanged. |
| Real risk, accepted by team, won't fix | `vyuh-dxkit allowlist add` with `category=accepted-risk` + `--expires=YYYY-MM-DD` (defaults 90 days). Acknowledged-severity required for high/critical. |
| Real risk, will fix later (tracked work) | `vyuh-dxkit allowlist add` with `category=deferred` + `--expires=YYYY-MM-DD`. The expiry forces re-review when the deadline passes. |
| Fix landed via a config change (e.g., new entry in `.dxkit-ignore`) | Re-baseline: `npx vyuh-dxkit baseline create --force`. Commit both `.dxkit-ignore` and the new baseline. |
| Brownfield acceptance (the whole CURRENT state is known mess; future regressions must be net-new) | Re-baseline with an explicit reason in the commit message. Reserve this for the deliberate "draw a line here" moment, not per-finding suppression. |

**Prefer the allowlist over re-baselining for per-finding decisions.** The allowlist carries a typed category + reason + (when relevant) expiry; the baseline carries only "this finding was here." Future maintainers reading `vyuh-dxkit allowlist show <fingerprint>` see WHY the suppression is in place; reading the baseline file shows only that the finding existed at capture time. Per-finding decisions belong in the allowlist; codebase-wide brownfield acceptance belongs in the baseline.

**Never** re-baseline a finding silently — the commit message should explain why the regression is accepted. Future maintainers reading `git log .dxkit/baselines/` should see the rationale.

## Workflow guardrail

After fixing N findings, run the guardrail check before pushing:

```bash
npx vyuh-dxkit guardrail check
```

Exit 0 = your fixes didn't introduce any net-new regressions (you only removed/fixed things). Exit 1 = something new appeared; address that before pushing.

## When fixes get expensive

Sometimes the right call is: don't fix, allowlist (or re-baseline if it's brownfield-wide).

Examples:
- Legacy code on a deprecation path (sunset > fix) → `accepted-risk` with expiry matching the sunset date
- A SAST finding in vendored code you don't maintain → `mitigated-externally` if the vendor patches separately, else `accepted-risk`
- A test gap on a one-off script that doesn't merit tests → `accepted-risk`
- An import line flagged by a scanner that you've reviewed and confirmed safe → `false-positive` inline annotation at the import

In those cases: `vyuh-dxkit allowlist add` is the right tool for per-finding decisions (typed reason + expiry where relevant). Reserve "accept as baseline" for the deliberate one-shot brownfield moment ("this entire current state is known mess; today's findings are the new baseline"). The two surfaces complement each other — allowlist for individual judgment calls, baseline for the codebase-wide line in the sand.

## Hand-offs

- For ignore-file edits as part of a fix → `dxkit-config` skill
- For hook-related issues during a fix push → `dxkit-hooks` skill
- For re-running reports between fixes → `dxkit-reports` skill
- For broken dxkit install (hooks not firing, vyuh-dxkit not on PATH) → `dxkit-fix` skill
- For allowlist management beyond the per-finding `add` path (auditing existing entries, pruning expired ones, reviewing the team's overall suppression posture) → run `npx vyuh-dxkit allowlist audit` / `list` / `prune` directly; no separate skill yet
