#!/usr/bin/env python3
"""
Interactive Project Configuration Editor
=========================================

Provides an interactive menu to edit .project.yaml settings.

USAGE
-----
    python3 edit_config.py           # Interactive menu
    python3 edit_config.py --quick   # Quick toggle menu (languages only)
"""

from __future__ import annotations

import os
import sys
from importlib.util import find_spec


# Check if yaml is available
HAS_YAML = find_spec("yaml") is not None

CONFIG_FILE = ".project.yaml"

# ANSI colors
CYAN = "\033[36m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def load_config() -> dict:
    """Load configuration from YAML file."""
    from project_config import load_config as _load
    return _load()


def save_config(config: dict) -> None:
    """Save configuration to YAML file."""
    from project_config import save_config as _save
    _save(config)


def clear_screen():
    """Clear terminal screen."""
    os.system('clear' if os.name == 'posix' else 'cls')


def prompt(message: str, default: str = "") -> str:
    """Prompt for input with optional default."""
    if default:
        result = input(f"{message} [{default}]: ").strip()
        return result if result else default
    return input(f"{message}: ").strip()


def prompt_bool(message: str, default: bool = True) -> bool:
    """Prompt for yes/no."""
    default_str = "Y/n" if default else "y/N"
    result = input(f"{message} [{default_str}]: ").strip().lower()
    if not result:
        return default
    return result in ("y", "yes", "true", "1")


def prompt_int(message: str, default: int, min_val: int = 0, max_val: int = 100) -> int:
    """Prompt for integer."""
    while True:
        result = input(f"{message} [{default}]: ").strip()
        if not result:
            return default
        try:
            val = int(result)
            if min_val <= val <= max_val:
                return val
            print(f"{RED}Value must be between {min_val} and {max_val}{RESET}")
        except ValueError:
            print(f"{RED}Please enter a number{RESET}")


def prompt_choice(message: str, options: list[str], default: int = 0) -> int:
    """Prompt for choice from list."""
    print(f"\n{message}")
    for i, opt in enumerate(options):
        marker = f"{GREEN}>{RESET}" if i == default else " "
        print(f"  {marker} {i + 1}. {opt}")

    while True:
        result = input(f"Choice [1-{len(options)}]: ").strip()
        if not result:
            return default
        try:
            idx = int(result) - 1
            if 0 <= idx < len(options):
                return idx
            print(f"{RED}Please enter 1-{len(options)}{RESET}")
        except ValueError:
            print(f"{RED}Please enter a number{RESET}")


def edit_language(config: dict, lang_key: str, lang_name: str) -> None:
    """Edit settings for a specific language."""
    lang = config["languages"].get(lang_key, {})
    quality = lang.get("quality", {})

    clear_screen()
    print(f"\n{BOLD}{CYAN}═══ {lang_name} Configuration ═══{RESET}\n")

    # Enable/disable
    enabled = prompt_bool(
        f"Enable {lang_name}",
        lang.get("enabled", False)
    )
    lang["enabled"] = enabled

    if enabled:
        # Version
        lang["version"] = prompt(
            f"{lang_name} version",
            lang.get("version", "")
        )

        print(f"\n{BOLD}Quality settings:{RESET}")

        # Coverage
        quality["coverage"] = prompt_int(
            "  Coverage threshold (%)",
            quality.get("coverage", 80)
        )

        # Lint
        quality["lint"] = prompt_bool(
            "  Enable linting",
            quality.get("lint", True)
        )

        # Typecheck (not all languages)
        if lang_key in ("python", "node"):
            quality["typecheck"] = prompt_bool(
                "  Enable type checking",
                quality.get("typecheck", True)
            )

        # Format
        quality["format"] = prompt_bool(
            "  Enable formatting",
            quality.get("format", True)
        )

        lang["quality"] = quality

    config["languages"][lang_key] = lang


def edit_infrastructure(config: dict) -> None:
    """Edit infrastructure settings."""
    infra = config.get("infrastructure", {})

    clear_screen()
    print(f"\n{BOLD}{CYAN}═══ Infrastructure Configuration ═══{RESET}\n")

    # PostgreSQL
    pg = infra.get("postgres", {})
    pg["enabled"] = prompt_bool("Enable PostgreSQL", pg.get("enabled", False))
    if pg["enabled"]:
        pg["version"] = prompt("PostgreSQL version", pg.get("version", "16"))
    infra["postgres"] = pg

    # Redis
    redis = infra.get("redis", {})
    redis["enabled"] = prompt_bool("Enable Redis", redis.get("enabled", False))
    if redis["enabled"]:
        redis["version"] = prompt("Redis version", redis.get("version", "7"))
    infra["redis"] = redis

    config["infrastructure"] = infra


def main_menu(config: dict) -> bool:
    """Main configuration menu. Returns True to continue, False to exit."""
    clear_screen()

    project_name = config.get("project", {}).get("name", "unknown")
    languages = config.get("languages", {})

    print(f"\n{BOLD}{CYAN}═══ Project Configuration: {project_name} ═══{RESET}\n")
    print(f"Config file: {CONFIG_FILE}\n")

    # Show current state summary
    print(f"{BOLD}Current settings:{RESET}")
    for lang_key, lang_name in [("python", "Python"), ("go", "Go"), ("node", "Node.js"), ("rust", "Rust")]:
        lang = languages.get(lang_key, {})
        if lang.get("enabled"):
            cov = lang.get("quality", {}).get("coverage", 0)
            print(f"  {GREEN}✓{RESET} {lang_name} {lang.get('version', '')} (cov: {cov}%)")
        else:
            print(f"  {DIM}✗ {lang_name}{RESET}")

    precommit = config.get("precommit", False)
    print(f"\n  Pre-commit: {GREEN}enabled{RESET}" if precommit else f"\n  Pre-commit: {DIM}disabled{RESET}")

    print(f"\n{BOLD}Menu:{RESET}")
    print(f"  1. Edit {CYAN}Python{RESET} settings")
    print(f"  2. Edit {CYAN}Go{RESET} settings")
    print(f"  3. Edit {CYAN}Node.js{RESET} settings")
    print(f"  4. Edit {CYAN}Rust{RESET} settings")
    print(f"  5. Edit {CYAN}Infrastructure{RESET} (Postgres, Redis)")
    print(f"  6. Toggle {CYAN}Pre-commit{RESET} hooks")
    print(f"  7. Edit {CYAN}Project{RESET} name/description")
    print()
    print(f"  {GREEN}s{RESET}. Save and exit")
    print(f"  {RED}q{RESET}. Quit without saving")

    choice = input("\nChoice: ").strip().lower()

    if choice == "1":
        edit_language(config, "python", "Python")
    elif choice == "2":
        edit_language(config, "go", "Go")
    elif choice == "3":
        edit_language(config, "node", "Node.js")
    elif choice == "4":
        edit_language(config, "rust", "Rust")
    elif choice == "5":
        edit_infrastructure(config)
    elif choice == "6":
        config["precommit"] = not config.get("precommit", False)
        status = "enabled" if config["precommit"] else "disabled"
        print(f"\n{GREEN}Pre-commit hooks {status}{RESET}")
        input("Press Enter to continue...")
    elif choice == "7":
        clear_screen()
        print(f"\n{BOLD}{CYAN}═══ Project Settings ═══{RESET}\n")
        project = config.get("project", {})
        project["name"] = prompt("Project name", project.get("name", "my-project"))
        project["description"] = prompt("Project description", project.get("description", ""))
        config["project"] = project
    elif choice == "s":
        save_config(config)
        print(f"\n{GREEN}Configuration saved to {CONFIG_FILE}{RESET}")
        return False
    elif choice == "q":
        print(f"\n{YELLOW}Changes discarded{RESET}")
        return False

    return True


def main() -> int:
    """CLI entry point."""
    if not HAS_YAML:
        print(f"{RED}Error: PyYAML is required for config editing{RESET}")
        print("Install with: pip install pyyaml")
        return 1

    # Check if running in a terminal
    if not sys.stdin.isatty():
        print(f"{RED}Error: Interactive mode requires a terminal{RESET}")
        return 1

    config = load_config()

    # Main loop
    while main_menu(config):
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
