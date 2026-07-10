# `.dxkit/policy.json`

The policy file controls which finding classifications block the
[`guardrail check`](../commands/guardrail.md), which warn, and the
confidence thresholds that demote low-quality matches to `uncertain`.

When a `.dxkit/policy.json` file exists at the repo root, `guardrail
check` auto-loads it. The `--policy <path>` flag overrides the
auto-discovery and points at an explicit file. When no policy is found,
the compiled-in defaults apply.

## When NOT to use this file

The policy file is for **broad-classification tuning** — "block on
every `added` finding," "warn on `tooling_drift`," etc. It applies
to all findings of a given classification.

For **per-finding suppression** — "suppress this specific finding
because it's a false positive / test fixture / mitigated externally"
— use the [allowlist](../commands/allowlist.md) instead. The
allowlist carries a typed category + required reason + (when
relevant) expiry per entry, and shows up in PR-comment review.
Per-finding decisions belong in the allowlist; classification-wide
tuning belongs here.

## Defaults

```json
{
  "mode": "brownfield",
  "block": ["added"],
  "warn": ["probable_existing", "newly_detected", "tooling_drift", "config_drift", "uncertain"],
  "confidence": {
    "critical": 0.75,
    "high": 0.8,
    "medium": 0.85,
    "low": 0.9
  },
  "blockRules": {
    "newSecret": true,
    "newCriticalSecurity": true,
    "newHighSecurity": true,
    "newCriticalDependencyVulnerability": true,
    "newHighReachableDependencyVulnerability": true,
    "newUntestedChangedSource": true,
    "newSevereQualityIssueInChangedFiles": true
  },
  "addedRequiresChangedLines": ["code", "hygiene"]
}
```

## Shape

| Key                         | Type           | Effect                                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                      | `"brownfield"` | Always `brownfield` in 2.5.0. Reserved for future greenfield-strict modes.                                                                                                                                                                                                                                          |
| `block`                     | `string[]`     | Finding statuses that fail the guardrail check (exit code 1).                                                                                                                                                                                                                                                       |
| `warn`                      | `string[]`     | Statuses that print a warning but don't fail.                                                                                                                                                                                                                                                                       |
| `confidence`                | `object`       | Per-severity match-confidence floor. A `relocated`/`persisted` pair below the floor is demoted to `uncertain`.                                                                                                                                                                                                      |
| `blockRules`                | `object`       | Per-finding-kind block overrides. Each `true` flag escalates the corresponding new finding to blocking.                                                                                                                                                                                                             |
| `addedRequiresChangedLines` | `string[]`     | Finding kinds whose `added` classification only blocks when the finding overlaps lines actually changed in the diff. Demotes scanner-wobble false positives to `uncertain` (warn).                                                                                                                                  |
| `baseline`                  | `object`       | Pin the baseline mode + ref repo-wide. See "Baseline mode pinning" below.                                                                                                                                                                                                                                           |
| `checks`                    | `object[]`     | Custom repo-invariant gates dxkit runs as first-class findings. See "Custom checks + lint gate" below and [`vyuh-dxkit checks`](../commands/checks.md).                                                                                                                                                             |
| `lint`                      | `object`       | Enable the pack-declared built-in lint gate. `{ enabled, blocking }`, both default `false`.                                                                                                                                                                                                                         |
| `largeFileThreshold`        | `number`       | Line count above which a source file is flagged `large-file` (default `500`). Applied once at gather time, so it drives the guardrail `large-file` finding, the "files over N lines" count, and the Quality + Maintainability scores together. A non-positive / non-numeric value is ignored (falls back to `500`). |
| `reports`                   | `object`       | Opt-in report snapshots on merge. See "Report snapshots on merge" below.                                                                                                                                                                                                                                            |

## Baseline mode pinning

The optional `baseline` block pins the on-disk posture used by
`baseline create` + `guardrail check` so every developer + CI job
agrees on the same shape. When absent, the resolver falls back to
visibility-derived defaults (`gh repo view --json visibility` →
`public` picks `ref-based`; everything else picks `committed-full`).

```json
{
  "baseline": {
    "mode": "ref-based",
    "ref": "origin/main"
  }
}
```

| Field       | Type     | Effect                                                                                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`      | `string` | `committed-full`, `committed-sanitized`, or `ref-based`. See [baseline modes](../commands/baseline.md#modes) for the disclosure trade-offs. |
| `ref`       | `string` | Git ref the guardrail diffs against in `ref-based` mode. Default: `origin/HEAD` probe (falls back to `origin/main`).                        |
| `anchor`    | `string` | Where a committed anchor is stored: `tree`, `branch`, or `cache`. See "Anchor transport" below. Auto-selected when omitted.                 |
| `anchorRef` | `string` | Branch that stores the anchor when `anchor` is `branch`. Default `dxkit-baselines`. Must NOT be a protection-covered branch.                |

CLI `--mode` / `--ref` flags override the policy fields.

### Anchor transport (committed modes)

The after-merge refresh keeps a committed anchor current. If the anchor lives on
your default branch and that branch is protected (dxkit's own onboarding
recommends requiring the guardrails check + PR review), a direct-push refresh
deadlocks — the push is rejected, and a `[skip ci]` commit can never earn the
required checks. `anchor` decouples the store from the protected branch so the
refresh stays fast and automated:

| Value    | Where the anchor lives                                                        | Use when                                                                          |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tree`   | committed on the default branch; refreshed by a direct push                   | the default branch is unprotected (direct pushes allowed)                         |
| `branch` | a separate unprotected branch (`anchorRef`); the check hydrates it from there | **default when the branch is protected** — no push to `main`, no PR, no deadlock  |
| `cache`  | the CI cache keyed by the base SHA; no git write at all                       | a rule protects _every_ branch (so even the side branch can't be pushed); CI-only |

Omit `anchor` and dxkit picks per your protection posture (`branch` on a
protected default branch, else `tree`; `tree` when protection can't be probed,
so it never silently reconfigures a repo). When the pick is `branch`, the
installer **records `anchor: "branch"` into this policy file** (non-clobber —
an explicit value always wins): the guardrail check reads the side-branch
anchor only when the committed policy says so, so the transport must live
where every consumer can see it, not just inside the workflow's content.
Commit the change. `ref-based` mode has no committed anchor, so no refresh
workflow is installed at all.

On the `branch` transport the side branch is written by ONE path —
`vyuh-dxkit baseline publish` (which the refresh workflow runs after
`baseline create --force`). It publishes `.dxkit/baselines/` to `anchorRef`
via git plumbing (no checkout, working tree untouched), skips the push when
the anchor already matches, and recreates the branch if it was deleted
(self-heal). Run it manually after a local `baseline create` to make the new
capture the one the guardrail reads.

Run `vyuh-dxkit doctor` to check whether your guardrail is actually _enforced_
(a required check on a protected branch) rather than merely wired, and
`vyuh-dxkit protect` (dry-run by default; `--apply` to write) to require the
`dxkit-guardrails` check + PR review.

## Custom checks + lint gate

A **custom check** is any repo command dxkit runs as a first-class gate
citizen — its failures are fingerprinted, baselined, and gated **net-new only**
(a pre-existing failure is grandfathered) exactly like secrets and SAST. Two
sources feed one seam:

```jsonc
{
  "checks": [
    { "name": "check:no-cross-layer-imports", "command": "node scripts/layers.js" },
    {
      "name": "eslint-strict",
      "command": "npx eslint --format unix src",
      "blocking": false,
      "parse": { "regex": "^(?<file>[^:]+):(?<line>\\d+)" },
    },
  ],
  "lint": { "enabled": true, "blocking": false },
}
```

- **`checks[]`** — user-declared invariants. `command` is a string or argv
  array; `blocking` (default `true`) sets block-vs-warn; `expectedExit`
  (default `0`) sets the passing exit code; `parse` is `"exit"` (BINARY — the
  whole command passes or fails) or `{ "regex": "…" }` (LOCATED — each matching
  line is a finding keyed on `file+line+rule`, so net-new lint errors block
  while the backlog is grandfathered).
- **`lint`** — the pack-declared built-in lint gate (eslint/ruff/golangci/…);
  see [language packs](language-packs.md#the-built-in-lint-gate). `enabled` and
  `blocking` both default `false`.

Both are opt-in and default-off (a repo configuring nothing spawns nothing),
and they gate in **committed/baseline mode** only. **Security:** the commands
are executed, so they come only from this committed file — the same trust
boundary as your npm scripts / CI config. The full model, the two finding
shapes, and troubleshooting live in [`vyuh-dxkit checks`](../commands/checks.md).

## Finding statuses

| Status              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `persisted`         | Same finding, same location — pre-existing debt                            |
| `relocated`         | Same finding, moved (line drift, file rename)                              |
| `removed`           | Was in baseline, no longer scanned                                         |
| `fixed`             | Intentionally suppressed via comment/ignore                                |
| `added`             | Net-new finding the developer just introduced                              |
| `tooling_drift`     | New on disk but the scanner version / ruleset changed                      |
| `config_drift`      | New on disk but `.dxkit-ignore` / dxkit config changed                     |
| `newly_detected`    | New but envelope signals can't tell whether tooling or developer caused it |
| `probable_existing` | Heuristic match below the confidence threshold                             |
| `uncertain`         | Below every threshold; manual review                                       |

## Block rules

The block-rules object captures the "block on any net-new X regardless
of confidence" policy lines. Set any flag to `false` to suppress.

| Flag                                      | Meaning                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `newSecret`                               | Block any newly-introduced secret (gitleaks finding)                |
| `newCriticalSecurity`                     | Block newly-introduced critical-severity code findings              |
| `newHighSecurity`                         | Block newly-introduced high-severity code findings                  |
| `newCriticalDependencyVulnerability`      | Block newly-introduced critical dep-vuln advisories                 |
| `newHighReachableDependencyVulnerability` | Block newly-introduced high-severity reachable dep-vulns            |
| `newUntestedChangedSource`                | Block when an untested source file appears alongside changed code   |
| `newSevereQualityIssueInChangedFiles`     | Block newly-introduced severe quality issues touching changed lines |

## Common customisations

### Permissive — let everything through (for early adoption)

```json
{ "block": [], "warn": ["added", "newly_detected"], "blockRules": {} }
```

### Stricter — block on every kind of drift

```json
{
  "block": ["added", "tooling_drift", "config_drift", "newly_detected"],
  "warn": ["probable_existing", "uncertain"]
}
```

### Tighten secret confidence

```json
{
  "confidence": { "critical": 0.85, "high": 0.85, "medium": 0.85, "low": 0.95 }
}
```

### Block every `added` finding regardless of diff overlap

The default policy demotes `added` `code` / `hygiene` findings to
`uncertain` (warn) when they sit outside lines changed by the current
diff — to suppress upstream scanner-wobble false positives. To restore
strict blocking on every `added` finding (useful when you control
scanner versions tightly and want maximum signal):

```json
{ "addedRequiresChangedLines": [] }
```

To extend the demotion to other wobble-prone kinds (`duplication` is
the most common candidate beyond `code` / `hygiene`):

```json
{ "addedRequiresChangedLines": ["code", "hygiene", "duplication"] }
```

### Report snapshots on merge

Publish a health/analysis snapshot to a dedicated `dxkit-reports` side branch on
every merge to the default branch, building a durable **score-over-time** trend
without committing anything to your default branch:

```json
{
  "reports": {
    "onMerge": true,
    "anchorRef": "dxkit-reports",
    "retain": { "history": 200, "snapshots": 20 }
  }
}
```

With `onMerge: true`, `vyuh-dxkit init`/`update` installs the
`dxkit-reports-refresh` workflow, which runs `report` then `report snapshot`
after each merge. Each run appends one line to `report-history.jsonl` and
refreshes the browsable `latest/` dashboard on the ref. Read the trend with
`vyuh-dxkit report history`. Storage rides the same anchor transport the baseline
refresh uses (git plumbing — no worktree, no default-branch write); the dedicated
ref keeps report churn off the baseline anchor. Manual: `vyuh-dxkit report
snapshot` publishes on demand; add `--dry-run` to preview.

### Tune the large-file threshold

By default a source file is flagged `large-file` above 500 lines. A repo
with a different house norm can raise or lower the bar:

```json
{ "largeFileThreshold": 800 }
```

The value is resolved once when metrics are gathered, so the same number
drives the guardrail `large-file` finding, the "files over N lines"
count, and the Quality + Maintainability dimension scores — they never
disagree. Because `large-file` identity is per-path (not line-based),
changing the threshold only changes _which_ files are flagged; it never
invalidates a baseline or allowlist.

## `loop.preset` — loop-scoped posture (not read by CI)

A repo running the [loop pack](../commands/loop.md) carries a separate
blocking posture under `loop.preset`:

```json
{ "loop": { "preset": "security-only" } }
```

| Preset                    | The Stop-gate blocks the loop on                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `security-only` (default) | net-new secrets + crit/high security + crit/high reachable dependency vulns; test-gap + quality only warn |
| `full-debt`               | every net-new finding, including test-gap + quality                                                       |

This key is read **only by the Stop-gate** (`vyuh-dxkit hook stop-gate`).
The CI / PR `guardrail check` ignores it and always uses the block/warn
policy above — so changing the loop posture never weakens your CI gate.
Set it here or via `vyuh-dxkit init --claude-loop --loop-preset <p>`.

### `loop.testCommand` — the postflight test command

After the guardrail passes, the Stop-gate can run the tests your change affects
and block completion if they fail. Configure that command durably here:

```json
{ "loop": { "testCommand": "pnpm test:int" } }
```

`DXKIT_LOOP_TEST_COMMAND` still works as a per-shell override and takes
precedence, but an env var is the easiest part of the loop config to silently
lose (per-shell, per-machine) — committing it to policy keeps it durable and
reviewable. `vyuh-dxkit loop doctor` shows which source (if any) supplied it.

## Loading order

1. `--policy <path>` flag on `guardrail check` (explicit)
2. `<cwd>/.dxkit/policy.json` (conventional; auto-discovered)
3. Compiled-in `DEFAULT_BROWNFIELD_POLICY` (no policy on disk)

Unknown fields in the JSON are preserved but ignored by the classifier
— future schema fields don't break older dxkit installations.

## See also

- [`guardrail check`](../commands/guardrail.md) — runs the classifier
- [`baseline`](../commands/baseline.md) — captures the anchor the matcher diffs against
