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

## Prerequisites

Both PMD and JaCoCo's `pmd` wrapper script are JVM-based. Before
harvesting, ensure Java 17+ is on PATH. On a Linux dev box with no
system Java:

```bash
mkdir -p ~/.local/share/java ~/.local/bin
curl -sSfL -o /tmp/jdk17.tar.gz \
  "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.19%2B10/OpenJDK17U-jdk_x64_linux_hotspot_17.0.19_10.tar.gz"
tar xzf /tmp/jdk17.tar.gz -C ~/.local/share/java
ln -sf ~/.local/share/java/jdk-17.0.19+10/bin/java ~/.local/bin/java
ln -sf ~/.local/share/java/jdk-17.0.19+10/bin/javac ~/.local/bin/javac
```

PMD itself installs through dxkit:

```bash
vyuh-dxkit tools install pmd
```

## Capture commands

### `pmd-output.json` — PMD lint, parsed by `parsePmdOutput`

```bash
# Run from repo root. Exit code 4 expected when violations are found
# (PMD's convention). The JSON-on-stdout shell redirect captures the
# fixture; warnings go to stderr and are discarded.
PATH="$HOME/.local/bin:$PATH" \
  pmd check \
    -d test/fixtures/benchmarks/java/BadLint.java \
    -R rulesets/java/quickstart.xml \
    -f json \
  2>/dev/null > test/fixtures/raw/java/pmd-output.json || true
```

Captured 2026-04-28 against PMD 7.24.0 (Eclipse Temurin JDK 17.0.19).
Output validates `parsePmdOutput` against PMD 7's `formatVersion: 0`
JSON shape: `files[].violations[]` with `priority` (1-5), `rule`,
`ruleset`, line/column metadata.

### `jacoco-*.xml` — see kotlin pack

JaCoCo XML format is JVM-language-agnostic; the kotlin pack already
hosts the canonical Kotlin + Java JaCoCo fixtures at
`test/fixtures/raw/kotlin/`. Java pack reuses them via the shared
parser at `src/analyzers/tools/jacoco.ts` (CLAUDE.md rule #2).

### `osv-scanner-output.json` — depVulns (10k.1.4)

TODO when 10k.1.4 lands. Will capture against a Maven `pom.xml` with a
known-vulnerable dep, similar to the kotlin fixture.

## Why committed

Real-output fixtures stay byte-identical to what the upstream tool
emits. `.prettierignore` excludes `test/fixtures/raw/` so reformatting
doesn't drift the bytes. Re-harvest only when:
  - The upstream tool ships a JSON/XML schema change
  - The fixture's project was edited (different finding set)
