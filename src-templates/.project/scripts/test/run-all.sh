#!/bin/bash
set -e

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
RESET='\033[0m'

# Helper to read config from .project.yaml
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
    print(val if val and val != {} else '$default')
except:
    print('$default')
" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# Create tmp directory for reports
mkdir -p tmp/reports

REPORT_FILE="tmp/reports/test-report.md"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
FAILED=0

# Start report
cat > "$REPORT_FILE" << EOF
# Test Report

**Generated:** $TIMESTAMP

---

EOF

echo -e "${CYAN}Running all tests...${RESET}"

# Test Go packages
echo "## Go Tests" >> "$REPORT_FILE"
if find . -name "go.mod" -type f -not -path "./v0/*" -not -path "./.template/*" | grep -q .; then
    echo -e "${CYAN}Testing Go packages...${RESET}"
    if go test ./... -v 2>&1 | tee /tmp/go-test.log; then
        echo "✅ **PASSED**" >> "$REPORT_FILE"
        echo -e "${GREEN}✓${RESET} Go tests passed"
    else
        echo "❌ **FAILED**" >> "$REPORT_FILE"
        echo -e "${RED}✗${RESET} Go tests failed"
        FAILED=1
    fi
else
    echo "_No Go packages found_" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# Test Python packages
echo "## Python Tests" >> "$REPORT_FILE"
PYTHON_TESTED=false

# Check for pytest
if command -v pytest &> /dev/null; then
    # Test root pyproject.toml
    if [ -f "pyproject.toml" ]; then
        PYTHON_TESTED=true
        echo -e "${CYAN}Testing Python packages...${RESET}"
        if pytest -v --tb=short 2>&1 | tee /tmp/python-test.log; then
            echo "✅ **PASSED**" >> "$REPORT_FILE"
            echo -e "${GREEN}✓${RESET} Python tests passed"
        else
            echo "❌ **FAILED**" >> "$REPORT_FILE"
            echo -e "${RED}✗${RESET} Python tests failed"
            FAILED=1
        fi
    fi

    # Test service-specific packages
    for dir in $(find pkg/python services/python -name "pyproject.toml" 2>/dev/null | xargs -r dirname | sort -u); do
        if [ -d "$dir" ]; then
            PYTHON_TESTED=true
            echo "### $(basename $dir)" >> "$REPORT_FILE"
            if (cd "$dir" && pytest -v --tb=short 2>&1); then
                echo "✅ Passed" >> "$REPORT_FILE"
            else
                echo "❌ Failed" >> "$REPORT_FILE"
                FAILED=1
            fi
        fi
    done
fi

if [ "$PYTHON_TESTED" = false ]; then
    echo "_No Python test packages found_" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# Test Next.js frontend
echo "## Next.js Tests" >> "$REPORT_FILE"
if [ -d "frontend" ] && [ -f "frontend/package.json" ]; then
    # Check if test script exists in package.json
    if grep -q '"test"' frontend/package.json 2>/dev/null; then
        echo -e "${CYAN}Testing Next.js frontend...${RESET}"

        # Get coverage threshold from config
        NEXTJS_THRESHOLD=$(read_config "nextjs.coverage_threshold" "")
        if [ -z "$NEXTJS_THRESHOLD" ]; then
            NEXTJS_THRESHOLD=$(read_config "quality.coverage_threshold" "80")
        fi

        # Run tests with coverage
        echo "### Test Results" >> "$REPORT_FILE"
        if (cd frontend && npm test -- --coverage --passWithNoTests 2>&1) | tee /tmp/nextjs-test.log; then
            echo "✅ **PASSED**" >> "$REPORT_FILE"
            echo -e "${GREEN}✓${RESET} Next.js tests passed"

            # Check coverage if coverage report exists
            if [ -f "frontend/coverage/coverage-summary.json" ]; then
                echo "" >> "$REPORT_FILE"
                echo "### Coverage" >> "$REPORT_FILE"
                COVERAGE=$(python3 -c "
import json
with open('frontend/coverage/coverage-summary.json') as f:
    data = json.load(f)
    total = data.get('total', {})
    lines = total.get('lines', {}).get('pct', 0)
    print(f'{lines:.1f}')
" 2>/dev/null || echo "0")
                echo "- Lines: ${COVERAGE}% (threshold: ${NEXTJS_THRESHOLD}%)" >> "$REPORT_FILE"
                echo -e "${CYAN}  Coverage: ${COVERAGE}% (threshold: ${NEXTJS_THRESHOLD}%)${RESET}"

                # Check if below threshold
                if command -v bc &> /dev/null; then
                    if (( $(echo "$COVERAGE < $NEXTJS_THRESHOLD" | bc -l) )); then
                        echo "⚠️ **Below threshold**" >> "$REPORT_FILE"
                        echo -e "${YELLOW}!${RESET} Coverage below threshold"
                    fi
                fi
            fi
        else
            echo "❌ **FAILED**" >> "$REPORT_FILE"
            echo -e "${RED}✗${RESET} Next.js tests failed"
            FAILED=1
        fi
    else
        echo "_No test script in frontend/package.json_" >> "$REPORT_FILE"
        echo -e "${DIM}○ No test script found in frontend/package.json${RESET}"
    fi
else
    echo "_No frontend/ directory found_" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# Summary
echo "---" >> "$REPORT_FILE"
if [ $FAILED -eq 0 ]; then
    echo "## ✅ Result: PASSED" >> "$REPORT_FILE"
    echo -e "${GREEN}✅ All tests passed${RESET}"
else
    echo "## ❌ Result: FAILED" >> "$REPORT_FILE"
    echo -e "${RED}❌ Tests failed${RESET}"
fi

echo -e "${CYAN}📊 Report: $REPORT_FILE${RESET}"

exit $FAILED
