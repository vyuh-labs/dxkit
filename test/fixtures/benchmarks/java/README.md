# Java benchmark fixture

Pinned vulnerable dep used by `test/integration/cross-ecosystem.test.ts`
to validate the Java pack across the cross-ecosystem matrix
(secrets / lint / dups / test-gaps + per-pack depVulns).

## Standard 5-file convention

Each language pack's benchmark dir ships these five files. Names are
case-sensitive and the cross-ecosystem matrix asserts findings on each.
Reference shape: `test/fixtures/benchmarks/python/` (most-canonical),
`test/fixtures/benchmarks/kotlin/` (most-recent / Recipe-v2 reference).

| File                   | Concern      | What flags it                                           |
| ---------------------- | ------------ | ------------------------------------------------------- |
| `<manifest>`           | depVulns     | the pack's vuln scanner via OSV.dev or native CLI       |
| `BadLint.<ext>`        | lint         | the pack's linter on default config                     |
| `Duplications.<ext>`   | duplications | jscpd (language-agnostic clone detector)                |
| `Secrets.<ext>`        | secrets      | gitleaks (AKIA pattern is the standard fake token)      |
| `UntestedModule.<ext>` | test-gaps    | filename-match coverage source (no companion test file) |

## TODO checklist for Java

- [ ] Pick the right `<manifest>` osv-scanner / native scanner reads
      (e.g. `pom.xml` for Maven, `Cargo.lock` for Rust). Pin a
      known-vulnerable version of a stable popular package.
- [ ] Write `BadLint.<ext>` with multiple deliberate violations the
      linter's default ruleset flags (multiple so at least one fires
      across version drift).
- [ ] Write `Duplications.<ext>` with two near-identical helper
      functions sized comfortably above jscpd's defaults
      (`--min-lines 5 --min-tokens 50`).
- [ ] Write `Secrets.<ext>` with a fake AKIA-pattern AWS key that
      matches gitleaks' default `aws-access-token` rule but is
      clearly bogus (low-entropy patterned digits).
- [ ] Write `UntestedModule.<ext>` — simple class/function with no
      matching test file. Body should be lint-clean and clone-free.
- [ ] Register in `test/integration/cross-ecosystem.test.ts` —
      add a row to `BENCHMARK_LANGUAGES` and a
      `cross-ecosystem benchmarks — Java` describe block.
- [ ] Run `npm run test:run` — all kotlin matrix rows + the
      Java benchmark depVulns test should pass (or skip on
      toolchain availability).

## Fixture vs raw

Fixtures here are full mini-projects exercised end-to-end by the
matrix tests. The `test/fixtures/raw/java/` directory holds
captured tool-output bytes for unit-test parser validation — see that
dir's HARVEST.md for capture commands.
