#!/bin/bash
#
# Doctor Script - Diagnose common setup issues
# =============================================
#
# Checks:
#   - Required files exist (.project.yaml, Makefile, etc.)
#   - Language toolchains match enabled languages
#   - Quality tools installed
#   - Git hooks configured (if precommit enabled)
#   - Config syntax valid
#

set -e

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Counters
CHECKS_PASSED=0
CHECKS_WARNED=0
CHECKS_FAILED=0

# ============================================================================
# Helper Functions
# ============================================================================

print_header() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${CYAN}  $1${RESET}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
}

check_pass() {
    echo -e "  ${GREEN}✓${RESET} $1"
    CHECKS_PASSED=$((CHECKS_PASSED + 1))
}

check_warn() {
    echo -e "  ${YELLOW}!${RESET} $1"
    if [ -n "$2" ]; then
        echo -e "    ${DIM}→ $2${RESET}"
    fi
    CHECKS_WARNED=$((CHECKS_WARNED + 1))
}

check_fail() {
    echo -e "  ${RED}✗${RESET} $1"
    if [ -n "$2" ]; then
        echo -e "    ${DIM}→ $2${RESET}"
    fi
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
}

# ============================================================================
# Core File Checks
# ============================================================================

check_core_files() {
    echo -e "${BOLD}Core Files${RESET}"
    echo ""

    # .project.yaml
    if [ -f ".project.yaml" ]; then
        check_pass ".project.yaml exists"

        # Validate YAML syntax
        if python3 -c "import yaml; yaml.safe_load(open('.project.yaml'))" 2>/dev/null; then
            check_pass ".project.yaml is valid YAML"
        else
            check_fail ".project.yaml has invalid YAML syntax" "Run: python3 -c \"import yaml; yaml.safe_load(open('.project.yaml'))\""
        fi
    else
        check_fail ".project.yaml not found" "Run: ./bootstrap.sh to initialize"
    fi

    # Makefile
    if [ -f "Makefile" ]; then
        check_pass "Makefile exists"
    else
        check_fail "Makefile not found" "Run: ./bootstrap.sh to initialize"
    fi

    # .project directory
    if [ -d ".project" ]; then
        check_pass ".project/ directory exists"

        # Check key scripts
        if [ -f ".project/config/project_config.py" ]; then
            check_pass "project_config.py exists"
        else
            check_warn "project_config.py missing" "Some make commands may not work"
        fi
    else
        check_fail ".project/ directory not found" "Run: ./bootstrap.sh to initialize"
    fi

    echo ""
}

# ============================================================================
# Language Toolchain Checks
# ============================================================================

check_language_toolchains() {
    echo -e "${BOLD}Language Toolchains${RESET}"
    echo ""

    # Helper function to extract major.minor version
    get_major_minor() {
        echo "$1" | sed 's/^\([0-9]*\.[0-9]*\).*/\1/'
    }

    # Read enabled languages from config
    if [ -f ".project.yaml" ]; then
        # Python
        PYTHON_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('python',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")
        PYTHON_VERSION_CONFIG=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print(c.get('languages',{}).get('python',{}).get('version', '3.12'))" 2>/dev/null || echo "3.12")

        if [ "$PYTHON_ENABLED" = "true" ]; then
            if command -v python3 &> /dev/null; then
                ACTUAL_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
                # Compare only major.minor versions (ignore patch)
                CONFIG_MAJOR_MINOR=$(get_major_minor "$PYTHON_VERSION_CONFIG")
                ACTUAL_MAJOR_MINOR=$(get_major_minor "$ACTUAL_VERSION")
                if [[ "$ACTUAL_MAJOR_MINOR" == "$CONFIG_MAJOR_MINOR" ]]; then
                    check_pass "Python $ACTUAL_VERSION installed (config: $PYTHON_VERSION_CONFIG)"
                else
                    check_warn "Python version mismatch" "Config: $PYTHON_VERSION_CONFIG, Installed: $ACTUAL_VERSION"
                fi
            else
                check_fail "Python not found but enabled in config" "Install Python $PYTHON_VERSION_CONFIG"
            fi
        else
            echo -e "  ${DIM}○ Python not enabled${RESET}"
        fi

        # Go
        GO_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('go',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")
        GO_VERSION=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print(c.get('languages',{}).get('go',{}).get('version', '1.24.0'))" 2>/dev/null || echo "1.24.0")

        if [ "$GO_ENABLED" = "true" ]; then
            if command -v go &> /dev/null; then
                ACTUAL_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
                check_pass "Go $ACTUAL_VERSION installed (config: $GO_VERSION)"
            else
                check_fail "Go not found but enabled in config" "Install Go $GO_VERSION"
            fi
        else
            echo -e "  ${DIM}○ Go not enabled${RESET}"
        fi

        # Node.js
        NODE_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('node',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")
        NODE_VERSION_CONFIG=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print(c.get('languages',{}).get('node',{}).get('version', '20'))" 2>/dev/null || echo "20")

        if [ "$NODE_ENABLED" = "true" ]; then
            if command -v node &> /dev/null; then
                ACTUAL_VERSION=$(node --version | sed 's/v//')
                # Compare major version only for Node.js (config typically specifies major only)
                ACTUAL_MAJOR=$(echo "$ACTUAL_VERSION" | cut -d. -f1)
                CONFIG_MAJOR=$(echo "$NODE_VERSION_CONFIG" | cut -d. -f1)
                if [[ "$ACTUAL_MAJOR" == "$CONFIG_MAJOR" ]]; then
                    check_pass "Node.js $ACTUAL_VERSION installed (config: $NODE_VERSION_CONFIG)"
                else
                    check_warn "Node.js version mismatch" "Config: $NODE_VERSION_CONFIG, Installed: $ACTUAL_VERSION"
                fi
            else
                check_fail "Node.js not found but enabled in config" "Install Node.js $NODE_VERSION_CONFIG"
            fi
        else
            echo -e "  ${DIM}○ Node.js not enabled${RESET}"
        fi

        # Rust
        RUST_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('rust',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")

        if [ "$RUST_ENABLED" = "true" ]; then
            if command -v rustc &> /dev/null; then
                ACTUAL_VERSION=$(rustc --version | awk '{print $2}')
                check_pass "Rust $ACTUAL_VERSION installed"
            else
                check_fail "Rust not found but enabled in config" "Install Rust via rustup"
            fi
        else
            echo -e "  ${DIM}○ Rust not enabled${RESET}"
        fi
    else
        check_warn "Cannot check toolchains" ".project.yaml not found"
    fi

    echo ""
}

# ============================================================================
# Quality Tools Checks
# ============================================================================

check_quality_tools() {
    echo -e "${BOLD}Quality Tools${RESET}"
    echo ""

    if [ -f ".project.yaml" ]; then
        # Python quality tools
        PYTHON_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('python',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")

        if [ "$PYTHON_ENABLED" = "true" ]; then
            # ruff
            if command -v ruff &> /dev/null; then
                check_pass "ruff installed (Python linter)"
            else
                check_warn "ruff not installed" "pip install ruff"
            fi

            # mypy
            if command -v mypy &> /dev/null; then
                check_pass "mypy installed (Python type checker)"
            else
                check_warn "mypy not installed" "pip install mypy"
            fi

            # pytest
            if python3 -c "import pytest" 2>/dev/null; then
                check_pass "pytest installed (Python testing)"
            else
                check_warn "pytest not installed" "pip install pytest pytest-cov"
            fi
        fi

        # Go quality tools
        GO_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('go',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")

        if [ "$GO_ENABLED" = "true" ]; then
            if command -v golangci-lint &> /dev/null; then
                check_pass "golangci-lint installed (Go linter)"
            else
                check_warn "golangci-lint not installed" "go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest"
            fi
        fi

        # Node quality tools
        NODE_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('languages',{}).get('node',{}).get('enabled', False) else 'false')" 2>/dev/null || echo "false")

        if [ "$NODE_ENABLED" = "true" ]; then
            if command -v eslint &> /dev/null || [ -f "node_modules/.bin/eslint" ]; then
                check_pass "eslint available (Node linter)"
            else
                check_warn "eslint not installed" "npm install -D eslint"
            fi
        fi
    else
        check_warn "Cannot check quality tools" ".project.yaml not found"
    fi

    echo ""
}

# ============================================================================
# Git Hooks Checks
# ============================================================================

check_git_hooks() {
    echo -e "${BOLD}Git Configuration${RESET}"
    echo ""

    # Check if we're in a git repo
    if [ -d ".git" ]; then
        check_pass "Git repository initialized"

        # Check git user config
        if git config user.name &> /dev/null; then
            check_pass "Git user.name configured: $(git config user.name)"
        else
            check_warn "Git user.name not set" "git config user.name 'Your Name'"
        fi

        if git config user.email &> /dev/null; then
            check_pass "Git user.email configured"
        else
            check_warn "Git user.email not set" "git config user.email 'you@example.com'"
        fi

        # Check pre-commit hooks if enabled
        if [ -f ".project.yaml" ]; then
            PRECOMMIT_ENABLED=$(python3 -c "import yaml; c=yaml.safe_load(open('.project.yaml')); print('true' if c.get('precommit', False) else 'false')" 2>/dev/null || echo "false")

            if [ "$PRECOMMIT_ENABLED" = "true" ]; then
                if [ -f ".git/hooks/pre-commit" ]; then
                    check_pass "Pre-commit hook installed"
                else
                    check_warn "Pre-commit hook not installed" "Run: pre-commit install"
                fi

                if command -v pre-commit &> /dev/null; then
                    check_pass "pre-commit tool installed"
                else
                    check_warn "pre-commit tool not installed" "pip install pre-commit"
                fi
            else
                echo -e "  ${DIM}○ Pre-commit hooks not enabled${RESET}"
            fi
        fi
    else
        check_warn "Not a git repository" "Run: git init"
    fi

    echo ""
}

# ============================================================================
# Environment Checks
# ============================================================================

check_environment() {
    echo -e "${BOLD}Environment${RESET}"
    echo ""

    # Make
    if command -v make &> /dev/null; then
        check_pass "make available"
    else
        check_warn "make not installed" "Install via package manager"
    fi

    # PyYAML (required for config tools)
    if python3 -c "import yaml" 2>/dev/null; then
        check_pass "PyYAML installed"
    else
        check_fail "PyYAML not installed" "pip install pyyaml"
    fi

    # Docker (optional)
    if command -v docker &> /dev/null; then
        check_pass "Docker available"
    else
        echo -e "  ${DIM}○ Docker not installed (optional)${RESET}"
    fi

    echo ""
}

# ============================================================================
# Summary
# ============================================================================

print_summary() {
    print_header "DIAGNOSTIC SUMMARY"

    TOTAL=$((CHECKS_PASSED + CHECKS_WARNED + CHECKS_FAILED))

    echo -e "  ${GREEN}✓ Passed:${RESET}  $CHECKS_PASSED"
    echo -e "  ${YELLOW}! Warnings:${RESET} $CHECKS_WARNED"
    echo -e "  ${RED}✗ Failed:${RESET}  $CHECKS_FAILED"
    echo ""

    if [ $CHECKS_FAILED -gt 0 ]; then
        echo -e "  ${RED}${BOLD}Some checks failed.${RESET}"
        echo -e "  ${DIM}Fix the issues above and run 'make doctor' again.${RESET}"
        echo ""
        exit 1
    elif [ $CHECKS_WARNED -gt 0 ]; then
        echo -e "  ${YELLOW}${BOLD}Setup complete with warnings.${RESET}"
        echo -e "  ${DIM}Consider fixing warnings for best experience.${RESET}"
        echo ""
    else
        echo -e "  ${GREEN}${BOLD}All checks passed!${RESET}"
        echo -e "  ${DIM}Your environment is ready for development.${RESET}"
        echo ""
    fi

    echo -e "  ${CYAN}Next steps:${RESET}"
    echo -e "    • Run ${CYAN}make info${RESET} to see your configuration"
    echo -e "    • Run ${CYAN}make help${RESET} to see available commands"
    echo -e "    • Run ${CYAN}make test${RESET} to verify everything works"
    echo ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    print_header "PROJECT DIAGNOSTICS"
    echo -e "  ${DIM}Checking your development environment...${RESET}"
    echo ""

    check_core_files
    check_language_toolchains
    check_quality_tools
    check_git_hooks
    check_environment

    print_summary
}

main "$@"
