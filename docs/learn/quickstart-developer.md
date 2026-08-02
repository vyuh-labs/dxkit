# The gate blocked my PR. Now what?

Three minutes, four situations. Find yours.

First, read the verdict output (the CI job log, the PR comment, or run
`vyuh-dxkit guardrail check` locally). It names each finding, its kind, its
fingerprint, and why it gates. Everything below starts from that.

## 1. The finding is real and mine

Fix it and push. The gate compares your change against the baseline, so the
moment the finding is gone from your branch, the gate passes. Nothing to
clean up, nothing to ask anyone.

This is the common case, and it is the whole product working as intended.

## 2. It is a false positive

Suppress it on the record, in your PR:

```bash
vyuh-dxkit allowlist add --fingerprint=<id> --kind=<kind> \
  --category=false-positive --reason="<why this is not real>"
```

The fingerprint and kind are printed in the verdict output. The entry lands
in `.dxkit/allowlist.json` in your PR, so the reviewer sees the suppression
and the reason next to the change that needed it.

If several findings share one reason, batch them:
`--fingerprints=<id,id,...>` or pipe ids via `--from-stdin`.

## 3. It is real, but not fixable in this PR

Defer it, time-boxed:

```bash
vyuh-dxkit allowlist defer <fingerprint> \
  --reason="<why later>" --expires=+14d
```

The finding stops blocking until the expiry, then **re-blocks**. Default
expiry is 7 days. Deferral is visible to reviewers and auditable later
(`vyuh-dxkit allowlist audit`), so use an honest reason.

For a wave of blocking dependency advisories from the last check there is a
bulk form: `vyuh-dxkit allowlist defer --from-last-check --reason="..."`.
Other kinds are deliberately one-at-a-time.

## 4. The verdict is CANNOT GATE

Stop: this is not about your code. dxkit is telling you it cannot honestly
decide what your change introduced, and it refuses to guess. The output
names the exact cause and remedy. The common ones:

- **The baseline is stale or predates your merge-base.** Remedy: whoever
  maintains the repo re-captures (usually the baseline refresh workflow, or
  `vyuh-dxkit baseline create`). Your PR re-gates cleanly afterward.
- **A scanner version drifted** since the baseline was captured. Same
  remedy: re-capture. Your change is not blamed for a tool upgrade.

If you see CANNOT GATE repeatedly, tell your repo admin; the fix is on the
repo side, not in your PR.

## Local loop, before CI

Run the same gate CI runs:

```bash
vyuh-dxkit guardrail check
```

Exit 0 means CI's gate will agree with you. If the repo has git hooks
installed, pre-push already does this.

## One rule

Never "fix" a block by re-creating the baseline from your feature branch.
That absorbs your net-new finding into the record for everyone. The
baseline is maintained on the default branch by the refresh lane or the
repo admin; your tools are the fix itself, the allowlist, and deferral.
