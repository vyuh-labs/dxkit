#!/bin/bash
# Lint all Python code using ruff and mypy

set -e

CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

FAILED=0

# Check if there are any Python files (excluding template, venv, v0)
if ! find . -name "*.py" -type f -not -path "./v0/*" -not -path "./.template/*" -not -path "./.venv/*" -not -path "./venv/*" 2>/dev/null | grep -q .; then
    echo -e "${YELLOW}⚠️  No Python files found${RESET}"
    exit 0
fi

# Run ruff if installed
if command -v ruff &> /dev/null; then
    echo -e "${CYAN}Linting Python code with ruff...${RESET}"
    if ruff check . --exclude ".template,.venv,venv,v0"; then
        echo -e "${GREEN}✅ Ruff linting passed${RESET}"
    else
        echo -e "${RED}❌ Ruff linting failed${RESET}"
        FAILED=1
    fi
else
    echo -e "${YELLOW}⚠️  ruff not found - skipping${RESET}"
    echo -e "${YELLOW}Install with: pip install ruff${RESET}"
fi

# Run mypy if installed
if command -v mypy &> /dev/null; then
    echo -e "${CYAN}Type checking with mypy...${RESET}"
    MYPY_DIRS=()
    [ -d "pkg/python" ] && MYPY_DIRS+=(pkg/python)
    [ -d "services/python" ] && MYPY_DIRS+=(services/python)
    [ -d "src" ] && MYPY_DIRS+=(src)

    if [ ${#MYPY_DIRS[@]} -gt 0 ]; then
        if mypy "${MYPY_DIRS[@]}" 2>/dev/null; then
            echo -e "${GREEN}✅ Mypy type checking passed${RESET}"
        else
            echo -e "${RED}❌ Mypy type checking failed${RESET}"
            FAILED=1
        fi
    fi
else
    echo -e "${YELLOW}⚠️  mypy not found - skipping type checking${RESET}"
fi

exit $FAILED
