# `.dxkit/policy.json`

The policy file controls which finding classifications block the
[`guardrail check`](../commands/guardrail.md), which warn, and the
confidence thresholds that demote low-quality matches to `uncertain`.

When a `.dxkit/policy.json` file exists at the repo root, `guardrail
check` auto-loads it. The `--policy <path>` flag overrides the
auto-discovery and points at an explicit file. When no policy is found,
the compiled-in defaults apply.

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
  }
}
```

## Shape

| Key          | Type           | Effect                                                                                                         |
| ------------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| `mode`       | `"brownfield"` | Always `brownfield` in 2.5.0. Reserved for future greenfield-strict modes.                                     |
| `block`      | `string[]`     | Finding statuses that fail the guardrail check (exit code 1).                                                  |
| `warn`       | `string[]`     | Statuses that print a warning but don't fail.                                                                  |
| `confidence` | `object`       | Per-severity match-confidence floor. A `relocated`/`persisted` pair below the floor is demoted to `uncertain`. |
| `blockRules` | `object`       | Per-finding-kind block overrides. Each `true` flag escalates the corresponding new finding to blocking.        |

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

## Loading order

1. `--policy <path>` flag on `guardrail check` (explicit)
2. `<cwd>/.dxkit/policy.json` (conventional; auto-discovered)
3. Compiled-in `DEFAULT_BROWNFIELD_POLICY` (no policy on disk)

Unknown fields in the JSON are preserved but ignored by the classifier
— future schema fields don't break older dxkit installations.

## See also

- [`guardrail check`](../commands/guardrail.md) — runs the classifier
- [`baseline`](../commands/baseline.md) — captures the anchor the matcher diffs against
