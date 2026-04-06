---
paths:
  - "**/*.go"
  - "services/go/**/*"
---

# Go Rules

- Always handle errors — never assign to `_`
- Propagate `context.Context` through call chains
- Use `defer` for resource cleanup (Close, Unlock, etc.)
- Table-driven tests with `t.Run()` subtests
- Use `httptest` for HTTP handler testing
- Errors should wrap with `fmt.Errorf("context: %w", err)`
- Prefer standard library over third-party when reasonable
- Use `golangci-lint` (not `go vet` alone) for comprehensive linting
