# `vyuh-dxkit coverage`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Run each active language pack's test command with coverage
instrumentation and write the materialized coverage artifact. Used to
upgrade `test-gaps` + `health.Testing` from filename-match heuristic
to real line-coverage truth.

**Side-effecting:** this actually runs your tests. Be aware of test
isolation, network calls, etc. before running on a fresh machine.

## Usage

```bash
vyuh-dxkit coverage [path] [options]
```

## Options

| Option                | Effect                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--lang <id>`         | Restrict to one pack (`typescript`, `python`, `go`, `rust`, `csharp`, `kotlin`, `java`, `ruby`) |
| `--timeout <seconds>` | Per-pack timeout (default: 600)                                                                 |
| `--no-fail-fast`      | Continue past pack failures; report all outcomes                                                |
| `--verbose`           | Per-pack stderr passthrough                                                                     |

## What it does per pack

Each pack declares its own test command + coverage parser:

| Pack                    | Default command                               | Artifact                                                 |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------- |
| TypeScript / JavaScript | `npm test -- --coverage`                      | Istanbul `coverage-summary.json` / `coverage-final.json` |
| Python                  | `coverage run -m pytest && coverage xml`      | `coverage.xml`                                           |
| Go                      | `go test ./... -coverprofile=coverage.out`    | `coverage.out`                                           |
| Rust                    | `cargo tarpaulin --out json`                  | `tarpaulin-report.json`                                  |
| C#                      | `dotnet test --collect:"XPlat Code Coverage"` | Cobertura XML                                            |
| Kotlin                  | `./gradlew test jacocoTestReport`             | JaCoCo XML                                               |
| Java                    | `mvn test jacoco:report`                      | JaCoCo XML                                               |
| Ruby                    | `bundle exec rspec` (with SimpleCov)          | `coverage/.last_run.json`                                |

The artifact is written to a pack-determined path. `health --with-coverage`
and `test-gaps` then auto-discover the artifact on subsequent runs.

## When to use

- **Before `health --with-coverage`** — pre-materialize the artifact
  so health's scoring uses real coverage data
- **Before `test-gaps`** — upgrades the report from filename-match
  to line-coverage fidelity tier
- **In CI** — run once at the start of a workflow, then run multiple
  analysis commands against the same coverage artifact

## Output

A short summary per pack:

```
typescript: 67.3% lines covered (coverage-summary.json)
python:     82.1% lines covered (coverage.xml)
go:         91.4% lines covered (coverage.out)
```

Plus the actual coverage artifacts at each pack's conventional path.

## Performance

Depends entirely on your test suite. A repo with a 5-minute test suite
runs in ~5 minutes plus coverage overhead.

## See also

- [`health --with-coverage`](health.md) — health audit using real coverage data
- [`test-gaps`](test-gaps.md) — consumes the coverage artifact
