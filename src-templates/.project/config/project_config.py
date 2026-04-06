#!/usr/bin/env python3
"""
Project Configuration Manager
==============================

Reads and manages .project.yaml configuration for multi-language projects.

USAGE
-----
    # Display project info dashboard
    python3 project_config.py info

    # Get/set a specific value
    python3 project_config.py get languages.python.version
    python3 project_config.py set languages.python.quality.coverage 85

    # Quality presets
    python3 project_config.py preset              # list presets
    python3 project_config.py preset strict       # apply strict preset
    python3 project_config.py preset relaxed      # apply relaxed preset

    # Language management
    python3 project_config.py lang-list           # list languages
    python3 project_config.py lang-add python     # enable python
    python3 project_config.py lang-remove go      # disable go

    # Sync config to language files
    python3 project_config.py sync                # create/update config files
    python3 project_config.py sync --dry-run      # preview changes

    # Export as shell variables (for CI/scripts)
    python3 project_config.py export
    python3 project_config.py export python       # only python vars

    # Initialize default config
    python3 project_config.py init
"""

from __future__ import annotations

import contextlib
import json
import sys
from importlib.util import find_spec
from pathlib import Path
from typing import Any


# Check if yaml is available
HAS_YAML = find_spec("yaml") is not None
if HAS_YAML:
    import yaml


CONFIG_FILE = ".project.yaml"

# Quality presets
QUALITY_PRESETS = {
    "strict": {
        "description": "Production-ready: High coverage, all checks enabled",
        "python": {"coverage": 90, "lint": True, "typecheck": True, "format": True},
        "go": {"coverage": 80, "lint": True, "format": True},
        "node": {"coverage": 85, "lint": True, "typecheck": True, "format": True},
        "rust": {"coverage": 75, "lint": True, "format": True},
    },
    "standard": {
        "description": "Balanced: Moderate thresholds, essential checks",
        "python": {"coverage": 80, "lint": True, "typecheck": True, "format": True},
        "go": {"coverage": 70, "lint": True, "format": True},
        "node": {"coverage": 75, "lint": True, "typecheck": True, "format": True},
        "rust": {"coverage": 60, "lint": True, "format": True},
    },
    "relaxed": {
        "description": "Rapid prototyping: Lower thresholds, flexible checks",
        "python": {"coverage": 50, "lint": True, "typecheck": False, "format": True},
        "go": {"coverage": 40, "lint": True, "format": True},
        "node": {"coverage": 50, "lint": True, "typecheck": False, "format": True},
        "rust": {"coverage": 30, "lint": True, "format": True},
    },
    "off": {
        "description": "No enforcement: All quality checks disabled",
        "python": {"coverage": 0, "lint": False, "typecheck": False, "format": False},
        "go": {"coverage": 0, "lint": False, "format": False},
        "node": {"coverage": 0, "lint": False, "typecheck": False, "format": False},
        "rust": {"coverage": 0, "lint": False, "format": False},
    },
}

# Default configuration template
DEFAULT_CONFIG = {
    "project": {
        "name": "my-project",
        "description": "A new project",
    },
    "languages": {
        "python": {
            "enabled": False,
            "version": "3.12",
            "src_dir": "src",  # Source directory (e.g., "src", ".", or "src/mypackage")
            "quality": {
                "coverage": 80,
                "lint": True,
                "typecheck": True,
                "format": True,
            },
        },
        "go": {
            "enabled": False,
            "version": "1.24.0",
            "quality": {
                "coverage": 70,
                "lint": True,
                "format": True,
            },
        },
        "node": {
            "enabled": False,
            "version": "20",
            "quality": {
                "coverage": 75,
                "lint": True,
                "typecheck": True,
                "format": True,
            },
        },
        "rust": {
            "enabled": False,
            "version": "stable",
            "quality": {
                "coverage": 60,
                "lint": True,
                "format": True,
            },
        },
    },
    "precommit": True,
    "infrastructure": {
        "postgres": {
            "enabled": False,
            "version": "16",
        },
        "redis": {
            "enabled": False,
            "version": "7",
        },
    },
}

# ANSI colors
CYAN = "\033[36m"
GREEN = "\033[32m"
RED = "\033[31m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def load_config(config_path: str = CONFIG_FILE) -> dict:
    """Load configuration from YAML file."""
    path = Path(config_path)

    if not path.exists():
        return DEFAULT_CONFIG.copy()

    if not HAS_YAML:
        print("Warning: PyYAML not installed, using defaults", file=sys.stderr)
        return DEFAULT_CONFIG.copy()

    with open(path) as f:
        config = yaml.safe_load(f) or {}

    # Merge with defaults to ensure all keys exist
    return deep_merge(DEFAULT_CONFIG.copy(), config)


def save_config(config: dict, config_path: str = CONFIG_FILE) -> None:
    """Save configuration to YAML file."""
    if not HAS_YAML:
        print("Error: PyYAML required for saving config", file=sys.stderr)
        sys.exit(1)

    path = Path(config_path)
    with open(path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False, indent=2)


def deep_merge(base: dict, override: dict) -> dict:
    """Deep merge two dictionaries."""
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def get_nested(config: dict, path: str) -> Any:
    """Get a nested value by dot-separated path."""
    keys = path.split(".")
    value = config
    for key in keys:
        if isinstance(value, dict) and key in value:
            value = value[key]
        else:
            return None
    return value


def set_nested(config: dict, path: str, value: Any) -> dict:
    """Set a nested value by dot-separated path."""
    keys = path.split(".")
    current = config
    for key in keys[:-1]:
        if key not in current:
            current[key] = {}
        current = current[key]

    # Try to parse value as appropriate type
    if isinstance(value, str):
        if value.lower() == "true":
            value = True
        elif value.lower() == "false":
            value = False
        else:
            with contextlib.suppress(ValueError):
                value = int(value)

    current[keys[-1]] = value
    return config


def cmd_info(config: dict) -> None:
    """Display project configuration dashboard."""
    width = 57

    def hline(w: int) -> str:
        return "─" * w

    def check(val: bool) -> str:
        return f"{GREEN}✓{RESET}" if val else f"{DIM}✗{RESET}"

    project_name = config.get("project", {}).get("name", "unknown")
    languages = config.get("languages", {})
    precommit = config.get("precommit", False)
    infra = config.get("infrastructure", {})

    print()
    print(f"{CYAN}┌{hline(width - 2)}┐{RESET}")
    print(f"{CYAN}│{RESET} {BOLD}{project_name:<{width - 4}}{RESET} {CYAN}│{RESET}")
    print(f"{CYAN}├{hline(width - 2)}┤{RESET}")

    # Languages section
    print(f"{CYAN}│{RESET} {BOLD}Languages{RESET}{' ' * (width - 12)}{CYAN}│{RESET}")
    print(f"{CYAN}│{RESET}{' ' * (width - 2)}{CYAN}│{RESET}")

    lang_tools = {
        "python": ("Python", True),   # has typecheck (mypy)
        "go": ("Go", False),          # typecheck built-in
        "node": ("Node.js", True),    # has typecheck (tsc)
        "rust": ("Rust", False),      # typecheck built-in
    }

    for lang_key, (lang_name, has_typecheck) in lang_tools.items():
        lang = languages.get(lang_key, {})
        enabled = lang.get("enabled", False)
        version = lang.get("version", "")
        quality = lang.get("quality", {})

        if enabled:
            cov = quality.get("coverage", 0)
            lint = quality.get("lint", False)
            typecheck = quality.get("typecheck", False)

            extras = []
            extras.append(f"cov:{cov}%")
            if lint:
                extras.append(f"{GREEN}lint{RESET}")
            if has_typecheck and typecheck:
                extras.append(f"{GREEN}type{RESET}")

            extras_str = "  ".join(extras)
            line = f"  {GREEN}✓{RESET} {lang_name:<10} {CYAN}{version:<8}{RESET} {extras_str}"
        else:
            line = f"  {DIM}✗ {lang_name:<10}{RESET}"

        # Pad to width (accounting for ANSI codes)
        visible_len = len(line.replace(GREEN, "").replace(CYAN, "").replace(DIM, "").replace(RESET, "").replace(BOLD, ""))
        padding = width - 2 - visible_len
        print(f"{CYAN}│{RESET}{line}{' ' * max(0, padding)}{CYAN}│{RESET}")

    print(f"{CYAN}├{hline(width - 2)}┤{RESET}")

    # Global settings
    print(f"{CYAN}│{RESET} {BOLD}Settings{RESET}{' ' * (width - 11)}{CYAN}│{RESET}")
    print(f"{CYAN}│{RESET}{' ' * (width - 2)}{CYAN}│{RESET}")

    precommit_str = f"{GREEN}enabled{RESET}" if precommit else f"{DIM}disabled{RESET}"
    line = f"  Pre-commit:  {precommit_str}"
    visible_len = len(line.replace(GREEN, "").replace(DIM, "").replace(RESET, ""))
    padding = width - 2 - visible_len
    print(f"{CYAN}│{RESET}{line}{' ' * max(0, padding)}{CYAN}│{RESET}")

    print(f"{CYAN}├{hline(width - 2)}┤{RESET}")

    # Infrastructure section
    print(f"{CYAN}│{RESET} {BOLD}Infrastructure{RESET}{' ' * (width - 17)}{CYAN}│{RESET}")
    print(f"{CYAN}│{RESET}{' ' * (width - 2)}{CYAN}│{RESET}")

    pg = infra.get("postgres", {}).get("enabled", False)
    redis = infra.get("redis", {}).get("enabled", False)

    line = f"  {check(pg)} PostgreSQL    {check(redis)} Redis"
    visible_len = len(line.replace(GREEN, "").replace(DIM, "").replace(RESET, ""))
    padding = width - 2 - visible_len
    print(f"{CYAN}│{RESET}{line}{' ' * max(0, padding)}{CYAN}│{RESET}")

    print(f"{CYAN}└{hline(width - 2)}┘{RESET}")
    print()
    print(f"{DIM}Config: {CONFIG_FILE} | Edit: make config{RESET}")
    print()


def cmd_get(config: dict, path: str) -> None:
    """Get a configuration value."""
    value = get_nested(config, path)
    if value is None:
        print(f"Key not found: {path}", file=sys.stderr)
        sys.exit(1)
    print(value)


def cmd_set(config: dict, path: str, value: str) -> None:
    """Set a configuration value."""
    config = set_nested(config, path, value)
    save_config(config)
    print(f"Set {path} = {value}")


def cmd_export(config: dict, lang_filter: str | None = None) -> None:
    """Export configuration as shell variables."""
    project = config.get("project", {})
    languages = config.get("languages", {})
    infra = config.get("infrastructure", {})

    exports = []

    # Project
    exports.append(f"PROJECT_NAME='{project.get('name', '')}'")
    exports.append(f"PROJECT_DESCRIPTION='{project.get('description', '')}'")

    # Languages
    for lang_key, lang in languages.items():
        if lang_filter and lang_key != lang_filter:
            continue

        prefix = lang_key.upper()
        exports.append(f"INCLUDE_{prefix}={str(lang.get('enabled', False)).lower()}")
        exports.append(f"{prefix}_VERSION='{lang.get('version', '')}'")

        quality = lang.get("quality", {})
        exports.append(f"{prefix}_COVERAGE_THRESHOLD={quality.get('coverage', 0)}")
        exports.append(f"{prefix}_LINT_ENABLED={str(quality.get('lint', False)).lower()}")
        if "typecheck" in quality:
            exports.append(f"{prefix}_TYPECHECK_ENABLED={str(quality.get('typecheck', False)).lower()}")
        exports.append(f"{prefix}_FORMAT_ENABLED={str(quality.get('format', False)).lower()}")

    # Precommit
    exports.append(f"INCLUDE_PRECOMMIT={str(config.get('precommit', False)).lower()}")

    # Infrastructure
    for infra_key, infra_config in infra.items():
        prefix = infra_key.upper()
        exports.append(f"INCLUDE_{prefix}={str(infra_config.get('enabled', False)).lower()}")
        exports.append(f"{prefix}_VERSION='{infra_config.get('version', '')}'")

    for export in exports:
        print(export)


def cmd_init(config: dict) -> None:
    """Initialize configuration file with defaults."""
    if Path(CONFIG_FILE).exists():
        print(f"Config file already exists: {CONFIG_FILE}")
        print("Use 'make config' to edit")
        return

    save_config(DEFAULT_CONFIG)
    print(f"Created {CONFIG_FILE}")


def cmd_preset(config: dict, preset_name: str | None = None) -> None:
    """Apply a quality preset or list available presets."""
    if preset_name is None:
        # List available presets
        print()
        print(f"{BOLD}Available Quality Presets{RESET}")
        print("=" * 50)
        print()
        for name, preset in QUALITY_PRESETS.items():
            print(f"  {CYAN}{name:<12}{RESET} {preset['description']}")
        print()
        print(f"{DIM}Usage: python3 project_config.py preset <name>{RESET}")
        print(f"{DIM}   or: make quality-strict / make quality-relaxed{RESET}")
        print()
        return

    if preset_name not in QUALITY_PRESETS:
        print(f"Unknown preset: {preset_name}", file=sys.stderr)
        print(f"Available: {', '.join(QUALITY_PRESETS.keys())}", file=sys.stderr)
        sys.exit(1)

    preset = QUALITY_PRESETS[preset_name]
    languages = config.get("languages", {})

    # Apply preset to all enabled languages
    applied = []
    for lang_key in languages:
        if lang_key in preset:
            languages[lang_key]["quality"] = preset[lang_key].copy()
            if languages[lang_key].get("enabled", False):
                applied.append(lang_key)

    config["languages"] = languages
    save_config(config)

    print()
    print(f"{GREEN}✓{RESET} Applied '{preset_name}' preset")
    print(f"  {preset['description']}")
    print()
    if applied:
        print(f"  Updated: {', '.join(applied)}")
    else:
        print(f"  {DIM}No languages enabled. Enable with: make lang-add LANG=python{RESET}")
    print()


def cmd_lang_add(config: dict, lang: str) -> None:
    """Enable a language in the project."""
    valid_langs = ["python", "go", "node", "rust"]
    if lang not in valid_langs:
        print(f"Unknown language: {lang}", file=sys.stderr)
        print(f"Available: {', '.join(valid_langs)}", file=sys.stderr)
        sys.exit(1)

    languages = config.get("languages", {})
    if lang not in languages:
        languages[lang] = DEFAULT_CONFIG["languages"].get(lang, {"enabled": True})

    if languages[lang].get("enabled", False):
        print(f"{lang} is already enabled")
        return

    languages[lang]["enabled"] = True
    config["languages"] = languages
    save_config(config)

    version = languages[lang].get("version", "")
    quality = languages[lang].get("quality", {})
    cov = quality.get("coverage", 0)

    print()
    print(f"{GREEN}✓{RESET} Enabled {lang}")
    print(f"  Version:  {version}")
    print(f"  Coverage: {cov}%")
    print()
    print(f"{DIM}Run 'make info' to see full configuration{RESET}")
    print()


def cmd_lang_remove(config: dict, lang: str) -> None:
    """Disable a language in the project."""
    languages = config.get("languages", {})

    if lang not in languages:
        print(f"Unknown language: {lang}", file=sys.stderr)
        sys.exit(1)

    if not languages[lang].get("enabled", False):
        print(f"{lang} is already disabled")
        return

    languages[lang]["enabled"] = False
    config["languages"] = languages
    save_config(config)

    print()
    print(f"{GREEN}✓{RESET} Disabled {lang}")
    print()


def cmd_lang_list(config: dict) -> None:
    """List available languages and their status."""
    languages = config.get("languages", {})
    print()
    print(f"{BOLD}Languages{RESET}")
    print("=" * 40)
    print()
    for lang_key, lang_config in languages.items():
        enabled = lang_config.get("enabled", False)
        version = lang_config.get("version", "")
        status = f"{GREEN}enabled{RESET}" if enabled else f"{DIM}disabled{RESET}"
        print(f"  {lang_key:<10} {version:<10} {status}")
    print()
    print(f"{DIM}Add: make lang-add LANG=python{RESET}")
    print(f"{DIM}Remove: make lang-remove LANG=python{RESET}")
    print()


def cmd_sync(config: dict, dry_run: bool = False) -> None:
    """Sync config to language-specific files."""
    languages = config.get("languages", {})
    project_name = config.get("project", {}).get("name", "my-project")

    synced = []
    created = []

    for lang_key, lang_config in languages.items():
        if not lang_config.get("enabled", False):
            continue

        version = lang_config.get("version", "")
        quality = lang_config.get("quality", {})

        if lang_key == "python":
            src_dir = lang_config.get("src_dir", "src")
            result = _sync_python(project_name, version, quality, src_dir, dry_run)
            synced.extend(result.get("synced", []))
            created.extend(result.get("created", []))

        elif lang_key == "go":
            result = _sync_go(project_name, version, quality, dry_run)
            synced.extend(result.get("synced", []))
            created.extend(result.get("created", []))

        elif lang_key == "node":
            result = _sync_node(project_name, version, quality, dry_run)
            synced.extend(result.get("synced", []))
            created.extend(result.get("created", []))

        elif lang_key == "rust":
            result = _sync_rust(project_name, version, quality, dry_run)
            synced.extend(result.get("synced", []))
            created.extend(result.get("created", []))

    print()
    if dry_run:
        print(f"{CYAN}[DRY RUN]{RESET} Would sync the following:")
    else:
        print(f"{GREEN}✓{RESET} Config synced")

    if created:
        print(f"\n  {BOLD}Created:{RESET}")
        for f in created:
            print(f"    + {f}")

    if synced:
        print(f"\n  {BOLD}Updated:{RESET}")
        for f in synced:
            print(f"    ~ {f}")

    if not created and not synced:
        print(f"  {DIM}No changes needed{RESET}")

    print()


def _sync_python(name: str, version: str, quality: dict, src_dir: str, dry_run: bool) -> dict:
    """Sync Python configuration files."""
    result = {"synced": [], "created": []}
    pyproject_path = Path("pyproject.toml")
    coverage = quality.get("coverage", 80)
    lint = quality.get("lint", True)
    typecheck = quality.get("typecheck", True)
    fmt = quality.get("format", True)

    # Generate pyproject.toml content
    content = f'''[project]
name = "{name}"
version = "0.1.0"
description = ""
requires-python = ">={version}"

[project.optional-dependencies]
dev = [
    "pytest>=7.4.0",
    "pytest-cov>=4.1.0",
    "pytest-asyncio>=0.21.0",
    "ruff>=0.8.0",
    "mypy>=1.8.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
include = ["**/*.py"]
exclude = [
    "tests/**",
    "**/test_*.py",
    "**/*_test.py",
    "conftest.py",
    ".template/**",
    ".project/**",
    "scripts/**",
    "docs/**",
    "examples/**",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "--cov={src_dir} --cov-report=term-missing --cov-fail-under={coverage}"

[tool.coverage.run]
source = ["{src_dir}"]
branch = true

[tool.coverage.report]
fail_under = {coverage}
show_missing = true
'''

    if lint or fmt:
        content += f'''
[tool.ruff]
line-length = 88
target-version = "py{version.replace(".", "")[:3]}"
'''
        if lint:
            content += '''
[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "C4"]
ignore = []
'''

    if typecheck:
        content += f'''
[tool.mypy]
python_version = "{version}"
strict = true
warn_return_any = true
warn_unused_configs = true
'''

    if dry_run:
        if pyproject_path.exists():
            result["synced"].append("pyproject.toml")
        else:
            result["created"].append("pyproject.toml")
    else:
        existed = pyproject_path.exists()
        with open(pyproject_path, "w") as f:
            f.write(content)
        if existed:
            result["synced"].append("pyproject.toml")
        else:
            result["created"].append("pyproject.toml")

    return result


def _sync_go(name: str, version: str, quality: dict, dry_run: bool) -> dict:
    """Sync Go configuration files."""
    result = {"synced": [], "created": []}
    gomod_path = Path("go.mod")
    golangci_path = Path(".golangci.yml")
    lint = quality.get("lint", True)

    # go.mod
    gomod_content = f'''module {name}

go {version}
'''

    if dry_run:
        if gomod_path.exists():
            result["synced"].append("go.mod")
        else:
            result["created"].append("go.mod")
    else:
        existed = gomod_path.exists()
        with open(gomod_path, "w") as f:
            f.write(gomod_content)
        if existed:
            result["synced"].append("go.mod")
        else:
            result["created"].append("go.mod")

    # .golangci.yml for linting
    if lint:
        golangci_content = '''run:
  timeout: 5m

linters:
  enable:
    - errcheck
    - gosimple
    - govet
    - ineffassign
    - staticcheck
    - unused
    - gofmt
    - goimports

linters-settings:
  errcheck:
    check-type-assertions: true
'''
        if dry_run:
            if golangci_path.exists():
                result["synced"].append(".golangci.yml")
            else:
                result["created"].append(".golangci.yml")
        else:
            existed = golangci_path.exists()
            with open(golangci_path, "w") as f:
                f.write(golangci_content)
            if existed:
                result["synced"].append(".golangci.yml")
            else:
                result["created"].append(".golangci.yml")

    return result


def _sync_node(name: str, version: str, quality: dict, dry_run: bool) -> dict:
    """Sync Node.js configuration files."""
    result = {"synced": [], "created": []}
    pkg_path = Path("package.json")
    tsconfig_path = Path("tsconfig.json")
    coverage = quality.get("coverage", 75)
    lint = quality.get("lint", True)
    typecheck = quality.get("typecheck", True)

    # package.json
    pkg_content = {
        "name": name,
        "version": "0.1.0",
        "type": "module",
        "engines": {"node": f">={version}"},
        "scripts": {
            "build": "tsc" if typecheck else "echo 'No build step'",
            "test": f"vitest run --coverage --coverage.thresholds.statements={coverage}",
            "lint": "eslint src" if lint else "echo 'Lint disabled'",
            "format": "prettier --write src",
        },
    }

    if dry_run:
        if pkg_path.exists():
            result["synced"].append("package.json")
        else:
            result["created"].append("package.json")
    else:
        existed = pkg_path.exists()
        with open(pkg_path, "w") as f:
            json.dump(pkg_content, f, indent=2)
            f.write("\n")
        if existed:
            result["synced"].append("package.json")
        else:
            result["created"].append("package.json")

    # tsconfig.json for TypeScript
    if typecheck:
        tsconfig_content = {
            "compilerOptions": {
                "target": "ES2022",
                "module": "NodeNext",
                "moduleResolution": "NodeNext",
                "strict": True,
                "esModuleInterop": True,
                "skipLibCheck": True,
                "outDir": "dist",
                "rootDir": "src",
            },
            "include": ["src"],
            "exclude": ["node_modules", "dist"],
        }

        if dry_run:
            if tsconfig_path.exists():
                result["synced"].append("tsconfig.json")
            else:
                result["created"].append("tsconfig.json")
        else:
            existed = tsconfig_path.exists()
            with open(tsconfig_path, "w") as f:
                json.dump(tsconfig_content, f, indent=2)
                f.write("\n")
            if existed:
                result["synced"].append("tsconfig.json")
            else:
                result["created"].append("tsconfig.json")

    return result


def _sync_rust(name: str, version: str, quality: dict, dry_run: bool) -> dict:
    """Sync Rust configuration files."""
    result = {"synced": [], "created": []}
    cargo_path = Path("Cargo.toml")

    # Cargo.toml
    cargo_content = f'''[package]
name = "{name.replace("-", "_")}"
version = "0.1.0"
edition = "2021"
rust-version = "{version if version != "stable" else "1.75"}"

[dependencies]

[dev-dependencies]

[lints.rust]
unsafe_code = "forbid"

[lints.clippy]
all = "warn"
pedantic = "warn"
'''

    if dry_run:
        if cargo_path.exists():
            result["synced"].append("Cargo.toml")
        else:
            result["created"].append("Cargo.toml")
    else:
        existed = cargo_path.exists()
        with open(cargo_path, "w") as f:
            f.write(cargo_content)
        if existed:
            result["synced"].append("Cargo.toml")
        else:
            result["created"].append("Cargo.toml")

    return result


def main() -> int:
    """CLI entry point."""
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    cmd = sys.argv[1]
    config = load_config()

    if cmd == "info":
        cmd_info(config)
    elif cmd == "get":
        if len(sys.argv) < 3:
            print("Usage: project_config.py get <path>", file=sys.stderr)
            return 1
        cmd_get(config, sys.argv[2])
    elif cmd == "set":
        if len(sys.argv) < 4:
            print("Usage: project_config.py set <path> <value>", file=sys.stderr)
            return 1
        cmd_set(config, sys.argv[2], sys.argv[3])
    elif cmd == "export":
        lang_filter = sys.argv[2] if len(sys.argv) > 2 else None
        cmd_export(config, lang_filter)
    elif cmd == "init":
        cmd_init(config)
    elif cmd == "preset":
        preset_name = sys.argv[2] if len(sys.argv) > 2 else None
        cmd_preset(config, preset_name)
    elif cmd == "lang-add":
        if len(sys.argv) < 3:
            print("Usage: project_config.py lang-add <language>", file=sys.stderr)
            print("Languages: python, go, node, rust", file=sys.stderr)
            return 1
        cmd_lang_add(config, sys.argv[2])
    elif cmd == "lang-remove":
        if len(sys.argv) < 3:
            print("Usage: project_config.py lang-remove <language>", file=sys.stderr)
            return 1
        cmd_lang_remove(config, sys.argv[2])
    elif cmd == "lang-list":
        cmd_lang_list(config)
    elif cmd == "sync":
        dry_run = "--dry-run" in sys.argv
        cmd_sync(config, dry_run)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
