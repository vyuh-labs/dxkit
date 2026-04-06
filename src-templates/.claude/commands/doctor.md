---
description: Diagnose development environment issues
---

Diagnose this development environment. Check for common issues:

## Checks

1. **Git**: `git --version` and repo status
2. **Node** (if package.json): `node --version`, `npm --version`, check if `node_modules/` exists
3. **Python** (if pyproject.toml): `python3 --version`, check virtual env, check if deps installed
4. **Go** (if go.mod): `go version`, check if modules downloaded
5. **C#** (if .csproj): `dotnet --version`
6. **Rust** (if Cargo.toml): `rustc --version`, `cargo --version`
7. **Docker** (if docker-compose.yml): `docker --version`, check if running
8. **Make** (if Makefile): `make --version`
9. **Claude Code DX**: check `.claude/` directory, `CLAUDE.md`, `.vyuh-dxkit.json`

If `Makefile` exists with `doctor` target, run `make doctor` instead.

Report any issues found and provide remediation steps.
