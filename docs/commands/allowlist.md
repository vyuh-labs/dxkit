# `vyuh-dxkit allowlist`

Per-finding suppression with a typed-category audit trail. The
allowlist is dxkit's deliberate escape hatch for findings you can't
fix today: false positives, intentional test-fixture patterns, real
risks mitigated externally, or work you're deferring with an
explicit deadline.

The principle: **easier than disabling dxkit, harder than actually
fixing the issue.** Every allowlist entry carries a typed category,
a required reason, and (when relevant) an expiry. Reviewers see new
entries in the PR comment automatically; the `audit` subcommand
surfaces stale + soon-to-expire entries for periodic cleanup.

## When to use this command

Use the allowlist when fixing isn't viable today and the finding
deserves explicit acknowledgement rather than silent suppression.
Common scenarios:

- **False positive**: the scanner is wrong about this specific
  finding. Allowlist with `category=false-positive` + a reason
  describing why. Bonus: consider reporting the false positive via
  [`vyuh-dxkit issue`](./issue.md) so the team can improve the rule.
- **Intentional test fixture**: the "secret" is a placeholder API
  key in a test file, or the SAST finding is in a deliberately-bad
  example. Allowlist with `category=test-fixture`.
- **Mitigated externally**: a dep-vuln is real but the attack vector
  is blocked by a WAF rule, network policy, or runtime guard.
  Allowlist with `category=mitigated-externally` + a reason
  describing the mitigation.
- **Accepted risk**: the team has reviewed the finding and accepts
  it for now. Allowlist with `category=accepted-risk` + an explicit
  `--expires` date. The expiry forces re-review when the deadline
  passes.
- **Deferred fix**: the work is tracked elsewhere (a ticket, a
  next-sprint plan). Allowlist with `category=deferred` + an
  `--expires` matching the deadline.

If you find yourself reaching for the allowlist many times for the
same scanner rule, that's signal — open a `--type=false-positive`
or `--type=missing-finding` issue (see [`vyuh-dxkit issue`](./issue.md))
so the team can tune the underlying detection.

## The five categories

| Category               | Meaning                                    | Expiry       | Surfaces                        |
| ---------------------- | ------------------------------------------ | ------------ | ------------------------------- |
| `false-positive`       | Scanner is wrong about this finding        | Optional     | Inline annotation OR file-level |
| `test-fixture`         | Intentional pattern in fixture / test code | Optional     | Inline annotation OR file-level |
| `mitigated-externally` | Real risk but neutralized at runtime       | Optional     | Inline annotation OR file-level |
| `accepted-risk`        | Real risk, team accepts, signed off        | **Required** | File-level only                 |
| `deferred`             | Real, will fix later, tracked work         | **Required** | File-level only                 |

`accepted-risk` and `deferred` require an expiry because they
describe assertions that should age out. By default the CLI sets
`--expires` to 90 days from today (industry convention, matches
Snyk / Dependabot).

## The two surfaces

### Inline annotation

For source-anchored findings (secrets, code patterns, config
issues, hygiene markers, dep-vuln imports) with an inline-compatible
category. The annotation lives next to the line it suppresses:

```python
api_key = "sk_test_xxxx"  # dxkit-allow:test-fixture reason="placeholder in unit test"
```

Or above for long source lines:

```typescript
// dxkit-allow:false-positive reason="regex matches intentional placeholder"
const apiKey = 'sk_test_xxxx';
```

The annotation grammar is uniform across every language; only the
comment marker varies (`#` for python/ruby, `//` for typescript/go/
rust/csharp/kotlin/java). Don't type it by hand — let the CLI
insert it for you (see `allowlist add` below).

### File-level allowlist (`.dxkit/allowlist.json`)

For everything else:

- Cross-file or whole-file findings (`duplication`, `coverage-gap`,
  `test-gap`, `god-file`, `large-file`, `stale-file`)
- Findings with no stable single-line attachment (`dep-vuln`,
  `secret-hmac`)
- Any `accepted-risk` or `deferred` suppression, regardless of kind
  (those categories need expiry + sign-off, which inline
  annotations can't carry)

The file is committed to git so the team's suppression posture is
reviewable in PRs. In **sanitized** mode (the default for public
repos), the file carries only `fingerprint + kind + category`; the
human-readable reason + addedBy live in a gitignored sidecar
(`.dxkit/allowlist-reasons.local.json`).

## Subcommands

### `add` — create a new suppression

```bash
# Inline annotation at file:line — for source-anchored findings
# with an inline-compatible category
vyuh-dxkit allowlist add src/auth/oauth.ts:42 \
    --category=test-fixture \
    --reason="placeholder in unit test"

# File-level entry — for any kind + category not eligible for
# inline (or when you want the entry persisted to .dxkit/allowlist.json)
vyuh-dxkit allowlist add \
    --fingerprint=a3f9c0e8b7d2e1f4 \
    --kind=dep-vuln \
    --category=accepted-risk \
    --reason="WAF rule X mitigates this CVE" \
    --expires=2026-08-22

# Acknowledge severity explicitly for accepted-risk on high/critical
vyuh-dxkit allowlist add \
    --fingerprint=a3f9c0e8b7d2e1f4 \
    --kind=secret \
    --category=accepted-risk \
    --acknowledged-severity=high \
    --reason="..."
```

**Tip**: the guardrail check's block message prints the exact
`allowlist add` command to paste for every blocked finding. Use the
guardrail output directly rather than constructing the command by
hand.

### `list` — review every entry

```bash
vyuh-dxkit allowlist list             # text table
vyuh-dxkit allowlist list --json      # structured JSON
```

### `show` — inspect one entry

```bash
vyuh-dxkit allowlist show <fingerprint>
vyuh-dxkit allowlist show <fingerprint> --json
```

### `audit` — find stale + soon-to-expire entries

```bash
vyuh-dxkit allowlist audit               # default: 14-day soon window
vyuh-dxkit allowlist audit --soon-days=30
vyuh-dxkit allowlist audit --json
```

Three buckets:

- **Expired** — entries past `expiresAt`. Run `prune` to remove.
- **Soon to expire** — within `--soon-days` (default 14). Either
  re-justify (extend expiry) or remove (let the underlying finding
  re-flag on the next scan).
- **Missing rationale** — entries with empty `reason` field. In
  full mode this should never happen; in sanitized mode it means
  the gitignored reasons sidecar isn't synced locally.

### `prune` — remove expired entries

```bash
vyuh-dxkit allowlist prune              # default: removes expired entries
vyuh-dxkit allowlist prune --dry-run    # preview without writing
vyuh-dxkit allowlist prune --json       # structured envelope
```

## Stale annotations (the strict-cleanup loop)

If you allowlist a finding inline, then later fix it (or the
scanner stops flagging it), the orphaned annotation becomes a
`stale-allow` finding on the next scan. Remediation is always the
same: **remove the orphaned `dxkit-allow:` comment**. The allowlist
explicitly refuses to suppress `stale-allow` findings — allowing the
"please clean up your annotations" warning would defeat the whole
strict-cleanup model.

This pattern is borrowed from TypeScript's `@ts-expect-error`: tools
that surface their own stale suppressions force the dev to clean up,
preventing the annotation graveyard pattern common to less strict
tools.

## How reviewers see new entries

The `dxkit-guardrails.yml` workflow (installed by
`vyuh-dxkit init --with-ci`) posts a PR comment with the guardrail
report. The comment now includes an **"Allowlist activity"**
section listing every entry added (or removed) on this branch
versus the baseline commit:

```
### Allowlist activity (1)

Suppressions changed between baseline @ a3f9c0e8 and current.
Review each entry's category + reason + expiry before approving.

**Added (1)** — new suppressions on this branch:

| Fingerprint | Kind | Category | Expires | Reason |
|---|---|---|---|---|
| `a3f9c0e8b7d2e1f4` | dep-vuln | accepted-risk | 2026-08-22 | WAF rule X mitigates this CVE |
```

Reviewers see the suppressions being introduced and can sanity-check
the typed category + reason + expiry before approving — the social-
review pressure that keeps the allowlist healthy.

## Reporting a false positive upstream

When you allowlist with `category=false-positive`, consider also
opening an issue against dxkit so the team can fix the underlying
detection:

```bash
vyuh-dxkit issue --type=false-positive --fingerprint=<id> \
    --about="the scanner flags my intentional X as a Y"
```

See [`vyuh-dxkit issue`](./issue.md) for full details.

## Related

- [`vyuh-dxkit guardrail check`](./guardrail.md) — blocks PRs on new findings; allowlist suppresses individual findings
- [`vyuh-dxkit baseline create`](./baseline.md) — locks in the codebase-wide brownfield acceptance; the allowlist is the per-finding cousin
- [`vyuh-dxkit issue`](./issue.md) — report a false positive / bug / feature request to the dxkit team
- Configuration: [`.dxkit/policy.json`](../configuration/policy.md) — broad-classification tuning; the allowlist handles per-finding suppression
