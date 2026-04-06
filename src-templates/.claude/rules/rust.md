---
paths:
  - "**/*.rs"
  - "services/rust/**/*"
---

# Rust Rules

- Use `clippy` lints — fix all warnings before committing
- Prefer `Result<T, E>` over panics for error handling
- Use `thiserror` for library errors, `anyhow` for application errors
- Write doc comments (`///`) on all public items
- Use `cargo fmt` formatting (rustfmt.toml if configured)
- Prefer `&str` over `String` in function signatures when possible
