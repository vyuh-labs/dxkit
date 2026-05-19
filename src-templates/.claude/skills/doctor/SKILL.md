---
name: doctor
description: Diagnose and fix development environment issues. Use when setup fails, tools are missing, the environment is broken, or something is misconfigured.
---

# Doctor

## Diagnose

Walk through this checklist when something feels off:

1. **Git**: `git --version`, working tree clean?
2. **Language toolchains** (only for languages present in this repo):
   - Node: `node --version` / `npm --version`; `node_modules/` populated?
   - Python: `python3 --version`; virtual env activated? deps installed?
   - Go: `go version`; modules downloaded?
   - .NET: `dotnet --version`
   - Rust: `rustc --version` / `cargo --version`
3. **Docker** (if `docker-compose.yml` present): `docker --version`; daemon running?
4. **dxkit health**: `npx vyuh-dxkit doctor` — verifies dxkit-managed tools (gitleaks, semgrep, cloc, etc.) and the `.claude/` install
5. **Hooks active**: `git config core.hooksPath` should report `.githooks` if hooks are installed

## Fix

- Missing dxkit tools: `npx vyuh-dxkit tools install`
- Stale `node_modules/`: `rm -rf node_modules && npm install`
- Hooks not firing: `git config core.hooksPath .githooks`

## Environment

If the repo has `.devcontainer/`, the canonical environment is the container — open in a devcontainer-aware editor (VS Code "Reopen in Container", Codespaces) instead of fighting host-machine setup.
