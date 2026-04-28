# Kotlin benchmark fixture — `gson:2.8.5` (Maven)

Pinned vulnerable dep used by `test/integration/cross-ecosystem.test.ts`
to validate the Kotlin pack's osv-scanner invocation, OSV.dev severity
enrichment, and the cross-ecosystem matrix rows (secrets/lint/dups/
test-gaps) for Kotlin.

## Why pom.xml (not gradle.lockfile)

osv-scanner v2.x reads `pom.xml`, `gradle.lockfile`, and (limited)
`build.gradle.kts`. `gradle.lockfile` is the most accurate input but
requires running `./gradlew dependencies --write-locks` to produce —
and that needs a JVM toolchain we don't want this fixture to depend on
at scan time. `pom.xml` is the reliable JVM-free input osv-scanner
parses directly.

The fixture is therefore declared as a Maven project. This is unusual
for a real-world Kotlin/Android shop (Gradle dominates), but the kotlin
pack's depVulns gather doesn't care which build tool — it cares that
osv-scanner has a manifest to read. When 10j.x lands gradle.lockfile
generation in CI, we may switch this fixture over.

## Expected osv-scanner output

`osv-scanner scan source --lockfile pom.xml --format json` should
report `com.google.code.gson:gson` advisories including
**GHSA-4jrv-ppp4-jm57** (alias **CVE-2022-25647**, CVSS:3.1 7.7) plus
several advisories on `org.apache.logging.log4j:log4j-core:2.14.0`.

## Files

| File                | Concern      | What flags it                                           |
| ------------------- | ------------ | ------------------------------------------------------- |
| `pom.xml`           | depVulns     | osv-scanner via OSV.dev Maven feed                      |
| `BadLint.kt`        | lint         | detekt's default ruleset (multiple violations)          |
| `Duplications.kt`   | duplications | jscpd (language-agnostic clone detector)                |
| `Secrets.kt`        | secrets      | gitleaks (AKIA pattern)                                 |
| `UntestedModule.kt` | test-gaps    | filename-match coverage source (no companion test file) |

## Regenerating

The only artifact here is `pom.xml` itself. No Maven lockfile to
regenerate. To re-record the expected osv-scanner output for the raw
parser fixture under `test/fixtures/raw/kotlin/`, run osv-scanner
against this `pom.xml` and overwrite `osv-scanner-output.json`.
