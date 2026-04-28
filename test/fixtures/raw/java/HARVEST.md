# Java — raw tool-output fixture harvest

Capture real Java tool output and commit the bytes here. Unit
tests in `test/languages-java.test.ts` parse these fixtures, NOT
hand-crafted strings. The C# defect (Phase 10h.6.8 — parser passed
synthetic-JSON unit tests for 5 months while returning 0 findings on
real `dotnet list package --vulnerable` output) is the cautionary
tale that justifies this discipline.

## Standard fixtures

| File                  | Producer                                    | What it validates                          |
| --------------------- | ------------------------------------------- | ------------------------------------------ |
| `lint-output.<ext>` | the pack's linter (e.g. detekt, ruff)       | parse${Tool}LintOutput correctness        |
| `coverage-output.<ext>` | the pack's coverage reporter            | parse${Tool}CoverageOutput correctness    |
| `depvulns-output.json` | osv-scanner / pip-audit / cargo-audit etc. | parse${Tool}DepVulnsOutput correctness   |

## Capture commands

TODO(java): replace these placeholder commands with the actual capture
invocations for Java's tools. Run from a tiny realistic
project (commit fake credentials/known-vuln deps that surface findings).

```bash
# Example shape — adapt per tool:
# <tool> --format <fmt> <input> > test/fixtures/raw/java/lint-output.<ext>
# <tool> --report json > test/fixtures/raw/java/coverage-output.<ext>
# <vuln-tool> scan --format json > test/fixtures/raw/java/depvulns-output.json
```

## Why committed

Real-output fixtures stay byte-identical to what the upstream tool
emits. `.prettierignore` excludes `test/fixtures/raw/` so reformatting
doesn't drift the bytes. Re-harvest only when:
  - The upstream tool ships a JSON/XML schema change
  - The fixture's project was edited (different finding set)
