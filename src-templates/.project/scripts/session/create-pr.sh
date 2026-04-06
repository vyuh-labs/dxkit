#!/bin/bash

# Create Pull Request with Auto-Populated Content

set -e

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}🚀 Create Pull Request${RESET}"
echo "======================================"
echo ""

# Get current branch and base branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH=${1:-main}

# Validate not on main/master
if [[ "$CURRENT_BRANCH" == "main" ]] || [[ "$CURRENT_BRANCH" == "master" ]]; then
    echo -e "${RED}❌ Error: Cannot create PR from main/master branch${RESET}"
    echo "Create a feature branch first: git checkout -b feature/your-feature"
    exit 1
fi

echo -e "${CYAN}Branch Information:${RESET}"
echo "  Current branch: ${GREEN}$CURRENT_BRANCH${RESET}"
echo "  Base branch: ${GREEN}$BASE_BRANCH${RESET}"
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}❌ Error: GitHub CLI (gh) not found${RESET}"
    echo "Install with: brew install gh"
    echo "Or visit: https://cli.github.com/"
    exit 1
fi

# Check if branch is pushed to remote
if ! git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" &>/dev/null; then
    echo -e "${YELLOW}⚠️  Branch not pushed to remote${RESET}"
    read -p "Push branch to remote? (y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${CYAN}Pushing branch...${RESET}"
        git push -u origin "$CURRENT_BRANCH"
        echo -e "${GREEN}✓${RESET} Branch pushed"
        echo ""
    else
        echo -e "${RED}❌ Cannot create PR without pushing branch${RESET}"
        exit 1
    fi
fi

# Get commit information
echo -e "${CYAN}Analyzing changes...${RESET}"
echo ""

# Get all commits in this branch (not in base branch)
COMMITS=$(git log "$BASE_BRANCH".."$CURRENT_BRANCH" --oneline --no-decorate)
COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')
FIRST_COMMIT_MSG=$(git log "$BASE_BRANCH".."$CURRENT_BRANCH" --format=%s --reverse | head -1)

# Get file changes summary
FILES_CHANGED=$(git diff --name-only "$BASE_BRANCH"..."$CURRENT_BRANCH" | wc -l | tr -d ' ')
GO_FILES=$(git diff --name-only "$BASE_BRANCH"..."$CURRENT_BRANCH" | grep "\.go$" | wc -l | tr -d ' ')
PY_FILES=$(git diff --name-only "$BASE_BRANCH"..."$CURRENT_BRANCH" | grep "\.py$" | wc -l | tr -d ' ')

# Get diff stats
DIFF_STATS=$(git diff --stat "$BASE_BRANCH"..."$CURRENT_BRANCH")
INSERTIONS=$(echo "$DIFF_STATS" | tail -1 | grep -oP '\d+(?= insertion)' || echo "0")
DELETIONS=$(echo "$DIFF_STATS" | tail -1 | grep -oP '\d+(?= deletion)' || echo "0")

echo "  Commits: $COMMIT_COUNT"
echo "  Files changed: $FILES_CHANGED (Go: $GO_FILES, Python: $PY_FILES)"
echo "  Lines: +$INSERTIONS -$DELETIONS"
echo ""

# Generate PR title from first commit or branch name
if [ -n "$FIRST_COMMIT_MSG" ]; then
    PR_TITLE="$FIRST_COMMIT_MSG"
else
    PR_TITLE=$(echo "$CURRENT_BRANCH" | sed 's|feature/||' | sed 's|bugfix/||' | sed 's|fix/||' | sed 's/-/ /g' | sed 's/\b\(.\)/\u\1/g')
fi

echo -e "${CYAN}PR Title:${RESET} $PR_TITLE"
echo ""

# Generate description based on commits
DESCRIPTION=$(git log "$BASE_BRANCH".."$CURRENT_BRANCH" --format="- %s" --reverse | head -10)

# Build PR body
PR_BODY="## Description

$DESCRIPTION

## Type of Change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] 📚 Documentation update
- [ ] ♻️ Refactoring
- [ ] ⚡ Performance improvement

## Checklist

- [ ] Code follows project style guidelines
- [ ] \`make quality\` passes
- [ ] \`make test\` passes
- [ ] Documentation updated (if needed)

## Testing Instructions

1. Checkout this branch: \`git checkout $CURRENT_BRANCH\`
2. Run quality checks: \`make quality\`
3. Run tests: \`make test\`
4. Verify changes work as expected

---
🤖 Generated with AI-assisted development
"

# Create temporary file for PR body
TMP_PR_FILE="tmp/pr-body-$(date +%Y%m%d-%H%M%S).md"
mkdir -p tmp
echo "$PR_BODY" > "$TMP_PR_FILE"

echo -e "${CYAN}PR Body Preview:${RESET}"
head -20 "$TMP_PR_FILE"
echo "..."
echo ""

# Confirm before creating PR
read -p "Create PR with this content? (y/n): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}⚠️  Cancelled${RESET}"
    echo "PR body saved at: $TMP_PR_FILE"
    exit 0
fi

echo ""
echo -e "${CYAN}Creating pull request...${RESET}"

# Create PR using gh CLI
if gh pr create --title "$PR_TITLE" --body-file "$TMP_PR_FILE" --base "$BASE_BRANCH"; then
    echo ""
    echo -e "${GREEN}✅ Pull request created successfully!${RESET}"
    echo ""
    PR_URL=$(gh pr view --json url --jq .url)
    echo -e "${CYAN}🔗 PR URL:${RESET} $PR_URL"
else
    echo ""
    echo -e "${RED}❌ Failed to create PR${RESET}"
    echo "PR body saved at: $TMP_PR_FILE"
    exit 1
fi

echo ""
echo -e "${GREEN}✨ Done!${RESET}"
