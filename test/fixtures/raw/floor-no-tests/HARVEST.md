# Floor zero-tests fixtures: harvest notes

Raw test-runner output for the correctness floor's per-pack `ranNoTests`
recognisers (4.5.0). `test/correctness-no-tests.test.ts` reads every file
here; the table in that test names each file's pack, exit code and
expected answer. Each recogniser is pinned on BOTH sides: real zero-test
output must read as no-tests, and real output of a run that executed a
test must not (the precision side).

## What a file holds

Exactly what the floor's command runner captures (`makeCommandExec` in
`src/analyzers/tools/bounded-exec.ts`): on exit 0 only STDOUT (the
runner's `execFileSync` returns stdout and discards stderr), on a
non-zero exit stdout followed by stderr. Captured with a small script
that spawns the command the same way. That is why
`jest-one-test-stdout.txt` is empty: jest prints its results to stderr,
so a passing jest run shows the floor nothing on stdout.

Absolute paths of the capture directory are rewritten to `/work/...`,
and the .NET SDK path to `/usr/share/dotnet`. In
`dotnet10-xunit-one-test.txt` the SDK's repeated `NETSDK1188` locale
warnings (one line per satellite assembly, unrelated to tests) are
removed; nothing else is edited.

## Captured (real runs on tiny projects)

| Files | Tool | Project |
| --- | --- | --- |
| `dotnet10-web-sln-no-test-project.txt` | .NET SDK 10.0.404, `dotnet test` | `dotnet new web` in a solution, no test project (the shipped case) |
| `dotnet9-web-sln-no-test-project.txt` | .NET SDK 9.0.315, `dotnet test` | same, `global.json` pinned to 9, `net9.0` |
| `dotnet10-xunit-project-zero-tests.txt` | .NET 10, xunit 2.9.3, VSTest | `dotnet new xunit`, the test method removed |
| `dotnet10-xunit-one-test.txt` | same | `dotnet new xunit` unchanged (one `[Fact]`) |
| `cargo-lib-zero-tests.txt`, `cargo-bin-zero-tests.txt`, `cargo-lib-one-test.txt` | cargo 1.97.1, `cargo test` | `cargo new --lib` with the generated test removed; `cargo new` (bin); `cargo new --lib` unchanged |
| `pytest-zero-collected.txt`, `pytest-test-file-zero-tests.txt`, `pytest-one-test.txt` | pytest 9.2.0, `python -m pytest` (exit 5, 5, 0) | no test files; a `test_*.py` with no test function; one test |
| `minitest-load-no-test-files.txt`, `minitest-zero-runs.txt`, `minitest-one-run.txt` | Ruby 3.3.8, minitest 5.20.0, the floor's `ruby -Itest -Ilib -e 'Dir.glob(...)'` load | no `*_test.rb`; a `Minitest::Test` class with no test; one test |
| `rspec-no-spec-files.txt`, `rspec-zero-examples.txt`, `rspec-one-example.txt` | rspec 3.13 | no spec files; an empty `describe`; one example |
| `phpunit-no-tests-executed.txt`, `phpunit-one-test.txt` | PHPUnit 13.4.7 on PHP 8.5.4, `vendor/bin/phpunit` | `phpunit.xml` with an empty `tests/`; one test |
| `jest-zero-tests.txt`, `jest-related-zero-tests.txt`, `jest-via-npm-script-zero-tests.txt`, `jest-one-test-stdout.txt` | jest 30.5.2 | `jest --passWithNoTests` with no tests, the same with `--findRelatedTests src/app.js`, `npm test -- --passWithNoTests`, and one passing test |
| `vitest-run-zero-files.txt`, `vitest-related-zero-files.txt`, `vitest-run-one-test.txt`, `vitest-related-one-test.txt` | vitest 4.1.9 | `vitest run --passWithNoTests` and `vitest related --run --passWithNoTests src/app.js`, without and with one test |
| `node-test-zero-tests.txt` | Node 22, `npm test` running `node --test` | no test files |

## Documented (toolchain absent on the capture machine)

No Go, Swift, Gradle or Maven toolchain was available, and the .NET
runs above use VSTest, not Microsoft.Testing.Platform. These files are
written from each tool's documented, long-stable output format, and say
so here so nobody mistakes them for captures. Replace them with real
captures when the toolchain is at hand.

| Files | Source of the format |
| --- | --- |
| `go-module-no-test-files.txt`, `go-no-tests-to-run.txt`, `go-one-package-with-tests.txt`, `go-cached-pass.txt` | `go test` per-package summary lines (`?   <pkg>\t[no test files]`, `ok  <pkg>\t<time> [no tests to run]`, `ok  <pkg>\t(cached)`), `go help test` and cmd/go's test output |
| `swift-no-test-target.txt`, `swift-xctest-zero.txt`, `swift-testing-ran-xctest-zero.txt` | SwiftPM's `error: no tests found; create a target in the 'Tests' directory`, XCTest's `Executed N tests, with ...` summary, swift-testing's `Test run with N tests ... passed` |
| `gradle-test-no-source.txt`, `gradle-test-executed.txt`, `gradle-multiproject-one-ran.txt` | Gradle's plain-console task lines `> Task :<path> <OUTCOME>` and the `NO-SOURCE` task outcome (Gradle user manual, "Task outcomes") |
| `dotnet-mtp-zero-tests.txt` | Microsoft.Testing.Platform exit code 8 ("the test session ran zero tests") and its `Zero tests ran` summary |

Maven has no fixture and no recogniser: the floor runs `mvn -q`, which
suppresses surefire's `No tests to run.` line, so an empty run and a
passing run look the same. The exemption is declared in the test.
