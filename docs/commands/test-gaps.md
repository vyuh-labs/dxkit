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

| Option            | Effect                                                                           |
| ----------------- | -------------------------------------------------------------------------------- |
| `--detailed`      | Write detailed report (every untested file with classification rationale)        |
| `--with-coverage` | Materialize real coverage data before scoring (Istanbul, coverage.py, JaCoCo, …) |
| `--json`          | Stdout JSON                                                                      |
| `--no-save`       | Skip files                                                                       |

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
