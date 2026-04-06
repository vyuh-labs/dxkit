#!/bin/bash
# validate-templates.sh - Validate template files for syntax and processing
#
# This script:
# 1. Processes templates with test values
# 2. Validates YAML, TOML, and JSON syntax
# 3. Checks for unprocessed template variables

set -e

CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

TEMPLATE_DIR=".template"
TEST_OUTPUT_DIR="/tmp/template-validation-$$"
ERRORS=0
WARNINGS=0

# Cleanup on exit
cleanup() {
    rm -rf "$TEST_OUTPUT_DIR"
}
trap cleanup EXIT

mkdir -p "$TEST_OUTPUT_DIR"

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${CYAN}  TEMPLATE VALIDATION${RESET}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Check available validation tools
echo -e "${CYAN}Checking validation tools...${RESET}"
TOOLS_AVAILABLE=""
command -v yq &> /dev/null && TOOLS_AVAILABLE="$TOOLS_AVAILABLE yq"
command -v jq &> /dev/null && TOOLS_AVAILABLE="$TOOLS_AVAILABLE jq"
command -v python3 &> /dev/null && TOOLS_AVAILABLE="$TOOLS_AVAILABLE python3"
if [ -n "$TOOLS_AVAILABLE" ]; then
    echo -e "  Available:${GREEN}$TOOLS_AVAILABLE${RESET}"
else
    echo -e "  ${YELLOW}Warning: No validation tools found. Install yq, jq, or python3 for best results.${RESET}"
fi
echo ""

# ============================================================================
# Test Configuration
# ============================================================================

# Set test values for all template variables
export PROJECT_NAME="test-project"
export PROJECT_NAME_SNAKE="test_project"
export PROJECT_NAME_KEBAB="test-project"
export PROJECT_DESCRIPTION="A test project for template validation"
export GITHUB_ORG="testorg"
export PYTHON_VERSION="3.12"
export GO_VERSION="1.24.0"
export NODE_VERSION="20"
export RUST_VERSION="stable"
export POSTGRES_VERSION="16"
export REDIS_VERSION="7"
export DB_NAME="test_db"
export DB_USER="test_user"
export DB_PASSWORD="test_pass"

# Include all features for validation
export INCLUDE_PYTHON="true"
export INCLUDE_GO="true"
export INCLUDE_NODE="true"
export INCLUDE_NEXTJS="true"
export INCLUDE_RUST="true"
export INCLUDE_POSTGRES="true"
export INCLUDE_REDIS="true"
export INCLUDE_AI_SESSIONS="true"
export INCLUDE_AI_PROMPTS="true"
export INCLUDE_PRECOMMIT="true"
export INCLUDE_DOCKER="true"
export INCLUDE_PULUMI="false"
export INCLUDE_GH_CLI="true"
export INCLUDE_CLAUDE_CODE="true"
export INCLUDE_INFISICAL="false"
export INCLUDE_GCLOUD="true"
export INCLUDE_QUALITY_CHECKS="true"
export COVERAGE_THRESHOLD="80"

# ============================================================================
# Helper Functions
# ============================================================================

# Use the Python template engine for processing
# This ensures validation uses the exact same logic as actual template processing
TEMPLATE_ENGINE="scripts/bootstrap/template_engine.py"

if [ ! -f "$TEMPLATE_ENGINE" ]; then
    echo -e "${RED}Error: Template engine not found at $TEMPLATE_ENGINE${RESET}"
    exit 1
fi

process_test_template() {
    local input_file="$1"
    local output_file="$2"

    mkdir -p "$(dirname "$output_file")"

    # Use Python template engine (same as apply-config.sh)
    if ! python3 "$TEMPLATE_ENGINE" "$input_file" "$output_file" 2>/dev/null; then
        return 1
    fi
}

check_unprocessed_variables() {
    local file="$1"
    # Match {{VAR}} but not ${{ }} (GitHub Actions expressions)
    # Our template vars are {{WORD}} or {{#IF_X}}/{{/IF_X}}
    local result=$(grep -oE '\{\{[A-Z_#/][A-Z_0-9]*\}\}' "$file" 2>/dev/null || true)
    if [ -n "$result" ]; then
        echo -e "  ${RED}ERROR${RESET}: Unprocessed template variables found:"
        echo "$result" | while read -r var; do
            echo "    - $var"
        done
        return 1
    fi
    return 0
}

validate_yaml() {
    local file="$1"
    local error_msg=""

    # Try yq first (fastest, most reliable)
    if command -v yq &> /dev/null; then
        error_msg=$(yq eval '.' "$file" 2>&1)
        if [ $? -eq 0 ]; then
            return 0
        fi
        echo ""
        echo -e "    ${RED}YAML Error:${RESET} $error_msg"
        return 1
    fi

    # Try Python yaml module
    if command -v python3 &> /dev/null; then
        error_msg=$(python3 -c "
import yaml
import sys
try:
    with open('$file') as f:
        yaml.safe_load(f)
except yaml.YAMLError as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
" 2>&1)
        if [ $? -eq 0 ]; then
            return 0
        fi
        echo ""
        echo -e "    ${RED}YAML Error:${RESET} $error_msg"
        return 1
    fi

    # Fallback: basic syntax check (no detailed errors)
    if ! grep -qE '^\s*[a-zA-Z_-]+:\s*$|^\s*[a-zA-Z_-]+:\s+\S' "$file" 2>/dev/null; then
        return 1
    fi
    return 0
}

validate_toml() {
    local file="$1"
    local error_msg=""

    if command -v python3 &> /dev/null; then
        # Try tomllib (Python 3.11+) or tomli
        error_msg=$(python3 -c "
import sys
try:
    import tomllib
    with open('$file', 'rb') as f:
        tomllib.load(f)
except ImportError:
    try:
        import tomli
        with open('$file', 'rb') as f:
            tomli.load(f)
    except ImportError:
        # No TOML parser available, skip validation
        sys.exit(0)
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
" 2>&1)
        if [ $? -eq 0 ]; then
            return 0
        fi
        echo ""
        echo -e "    ${RED}TOML Error:${RESET} $error_msg"
        return 1
    fi
    # Fallback: no validation available
    return 0
}

validate_json() {
    local file="$1"
    local error_msg=""

    # Try jq first for strict JSON
    if command -v jq &> /dev/null; then
        error_msg=$(jq '.' "$file" 2>&1)
        if [ $? -eq 0 ]; then
            return 0
        fi
        # If jq fails, it might be JSONC (JSON with comments), try Python
    fi

    if command -v python3 &> /dev/null; then
        # Handle JSONC (JSON with Comments) - strip comments before parsing
        error_msg=$(python3 -c "
import json
import re
import sys

with open('$file', 'r') as f:
    lines = f.readlines()

# Process line by line to safely handle comments
cleaned_lines = []
for line in lines:
    stripped = line.strip()
    # Skip full-line block comments
    if stripped.startswith('/*') and stripped.endswith('*/'):
        continue
    # Skip line comments at start
    if re.match(r'^\s*//', stripped):
        continue
    cleaned_lines.append(line)

content = ''.join(cleaned_lines)
# Remove trailing commas before } or ]
content = re.sub(r',\s*([}\]])', r'\1', content)

try:
    json.loads(content)
except json.JSONDecodeError as e:
    print(f'Line {e.lineno}, Column {e.colno}: {e.msg}', file=sys.stderr)
    sys.exit(1)
" 2>&1)
        if [ $? -eq 0 ]; then
            return 0
        fi
        echo ""
        echo -e "    ${RED}JSON Error:${RESET} $error_msg"
        return 1
    fi

    echo ""
    echo -e "    ${YELLOW}Warning:${RESET} No JSON validator available (install jq or python3)"
    return 1
}

# ============================================================================
# Validation Tests
# ============================================================================

echo -e "${CYAN}Processing and validating templates...${RESET}"
echo ""

# Test YAML templates
yaml_templates=(
    ".template/.github/workflows/ci.yml.template"
    ".template/.github/workflows/quality.yml.template"
    ".template/.pre-commit-config.yaml.template"
    ".template/configs/go/.golangci.yml.template"
)

for template in "${yaml_templates[@]}"; do
    if [ -f "$template" ]; then
        output_file="$TEST_OUTPUT_DIR/$(basename "$template" .template)"
        process_test_template "$template" "$output_file"

        echo -n "  Testing $(basename "$template")... "

        if ! check_unprocessed_variables "$output_file"; then
            ((ERRORS++))
            continue
        fi

        if validate_yaml "$output_file"; then
            echo -e "${GREEN}PASS${RESET}"
        else
            echo -e "${RED}FAIL${RESET} (YAML syntax error)"
            ((ERRORS++))
        fi
    else
        echo -e "  ${YELLOW}SKIP${RESET}: $template (not found)"
        ((WARNINGS++))
    fi
done

echo ""

# Test TOML templates
toml_templates=(
    ".template/configs/python/pyproject.toml.template"
    ".template/configs/python/ruff.toml.template"
    ".template/configs/rust/Cargo.toml.template"
)

for template in "${toml_templates[@]}"; do
    if [ -f "$template" ]; then
        output_file="$TEST_OUTPUT_DIR/$(basename "$template" .template)"
        process_test_template "$template" "$output_file"

        echo -n "  Testing $(basename "$template")... "

        if ! check_unprocessed_variables "$output_file"; then
            ((ERRORS++))
            continue
        fi

        if validate_toml "$output_file"; then
            echo -e "${GREEN}PASS${RESET}"
        else
            echo -e "${RED}FAIL${RESET} (TOML syntax error)"
            ((ERRORS++))
        fi
    else
        echo -e "  ${YELLOW}SKIP${RESET}: $template (not found)"
        ((WARNINGS++))
    fi
done

echo ""

# Test JSON templates
json_templates=(
    ".template/configs/node/package.json.template"
    ".template/configs/node/tsconfig.json.template"
)

for template in "${json_templates[@]}"; do
    if [ -f "$template" ]; then
        output_file="$TEST_OUTPUT_DIR/$(basename "$template" .template)"
        process_test_template "$template" "$output_file"

        echo -n "  Testing $(basename "$template")... "

        if ! check_unprocessed_variables "$output_file"; then
            ((ERRORS++))
            continue
        fi

        if validate_json "$output_file"; then
            echo -e "${GREEN}PASS${RESET}"
        else
            echo -e "${RED}FAIL${RESET} (JSON syntax error)"
            ((ERRORS++))
        fi
    else
        echo -e "  ${YELLOW}SKIP${RESET}: $template (not found)"
        ((WARNINGS++))
    fi
done

echo ""

# Test INI templates (basic validation)
ini_templates=(
    ".template/configs/python/pytest.ini.template"
)

for template in "${ini_templates[@]}"; do
    if [ -f "$template" ]; then
        output_file="$TEST_OUTPUT_DIR/$(basename "$template" .template)"
        process_test_template "$template" "$output_file"

        echo -n "  Testing $(basename "$template")... "

        if ! check_unprocessed_variables "$output_file"; then
            ((ERRORS++))
            continue
        fi

        # INI files don't have strict validation, just check for unprocessed vars
        echo -e "${GREEN}PASS${RESET}"
    else
        echo -e "  ${YELLOW}SKIP${RESET}: $template (not found)"
        ((WARNINGS++))
    fi
done

echo ""

# Test Go module template
go_templates=(
    ".template/configs/go/go.mod.template"
)

for template in "${go_templates[@]}"; do
    if [ -f "$template" ]; then
        output_file="$TEST_OUTPUT_DIR/$(basename "$template" .template)"
        process_test_template "$template" "$output_file"

        echo -n "  Testing $(basename "$template")... "

        if ! check_unprocessed_variables "$output_file"; then
            ((ERRORS++))
            continue
        fi

        # Check go.mod has valid go version format (X.Y not X.Y.Z)
        if grep -qE '^go [0-9]+\.[0-9]+$' "$output_file"; then
            echo -e "${GREEN}PASS${RESET}"
        else
            echo -e "${RED}FAIL${RESET} (Invalid go version format)"
            ((ERRORS++))
        fi
    else
        echo -e "  ${YELLOW}SKIP${RESET}: $template (not found)"
        ((WARNINGS++))
    fi
done

echo ""

# ============================================================================
# Results
# ============================================================================

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}  VALIDATION PASSED${RESET}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo "  All templates validated successfully!"
    [ $WARNINGS -gt 0 ] && echo "  (${WARNINGS} warnings - some templates not found)"
    echo ""
    exit 0
else
    echo -e "${RED}  VALIDATION FAILED${RESET}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo "  ${ERRORS} error(s) found"
    [ $WARNINGS -gt 0 ] && echo "  ${WARNINGS} warning(s)"
    echo ""
    exit 1
fi
