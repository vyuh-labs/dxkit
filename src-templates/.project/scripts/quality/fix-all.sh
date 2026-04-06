#!/bin/bash

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
RESET='\033[0m'

# Helper to read config
read_config() {
    local path="$1"
    local default="$2"
    if [ -f ".project.yaml" ] && command -v python3 &> /dev/null; then
        python3 -c "
import yaml
try:
    with open('.project.yaml') as f:
        c = yaml.safe_load(f)
    keys = '$path'.split('.')
    val = c
    for k in keys:
        val = val.get(k, {}) if isinstance(val, dict) else {}
    print('true' if val is True else ('false' if val is False else '$default'))
except:
    print('$default')
" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# Read enabled languages from config
PYTHON_ENABLED=$(read_config "languages.python.enabled" "false")
GO_ENABLED=$(read_config "languages.go.enabled" "false")
NODE_ENABLED=$(read_config "languages.node.enabled" "false")
RUST_ENABLED=$(read_config "languages.rust.enabled" "false")

echo -e "${CYAN}🔧 Auto-fixing Quality Issues${RESET}"
echo ""

# Format Go code
if [ "$GO_ENABLED" = "true" ]; then
    if find . -name "*.go" -type f -not -path "./v0/*" -not -path "./.git/*" -not -path "./.template/*" | grep -q .; then
        echo -e "${CYAN}Formatting Go code...${RESET}"
        gofmt -w $(find . -name "*.go" -type f -not -path "./v0/*" -not -path "./.git/*" -not -path "./.template/*")
        if command -v goimports &> /dev/null; then
            goimports -w $(find . -name "*.go" -type f -not -path "./v0/*" -not -path "./.git/*" -not -path "./.template/*") 2>/dev/null || true
        fi
        echo -e "${GREEN}✓${RESET} Go code formatted"
        echo ""
    else
        echo -e "${DIM}○ Go enabled but no .go files found${RESET}"
    fi
fi

# Format Python code
if [ "$PYTHON_ENABLED" = "true" ]; then
    if find . -name "*.py" -type f -not -path "./v0/*" -not -path "./.git/*" -not -path "./.venv/*" -not -path "./venv/*" -not -path "./.template/*" | grep -q .; then
        echo -e "${CYAN}Formatting Python code...${RESET}"

        # Use ruff for auto-fixes
        if command -v ruff &> /dev/null; then
            ruff check --fix . --exclude ".template,.venv,venv,v0" 2>/dev/null || true
            ruff format . --exclude ".template,.venv,venv,v0" 2>/dev/null || true
            echo -e "${GREEN}✓${RESET} ruff fixes applied"
        fi

        # Use black for formatting (fallback if ruff format not available)
        if command -v black &> /dev/null && ! command -v ruff &> /dev/null; then
            find . -name "*.py" -type f -not -path "./v0/*" -not -path "./.git/*" -not -path "./.venv/*" -not -path "./venv/*" -not -path "./.template/*" | xargs -r black 2>/dev/null || true
            echo -e "${GREEN}✓${RESET} black formatting applied"
        fi

        echo -e "${GREEN}✓${RESET} Python code formatted"
        echo ""
    else
        echo -e "${DIM}○ Python enabled but no .py files found${RESET}"
    fi
fi

# Format Node.js code
if [ "$NODE_ENABLED" = "true" ]; then
    if find . \( -name "*.ts" -o -name "*.js" \) -type f -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./.template/*" 2>/dev/null | grep -q .; then
        echo -e "${CYAN}Formatting Node.js code...${RESET}"

        # Use prettier if available
        PRETTIER_CMD=""
        if command -v prettier &> /dev/null; then
            PRETTIER_CMD="prettier"
        elif [ -f "node_modules/.bin/prettier" ]; then
            PRETTIER_CMD="./node_modules/.bin/prettier"
        fi

        if [ -n "$PRETTIER_CMD" ]; then
            $PRETTIER_CMD --write "**/*.{js,ts,jsx,tsx}" 2>/dev/null || true
            echo -e "${GREEN}✓${RESET} prettier formatting applied"
        fi

        # Use eslint --fix if available
        ESLINT_CMD=""
        if command -v eslint &> /dev/null; then
            ESLINT_CMD="eslint"
        elif [ -f "node_modules/.bin/eslint" ]; then
            ESLINT_CMD="./node_modules/.bin/eslint"
        fi

        if [ -n "$ESLINT_CMD" ]; then
            $ESLINT_CMD --fix . --ext .js,.ts 2>/dev/null || true
            echo -e "${GREEN}✓${RESET} eslint fixes applied"
        fi

        echo -e "${GREEN}✓${RESET} Node.js code formatted"
        echo ""
    else
        echo -e "${DIM}○ Node.js enabled but no .js/.ts files found${RESET}"
    fi
fi

# Format Rust code
if [ "$RUST_ENABLED" = "true" ]; then
    if find . -name "*.rs" -type f -not -path "./target/*" -not -path "./.git/*" -not -path "./.template/*" | grep -q .; then
        echo -e "${CYAN}Formatting Rust code...${RESET}"

        if command -v cargo &> /dev/null; then
            cargo fmt 2>/dev/null || true
            echo -e "${GREEN}✓${RESET} cargo fmt applied"
        fi

        echo -e "${GREEN}✓${RESET} Rust code formatted"
        echo ""
    else
        echo -e "${DIM}○ Rust enabled but no .rs files found${RESET}"
    fi
fi

echo -e "${GREEN}✅ Quality fixes complete!${RESET}"
echo -e "${DIM}Run 'make quality' to verify${RESET}"
