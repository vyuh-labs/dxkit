#!/bin/bash

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RESET='\033[0m'

echo -e "${CYAN}📖 Serving Documentation${RESET}"
echo "========================"
echo ""

# Try to start a docs server
if command -v python3 &> /dev/null; then
    echo -e "${GREEN}✓${RESET} Serving at http://localhost:8080"
    echo "Press Ctrl+C to stop"
    cd docs && python3 -m http.server 8080
else
    echo "Python3 not found - cannot serve docs"
    exit 1
fi
