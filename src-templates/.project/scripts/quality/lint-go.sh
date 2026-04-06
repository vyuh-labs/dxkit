#!/bin/bash
# Lint all Go code using golangci-lint

set -e

CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo -e "${CYAN}Linting Go code...${RESET}"

# Check if golangci-lint is installed
if ! command -v golangci-lint &> /dev/null; then
    echo -e "${YELLOW}⚠️  golangci-lint not found - skipping Go linting${RESET}"
    echo -e "${YELLOW}Install with: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest${RESET}"
    exit 0
fi

# Check if there are any Go files
if ! find . -name "*.go" -type f -not -path "./v0/*" | grep -q .; then
    echo -e "${YELLOW}⚠️  No Go files found${RESET}"
    exit 0
fi

# Run golangci-lint
if [ -f ".golangci.yml" ]; then
    golangci-lint run --config=.golangci.yml ./...
else
    golangci-lint run ./...
fi

echo -e "${GREEN}✅ Go linting passed${RESET}"
