# Swift — raw tool-output fixture harvest

Capture real Swift tool output and commit the bytes here. Unit tests in
`test/languages-swift.test.ts` parse these fixtures, NOT hand-crafted
strings. The C# defect (Phase 10h.6.8 — parser passed synthetic-JSON unit
tests for 5 months while returning 0 findings on real `dotnet list package
--vulnerable` output) is the cautionary tale that justifies this discipline.

## Standard fixtures

| File                   | Producer                            | What it validates                          |
| ---------------------- | ----------------------------------- | ------------------------------------------ |
| `lint-output.json`     | SwiftLint 0.65.0 `--reporter json`  | `parseSwiftlintJson` correctness           |
| `depvulns-output.json` | osv-scanner 2.4.0 (SwiftURL)        | shared osv parse with ecosystem `SwiftURL` |
| `coverage-output.json` | `swift test --enable-code-coverage` | `parseSwiftCoverageJson` (llvm-cov export) |

## Capture commands

```bash
# lint-output.json — SwiftLint JSON over a tiny project with deliberate
# force_cast / force_try / identifier_name violations. Run from a NEUTRAL
# directory (the absolute paths it emits are committed bytes):
mkdir -p /tmp/dxkit-harvest/repo/Sources/App && cd /tmp/dxkit-harvest/repo
#   ...add BadLint.swift (as! + try!) and Short.swift (`let x = 1`)...
swiftlint lint --quiet --no-cache --reporter json . \
  > test/fixtures/raw/swift/lint-output.json

# depvulns-output.json — osv-scanner >= 2.4.0 over the benchmark fixture's
# known-vulnerable Package.resolved (swift-nio 2.39.0). 2.3.8 CANNOT harvest
# this: its extractor emits an empty ecosystem and zero findings.
cd test/fixtures/benchmarks/swift
osv-scanner scan source --lockfile Package.resolved --format json \
  > ../../raw/swift/depvulns-output.json

# coverage-output.json — needs the swift toolchain (Linux builds work):
cd test/fixtures/analysis/swift-app
swift test --enable-code-coverage
cp .build/debug/codecov/App.json ../../raw/swift/coverage-output.json
```

## Why committed

Real-output fixtures stay byte-identical to what the upstream tool emits.
`.prettierignore` excludes `test/fixtures/raw/` so reformatting doesn't
drift the bytes. Re-harvest only when:

- The upstream tool ships a JSON schema change
- The fixture's project was edited (different finding set)
