# Rust benchmark fixture — `tokio = "0.1.9"`

Pinned vulnerable dep used by `test/integration/cross-ecosystem.test.ts`
to validate the Rust pack's `cargo-audit` invocation, severity tiering,
and Tier-2 `upgradePlan` population (Phase 10h.6.3).

## Expected scanner output

`cargo audit --json` against this fixture's `Cargo.lock` reports
**RUSTSEC-2021-0124** on `tokio@0.1.22` (cargo resolved `tokio = "0.1.9"`
to the latest 0.1.x — `0.1.22`). The advisory's
`versions.patched[]` lists two patched ranges:

```
[">=1.8.4, <1.9.0", ">=1.13.1"]
```

dxkit's Rust pack picks `patched[0]` and strips the `>=` prefix,
emitting `upgradePlan.parentVersion`. The integration test asserts:

- `findings.length >= 1`
- `finding.id == 'RUSTSEC-2021-0124'`
- `finding.package == 'tokio'`
- `finding.upgradePlan.parent == 'tokio'` (Rust dep graph is flat —
  parent == package; see `src/languages/rust.ts:250`)

The integration test does **not** assert `parentVersion == '1.8.4'`
because of a known parser bug (`rust.ts:240`) that preserves the
semver range and emits `"1.8.4, <1.9.0"` — tracked as a 2.4.1
hotfix candidate. The test asserts loosely (`startsWith('1.8.4')`)
until the fix lands; once fixed, the assertion tightens.

## Regenerating

```bash
cd test/fixtures/benchmarks/rust
rm Cargo.lock
cargo generate-lockfile   # regenerates from Cargo.toml
```

`Cargo.toml`, `Cargo.lock`, and `src/lib.rs` are committed so the
fixture is reproducible without network access at test time.
