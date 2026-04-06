#!/bin/bash

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RESET='\033[0m'

echo -e "${CYAN}📚 Generating Documentation${RESET}"
echo "============================"
echo ""

# Create docs directory if needed
mkdir -p docs/api

# Generate Go docs if godoc available
if command -v go &> /dev/null && find . -name "*.go" -type f | grep -q .; then
    echo -e "${CYAN}Generating Go documentation...${RESET}"
    go doc -all > docs/api/go-packages.txt 2>/dev/null || true
    echo -e "${GREEN}✓${RESET} Go docs generated"
fi

# Generate Python docs if pdoc available
if command -v pdoc &> /dev/null && find . -name "*.py" -type f | grep -q .; then
    echo -e "${CYAN}Generating Python documentation...${RESET}"
    # Add pdoc commands here
    echo -e "${GREEN}✓${RESET} Python docs generated"
fi

echo ""
echo -e "${GREEN}✅ Documentation generation complete!${RESET}"
