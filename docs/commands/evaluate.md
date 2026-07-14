# `vyuh-dxkit evaluate`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

A zero-write trial. `evaluate` replays your repo's recent landings (the
last few merged changes, or an explicit before/after ref pair) through
the same deterministic guardrail gate the hooks and CI would run, and
reports what the gate would have blocked plus what enabling dxkit costs
(measured gate latency, interruption rate, setup). It answers "would
dxkit help here, and what does it cost?" before you commit to installing
anything.

`evaluate` is an advisory replay, not a gate. It runs the trial in
disposable worktrees and writes nothing to your repository unless you
pass `--output`. Its exit code is always `0` on a completed trial, even
when a replayed landing would have been blocked. Scripts that want a
pass/fail signal read the JSON (`totals.blocked`) or run
[`guardrail check`](guardrail.md).

## Usage

```bash
vyuh-dxkit evaluate [path] [--last-prs <n>] [--base <ref> --head <ref>]
                    [--preset security-only|full-debt] [--json]
                    [--redact] [--output <file>]
```

With no flags it replays a default window of recent landings and prints
a terminal summary. Each landing takes roughly 30 seconds to a minute to
replay, so a small window returns in a couple of minutes.

## Flags

| Flag               | Effect                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `--last-prs <n>`   | Replay the last `n` merged changes (a positive integer)                                                 |
| `--base <ref>`     | Replay a single explicit before/after pair: the "before" ref                                            |
| `--head <ref>`     | The "after" ref of the explicit pair (paired with `--base`)                                             |
| `--preset <name>`  | Which findings block: `security-only` (default) or `full-debt`. Same presets as the loop Stop-gate      |
| `--json`           | Emit the versioned evidence document to stdout, for tooling                                             |
| `--redact`         | Strip finding evidence (locations, captured snippets) from the output, for sharing                      |
| `--untrusted`      | Treat the scanned source as attacker-controlled, matching a hosted PR gate's read-only scanner posture  |
| `--no-incremental` | Force a full scan on each replay instead of the diff-scoped default                                     |
| `--output <file>`  | Write the evidence JSON to a file (an explicit, user-requested write; the repo itself receives nothing) |
| `--verbose`        | Print per-tool timing to stderr                                                                         |
| `path`             | Repository to evaluate (defaults to the current directory)                                              |

## Examples

```bash
vyuh-dxkit evaluate                          # replay the default recent-landings window
vyuh-dxkit evaluate --last-prs 10            # replay the last 10 merged changes
vyuh-dxkit evaluate --base main~5 --head main  # one explicit before/after pair
vyuh-dxkit evaluate --preset full-debt       # also count test-gap + quality regressions
vyuh-dxkit evaluate --json --output trial.json # machine-readable evidence, saved to a file
```

## Related

- [`guardrail`](guardrail.md) is the gate `evaluate` replays; run it once you decide to adopt.
- [`baseline`](baseline.md) is the anchor the real gate diffs against after install.
- [`loop`](loop.md) shares the `security-only` / `full-debt` presets.
- The **dxkit-evaluate** skill drives the trial conversationally with Claude Code.
