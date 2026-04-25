// Deliberate unused_variables violation. Phase 10i.0.2: per-language
// lint fixture. rustc/clippy emit `unused_variables` warning by
// default — no clippy lint level overrides needed in Cargo.toml.
pub fn bad_lint() {
    let unused_variable = 42;
}
