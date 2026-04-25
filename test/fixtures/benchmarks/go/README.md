# Go benchmark fixture — `gin-gonic/gin v1.6.0`

Pinned vulnerable dep used by `test/integration/cross-ecosystem.test.ts`
to validate the Go pack's `govulncheck` invocation, severity tiering,
and topLevelDep attribution.

## Expected scanner behavior

dxkit's Go pack (`src/languages/go.ts`) invokes
`govulncheck -json ./...` from the fixture directory. govulncheck does
**call-graph reachability analysis** — it only emits a `finding` record
when there's a real call path from this fixture's code to a known-
vulnerable function. As a result:

- **stdlib findings (~50 expected)** — the `go 1.21` toolchain itself
  has known CVEs (e.g., `GO-2024-2598+`); these surface because any
  Go program implicitly uses stdlib functions.
- **gin-gonic/gin findings (~0 expected)** — gin's vulnerable code is
  not reached from `main.go`. The fixture is intentionally minimal;
  surfacing gin findings would require call-graph paths that exercise
  specific vulnerable APIs (`Bind*`, `BindUri`, etc.).

This means the integration test asserts on **findings count > 0**,
**tool == 'govulncheck'**, and **at least one stdlib finding** — not
on a specific gin advisory ID. govulncheck's call-graph design is
explicitly the reason the Go pack stays Tier-1 (no `upgradePlan`):
"upgrade gin from 1.6.0 → 1.7.0" only makes sense if the analysis
reports a gin finding; for stdlib it would mean "upgrade Go itself."

## Regenerating

```bash
cd test/fixtures/benchmarks/go
rm go.sum
go mod tidy   # writes both direct + transitive checksums
```

`go.mod` and `go.sum` are committed so the fixture is reproducible
without network access at test time. `go mod tidy` (not `go mod
download`) is required because govulncheck needs transitive checksums
to compile the call-graph.
