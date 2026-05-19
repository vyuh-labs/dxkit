---
description: Diagnose development environment issues
---

Diagnose this development environment.

## Step 1: dxkit doctor

Run dxkit's own health check first — it covers tool availability (gitleaks, semgrep, cloc, etc.), `.claude/` install state, and hook configuration:

```bash
npx vyuh-dxkit doctor 2>/dev/null
```

If the command isn't available, fall back to Step 2.

## Step 2: Environment checks

1. **Git**: `git --version` and `git status`
2. **Node** (if `package.json`): `node --version` / `npm --version`; is `node_modules/` populated?
3. **Python** (if `pyproject.toml`): `python3 --version`; virtual env activated? deps installed?
4. **Go** (if `go.mod`): `go version`; modules downloaded?
5. **.NET** (if `*.csproj`): `dotnet --version`
6. **Rust** (if `Cargo.toml`): `rustc --version` / `cargo --version`
7. **Docker** (if `docker-compose.yml`): `docker --version`; daemon running?
8. **Hooks active**: `git config core.hooksPath` should report `.githooks` if dxkit hooks are installed
9. **dxkit install**: `.claude/`, `CLAUDE.md`, `.vyuh-dxkit.json` present?

Report any issues found and provide remediation steps.
