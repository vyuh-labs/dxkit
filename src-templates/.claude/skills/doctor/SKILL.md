---
name: doctor
description: Diagnose and fix development environment issues. Use when setup fails, tools are missing, the environment is broken, or something is misconfigured.
---

# Doctor & Setup

## Commands
- `make doctor` - Diagnose common setup issues (checks files, toolchains, config)
- `make setup` - Interactive setup for new developers
- `make info` - Show project configuration dashboard
- `make config` - Interactive configuration editor

## What Doctor Checks
1. Core files (`.project.yaml`, `Makefile`, `.project/`)
2. YAML syntax validation
3. Language toolchain versions (Python, Go, Node, Rust)
4. Quality tools installation (linters, formatters)
5. Pre-commit hook configuration
6. Git configuration
7. Docker/Docker Compose availability
8. Service health (if infrastructure enabled)

## Common Issues & Fixes

### Missing tools
```bash
make doctor    # identify what's missing
make setup     # re-run interactive setup
```

### Config out of sync
```bash
make sync          # re-sync .project.yaml to language files
make sync-preview  # preview changes first (dry run)
```

### Pre-commit failures
```bash
make fix       # auto-fix all issues
make check     # verify everything passes
```

### Build failures after config change
```bash
make sync      # sync config
make clean     # clean artifacts
make build     # rebuild
```

## Environment
- DevContainer-based (see `.devcontainer/`)
- `post-create.sh` runs automatically on container creation
- All tools installed via devcontainer features or post-create script
