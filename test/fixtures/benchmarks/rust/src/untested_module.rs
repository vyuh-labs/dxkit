// Phase 10i.0.4 — deliberate untested file fixture. No matching
// test file exists; dxkit's `test-gaps` filename-match coverage
// source should report this in `gaps[]` with `hasMatchingTest:
// false`. Not declared via `mod untested_module;` in lib.rs —
// test-gaps walks the source tree directly, doesn't need cargo's
// build chain.
pub fn describe_untested() -> &'static str {
    "untested"
}
