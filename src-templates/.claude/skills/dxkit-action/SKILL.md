---
name: dxkit-action
description: Read a dxkit report and execute fixes — prioritize findings by severity, plan the fix sequence, run the fix, verify the score moved, re-baseline if appropriate. Use when the user says "fix these findings", "act on the health report", "close out these vulnerabilities", or after dxkit-reports has surfaced something concrete.
---

# dxkit-action

This skill takes a dxkit report and drives the fix loop with the user. Reach for it after `dxkit-reports` has surfaced concrete findings.

## The action loop

```
[1] Read the report          → understand what's flagged
[2] Prioritize               → severity + reachability + cost
[3] Plan                     → ordered list of edits
[4] Execute                  → fix one finding at a time
[5] Verify                   → re-run the analyzer, confirm score moved
[6] Decide on baseline       → commit fix or accept-as-baseline
```

Don't skip [5]. Re-running the analyzer is the only way to confirm the fix landed correctly.

## Priority order

Walk findings in this order (highest to lowest):

1. **CRITICAL** secrets (leaked credentials) — these are public-internet-facing. Stop everything and rotate.
2. **CRITICAL / HIGH** SAST findings in primary-architecture paths (controllers/handlers/services for backend; components/pages for frontend).
3. **CRITICAL / HIGH** dep-vulns with known exploits + a patched version available.
4. **HIGH** test-gap findings on primary-architecture files.
5. **MEDIUM** SAST / dep-vuln.
6. **LOW** anything (often defer to backlog).

Skip items where reachability is "no" (graphify can't find a call path) UNLESS the finding is a secret leak (those don't depend on reachability).

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

### SAST finding (semgrep)

```bash
# 1. Read the finding's rule + line range from the report
# 2. Open the file, understand why semgrep flagged it
# 3. Either FIX (preferred) or SUPPRESS (carefully)
```

Suppression is `// nosemgrep: <rule-id>` on the offending line. Use sparingly — every suppression is a future maintenance burden. Better: fix the underlying issue.

### Dependency vulnerability

```bash
# Find the patched version (osv-scanner / npm-audit / etc. report it)
npm install <pkg>@<patched-version>
# Re-run the scan
npx vyuh-dxkit vulnerabilities
```

For peer-dep conflicts: `npm install <pkg>@<patched-version> --legacy-peer-deps` (matches the post-create.sh fallback chain).

For Python: `pip install --upgrade <pkg>=<patched>` then re-pip-freeze. For Go: `go get <pkg>@<patched>` then `go mod tidy`. For Ruby: edit Gemfile, `bundle update <pkg>`. For Rust: `cargo update -p <pkg> --precise <patched>`.

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

Once a finding is fixed AND verified gone, the workflow depends on what changed:

| Scenario | Action |
|---|---|
| Fix landed via a code change | Commit the code. Baseline is unchanged. Future scans confirm the fix held. |
| Fix landed via a config change (e.g., new entry in `.dxkit-ignore`) | Re-baseline: `npx vyuh-dxkit baseline create --force`. Commit both `.dxkit-ignore` and the new baseline. |
| Finding accepted as known + not blocking | Re-baseline with explicit reason in the commit message. Future scans treat it as pre-existing, not net-new. |
| Finding is genuinely a false positive | First try suppression on the offending line. If you can't suppress, re-baseline. |

**Never** re-baseline a finding silently — the commit message should explain why the regression is accepted. Future maintainers reading `git log .dxkit/baselines/` should see the rationale.

## Workflow guardrail

After fixing N findings, run the guardrail check before pushing:

```bash
npx vyuh-dxkit guardrail check
```

Exit 0 = your fixes didn't introduce any net-new regressions (you only removed/fixed things). Exit 1 = something new appeared; address that before pushing.

## When fixes get expensive

Sometimes the right call is: don't fix, accept as baseline.

Examples:
- Legacy code on a deprecation path (sunset > fix)
- A SAST finding in vendored code you don't maintain
- A test gap on a one-off script that doesn't merit tests

In those cases: accept-as-baseline with a commit message explaining the call. dxkit's baseline IS designed to support this — the brownfield contract is "today's mess is acknowledged; tomorrow's must be a real improvement." Use it.

## Hand-offs

- For ignore-file edits as part of a fix → `dxkit-config` skill
- For hook-related issues during a fix push → `dxkit-hooks` skill
- For re-running reports between fixes → `dxkit-reports` skill
