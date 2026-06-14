---
name: dxkit-allowlist
description: Manage the dxkit allowlist over its whole lifecycle — list, inspect, audit (including orphaned entries after a re-baseline), remove stale entries, prune expired ones, and export Snyk-originated suppressions to a .snyk policy. Use when the user says "review our allowlist", "what suppressions do we have", "this allowlist entry is stale", "remove this fingerprint", "the allowlist drifted after re-baselining", "audit our accepted-risk entries", or "push our Snyk ignores back to Snyk". For the fix-vs-suppress DECISION and adding a new entry, defer to dxkit-action.
---

# dxkit-allowlist

The allowlist is dxkit's per-finding suppression surface: a reviewed finding that the team has categorized (`false-positive`, `test-fixture`, `mitigated-externally`, `accepted-risk`, `deferred`) with a reason, so the guardrail lets it pass on future runs. It's the single source of truth across every scanner — native semgrep/gitleaks and ingested Snyk Code / CodeQL findings alike, all keyed on one fingerprint.

### Categories affect the score, not just the guardrail

The category isn't just a label — it decides whether the finding still counts toward the **Security score**:

- **`false-positive` / `test-fixture`** declare the finding is *not a real finding* (a scanner misfire, or throwaway test data). These are **lifted from the Security penalties and caps**, so a repo that has genuinely triaged its noise scores honestly instead of staying capped on findings it has already reviewed and accepted. This is also why test-file secrets (which dxkit never auto-downgrades by path) should be allowlisted as `test-fixture` once confirmed fake — that's what removes them from the score.
- **`accepted-risk` / `deferred` / `mitigated-externally`** accept a *real* exposure. The guardrail stops blocking, but the score keeps counting them — accepting a real risk can't earn an A. (`accepted-risk` / `deferred` also require an expiry so the acceptance ages out.)

So `false-positive`/`test-fixture` are the only categories that recover score. Reserve them for findings that genuinely aren't real — miscategorizing a real risk as `false-positive` to lift the score is exactly the self-deception the typed categories exist to prevent.

This skill manages the allowlist's **lifecycle**: reviewing what's there, keeping it honest, and propagating decisions outward. For the upstream question — *should this be fixed instead of suppressed, and how do I add an entry* — that decision and the `add` path live in **dxkit-action**. Fix first; suppress second.

## The lifecycle at a glance

```
add ──▶ list / show ──▶ audit ──▶ { renew | remove | prune } ──▶ export --snyk
(dxkit-action)  inspect    keep honest   clean up                 propagate to Snyk
```

## Review what's suppressed

```bash
npx vyuh-dxkit allowlist list                # every entry (text); --json for structured
npx vyuh-dxkit allowlist show <fingerprint>  # one entry's full detail
```

Reading is always safe — no mutation. Use these to brief the team on the overall suppression posture before a release or audit.

## Audit — keep the allowlist honest

```bash
npx vyuh-dxkit allowlist audit                      # expired / soon-to-expire / missing-rationale
npx vyuh-dxkit allowlist audit --soon-days=30       # widen the soon-to-expire window
npx vyuh-dxkit allowlist audit --against-baseline   # ALSO flag orphaned entries
```

`audit` partitions entries into actionable buckets:

- **expired** — past their `expiresAt`. The suppression no longer applies; the finding will re-flag on the next scan. Prune or renew.
- **soon-to-expire** — within the window (default 14 days). `accepted-risk` / `deferred` entries approaching expiry should be re-justified or removed.
- **missing-rationale** — no reason on the entry (only happens in sanitized mode when the gitignored reasons sidecar is absent).
- **orphaned** — *only with `--against-baseline`*. The entry's fingerprint matches no finding in the committed baseline.

### Orphaned entries — flag, never bulk-remove

`--against-baseline` reads the committed baseline and reports entries whose fingerprint isn't present in the current finding set (it counts both each finding's own fingerprint and any cross-tool fingerprints absorbed into it, so an entry keyed on a collapsed contributor is *not* falsely flagged).

**An orphan is not automatically stale.** Two things produce orphans:

1. **The finding is genuinely gone** (fixed, file deleted) → the entry is dead weight; remove it.
2. **Re-baselining churned the fingerprint** — semgrep is nondeterministic run-to-run, and cross-tool dedup can shift which tool's fingerprint represents a merged finding. The suppressed finding may still exist intermittently. Removing the entry would let it block a future PR.

So treat the orphaned bucket as a **review queue**: confirm each finding is truly gone (re-run the analyzer and check the fingerprint is absent), *then* remove. Never script a bulk-remove of the orphaned set.

## Remove a single entry

```bash
npx vyuh-dxkit allowlist remove <fingerprint>
```

Deletes one file-level entry. Use this for a confirmed-orphaned entry, or any stale-but-unexpired entry (which `prune` won't touch — `prune` removes only *expired* entries). No more hand-editing `.dxkit/allowlist.json`.

## Prune expired entries

```bash
npx vyuh-dxkit allowlist prune --dry-run   # preview what would go
npx vyuh-dxkit allowlist prune             # remove all expired entries
```

`prune` is the bulk counterpart to `remove`, scoped to expired entries only (those are unambiguously inactive). Run it periodically; renew anything still relevant before pruning.

## The re-baseline → re-point flow (self-serve)

After a baseline refresh, some fingerprints churn and a few valid suppressions orphan. The self-serve recovery:

```bash
npx vyuh-dxkit allowlist audit --against-baseline   # 1. discover orphans
# 2. for each orphan: re-run the analyzer, confirm the finding is truly gone
npx vyuh-dxkit vulnerabilities                      #    (grep output for the fingerprint)
npx vyuh-dxkit allowlist remove <fingerprint>       # 3a. gone → remove
npx vyuh-dxkit allowlist add --fingerprint=<new> …  # 3b. churned → re-point to the new fp (see dxkit-action)
```

> **Refresh the baseline in CI, not on your laptop.** A local `baseline create --force` bakes your machine's scanner versions into the committed baseline, which produces spurious tooling-drift warnings and phantom "resolved" findings on the next PR — and *causes* exactly this fingerprint churn. Use the bundled `dxkit-baseline-refresh` workflow (workflow_dispatch) so the canonical baseline is captured with CI's scanner versions. See **dxkit-ingest** for the refresh-job pattern.

## Export to Snyk — propagate suppressions outward

```bash
npx vyuh-dxkit allowlist export --snyk            # writes ./.snyk
npx vyuh-dxkit allowlist export --snyk --out=path/to/.snyk
```

When the team allowlists a **Snyk-originated** finding (one ingested via `dxkit-ingest`, `tool: snyk-code`), the decision lives only in dxkit by default — Snyk's own gate (`snyk code test`, the Snyk UI) still reports it as open. `export --snyk` closes that loop: it writes a `.snyk` policy ignoring every Snyk Code finding that maps to an *active* allowlist entry, keyed on the Snyk rule id + path, carrying the entry's reason + expiry. Expired entries are skipped; native semgrep/gitleaks findings don't export (no Snyk equivalent).

This is the outbound mirror of the inbound sync dxkit already does (it honors Snyk's SARIF `result.suppressions` at ingest). The two are round-trip stable — an exported ignore re-read from Snyk's SARIF is suppressed, not double-counted.

**Prerequisite:** Snyk Code (SAST) honors `.snyk` ignores only when the org has Snyk's "consistent ignores" feature enabled; SCA/dependency ignores are standard. Commit the `.snyk` so it applies in CI. It's opt-in — if dxkit is the only gate, you don't need it.

## Stale inline annotations

Inline `dxkit-allow:` annotations are a different surface (source-anchored, managed by `dxkit-action`'s `add` path). If the underlying finding is fixed but the annotation lingers, the next scan emits a `stale-allow` finding pointing at the orphaned comment. The fix is always to delete the comment — dxkit refuses to allowlist a stale-allow.

## Hand-offs

- For the **fix-vs-suppress decision** and **adding** a new entry (inline or file-level, the typed-category table, the canonical `add` path) → **dxkit-action**.
- For **ingesting** Snyk/CodeQL findings in the first place, and the **CI baseline/deep-SAST refresh** jobs → **dxkit-ingest**.
- For **ignore-file** (`.dxkit-ignore`) edits and policy tuning → **dxkit-config**.
- For a **broken install** (guardrail not firing, command not found) → **dxkit-fix**.
