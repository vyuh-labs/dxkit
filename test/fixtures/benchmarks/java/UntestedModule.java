// Phase 10k.1.0 — deliberate untested file fixture, Java row.
//
// No matching test file exists; dxkit's `test-gaps` filename-match
// coverage source should report this in `gaps[]` with
// `hasMatchingTest: false`. Body is intentionally simple: no lint
// violations, no clones, no secrets — those concerns are covered by
// separate matrix fixtures.

public class UntestedModule {
    public String describe() {
        return "untested";
    }
}
