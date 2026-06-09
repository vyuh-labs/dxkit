# `vyuh-dxkit test-gaps`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Ranks untested source files by **risk tier** — surfaces what to test
next, not just what's untested. CRITICAL findings first.

## Usage

```bash
vyuh-dxkit test-gaps [path] [options]
```

## Options

| Option            | Effect                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--detailed`      | Write detailed report (every untested file with classification rationale)                                                                                         |
| `--with-coverage` | Materialize real coverage data before scoring (Istanbul, coverage.py, JaCoCo, …)                                                                                  |
| `--json`          | Stdout JSON                                                                                                                                                       |
| `--no-save`       | Skip files                                                                                                                                                        |
| `--graph-context` | Attach each gap file's module + blast radius to the detailed report (a high-blast-radius untested file is higher-stakes; fail-open — see [`context`](context.md)) |
| `--attribute`     | Attach a "Who to ask" column (each untested file's current owner, via the active-owner model). Opt-in; names + @handles, never emails.                            |

## How it ranks

Each source file is classified into a tier:

| Tier         | Heuristic                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| **Critical** | Name suggests security/auth/crypto/payment-handling concerns, OR is a controller/service > 500 lines |
| **High**     | Controller/handler/service file (regardless of size)                                                 |
| **Medium**   | Model / repository / interceptor / middleware files                                                  |
| **Low**      | Everything else                                                                                      |

A file is considered "tested" if:

- **With coverage data**: lines > 0% coverage
- **Without coverage data**: a matching test file exists by filename
  convention (`foo.ts` ↔ `foo.test.ts`)

Without coverage data, the report opens with a banner explicitly
calling out the heuristic and pointing to `--with-coverage`.

**Within a tier, `--graph-context` weights the worklist by blast radius.**
When a code graph is present, the most-depended-on untested files (the ones
many other files call into) surface first within their risk tier — a
30-caller untested file is a bigger liability than a 500-line leaf nothing
calls. Files the graph can't resolve (or languages whose call graph is
unreliable, e.g. C#) fall back to LOC ranking and are never dropped. This
re-orders the worklist only; it never changes the Tests score (which comes
from the tier counts).

## Output

```markdown
## Critical: 0 untested ✓

## High: 2 untested

- src/controllers/payment.controller.ts (450 lines)
- src/services/auth.service.ts (320 lines)

## Medium: 8 untested

## Low: 47 untested
```

The detailed report includes per-file rationale and the matching-test
hypothesis where applicable.

## Coverage fidelity

The summary always carries a `coverageFidelity` tier indicating how
trustworthy the testing signal is:

- `line-coverage` — real per-line data from your test runner
- `import-graph` — heuristic enriched by graphify's import analysis
- `filename-match` — pure filename heuristic (least trustworthy)

If you see `filename-match`, run `vyuh-dxkit health --with-coverage`
or `vyuh-dxkit coverage` first to upgrade the tier.

## See also

- [`coverage`](coverage.md) — materialize the coverage data this report consumes
- [`health`](health.md) — Testing dimension scores derive from the same signal
