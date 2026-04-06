#!/bin/bash

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RESET='\033[0m'

echo -e "${CYAN}⚡ Running Quick Tests (Unit Only)${RESET}"
echo "===================================="
echo ""

# Run Go unit tests
if find . -name "go.mod" -type f -not -path "./v0/*" | grep -q .; then
    echo -e "${CYAN}Go tests...${RESET}"
    go test ./... -short 2>&1 | grep -E "PASS|FAIL|ok|coverage" || true
fi

# Run Python unit tests
if command -v pytest &> /dev/null && [ -f "pyproject.toml" ]; then
    echo -e "${CYAN}Python tests...${RESET}"
    pytest -q --tb=no 2>&1 | grep -E "passed|failed|PASSED|FAILED" || true
fi

echo ""
echo -e "${GREEN}✅ Quick tests complete!${RESET}"
