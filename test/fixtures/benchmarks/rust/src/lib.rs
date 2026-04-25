// Placeholder so cargo treats this as a real package. The benchmark
// fixture's purpose is the manifest + lockfile that cargo-audit
// consumes; no source-level analysis is needed for the dep-vuln test.
//
// The `bad_lint` module is included so `cargo clippy` actually
// compiles + checks the deliberate `unused_variables` violation in
// src/bad_lint.rs (Phase 10i.0.2 lint matrix). The `secrets` module
// is NOT included — `gitleaks` scans files independently of cargo's
// build chain, so an unreferenced source file still surfaces the
// hardcoded fake AWS key (Phase 10i.0.1).
#[allow(dead_code)]
mod bad_lint;
