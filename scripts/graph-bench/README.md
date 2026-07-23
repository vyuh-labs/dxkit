# graph-bench — the graph-producer benchmark harness

The instrument behind the 4.1.5 graph decision (keep graphify, bump
0.8.40 → 0.9.25 — see PR #188 and the CHANGELOG entry). Re-running this
matrix is the **documented gate for any future graphify version bump**
(the tool-registry pin comment points here).

## Why the config and results are NOT in the repo

The harness code is committed; the benchmark **inputs and outputs are
deliberately local-only**:

- `tmp/graph-bench/bench-config.json` — the repo matrix. It lists local
  checkout paths, several of which are private customer repos; committed
  code never carries customer names (standing project rule). `tmp/` is
  gitignored.
- `tmp/graph-bench/results/` — captured graph.json artifacts, stats,
  sampling verdicts, and the per-release comparison records
  (`BUMP-COMPARISON.md`, `SAMPLING-VERDICT.md`, `BASELINE-NOTES.md`).

To reproduce, create your own config (shape below) pointing at whatever
repos you have locally — any mix of open-source validation repos across
the 10 language packs works:

```json
{
  "dxkitRoot": "/abs/path/to/dxkit-repo",
  "latestVenv": "~/.cache/dxkit/bench/graphify-<ver>-venv",
  "timeoutMinutes": 30,
  "repos": [{ "name": "nestjs-realworld", "path": "/abs/path", "stack": "ts-nestjs" }]
}
```

Create the "latest" venv (kept separate from the `~/.cache/dxkit/tools-venv`
the product uses):

```bash
uv venv <dir>
uv pip install --python <dir>/bin/python "graphifyy==<ver>"
```

## Usage

```bash
node scripts/graph-bench/bench.mjs run [--repo <name>] [--lanes pinned,latest]
node scripts/graph-bench/bench.mjs stats
node scripts/graph-bench/bench.mjs report        # markdown table
node scripts/graph-bench/sample.mjs [--k 40]     # precision sampling
```

Lanes: `pinned` = dxkit's shipped driver (`explore refresh` via
`dxkitRoot/dist`); `latest` = the configured graphify venv's own CLI.
Artifacts + timing land in `tmp/graph-bench/results/<repo>/<lane>/`.

`sample.mjs` answers "is a producer's node/edge advantage real signal or
inflation": it matches code-symbol nodes across lanes by (file, name),
then mechanically verifies random samples of every disagreement set
against source (token at claimed line ±3) and call edges at their
claimed call sites. Sampling is seeded — runs reproduce.

## Bump procedure (future graphify releases)

1. Install the candidate version into a fresh bench venv; update
   `latestVenv` in your config.
2. `run --lanes pinned,latest` across the matrix, then `stats`,
   `report`, `sample.mjs`.
3. Read the disagreement sets, not the raw counts — graphify indexes
   files dxkit deliberately excludes (build output, JSON configs), so
   totals overstate; the translator (`src/analyzers/tools/
graphify-translate.ts`) applies dxkit scoping.
4. Bump the pin in `tool-registry.ts` (+ the version-pins test), re-run
   the matrix against the new driver, and record a comparison note with
   every loss dispositioned before releasing.
