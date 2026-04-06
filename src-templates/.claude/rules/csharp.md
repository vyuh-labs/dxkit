---
paths:
  - "**/*.cs"
  - "services/csharp/**/*"
---

# C# Rules

- Enable nullable reference types (`#nullable enable`) in all files
- Use async/await for all I/O — never block with `.Result` or `.Wait()`
- Prefer pattern matching and switch expressions over if-else chains
- Use record types for immutable data transfer objects
- Use dependency injection via IServiceCollection — no service locators or manual `new` for services
- Prefer xUnit for testing with `[Fact]` and `[Theory]` attributes
- Use `dotnet format` for formatting — check with `dotnet format --verify-no-changes`
- Write XML doc comments (`///`) on all public APIs
- Use `using` declarations for IDisposable resources
- Prefer `string.IsNullOrEmpty()` over null checks + length checks
