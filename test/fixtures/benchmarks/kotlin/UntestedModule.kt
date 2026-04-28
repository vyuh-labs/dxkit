// Phase 10i.0.4 — deliberate untested file fixture, Kotlin row.
//
// No matching test file exists; dxkit's `test-gaps` filename-match
// coverage source should report this in `gaps[]` with
// `hasMatchingTest: false`. Body is intentionally simple: no lint
// violations, no clones, no secrets — those concerns are covered by
// separate matrix fixtures.

class UntestedModule {
    fun describe(): String = "untested"
}
