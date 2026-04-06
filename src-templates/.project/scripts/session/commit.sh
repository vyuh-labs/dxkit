#!/bin/bash

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

echo -e "${CYAN}💾 Commit Session Work${RESET}"
echo "======================"
echo ""

DEVELOPER=$(git config user.name | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g')
DATE=$(date +%Y-%m-%d)
CHECKPOINT_DIR=".ai/sessions/$DEVELOPER/$DATE"
CHECKPOINT_FILE=""

if [ -d "$CHECKPOINT_DIR" ]; then
    CHECKPOINT_FILE=$(ls -t "$CHECKPOINT_DIR"/session-*.md 2>/dev/null | head -1)
fi

if [ -z "$CHECKPOINT_FILE" ]; then
    echo -e "${RED}⚠️  No checkpoint found for today.${RESET}"
    echo "Run: make ai-checkpoint first"
    exit 1
fi

echo -e "${CYAN}Checkpoint:${RESET} $CHECKPOINT_FILE"
echo ""

read -p "Commit type (feat/fix/docs/refactor/test/chore): " TYPE
read -p "Brief description: " DESC
echo ""

echo -e "${CYAN}Specific changes (one per line, empty line to finish):${RESET}"
CHANGES=""
while true; do
    read -p "- " CHANGE
    if [ -z "$CHANGE" ]; then break; fi
    CHANGES="${CHANGES}- $CHANGE\n"
done

echo ""
COMMIT_MSG="$TYPE: $DESC\n\n${CHANGES}\nSession: $CHECKPOINT_FILE"

echo -e "${CYAN}Commit message:${RESET}"
echo "---"
echo -e "$COMMIT_MSG"
echo "---"
echo ""

read -p "Commit with this message? (y/n): " CONFIRM
if [ "$CONFIRM" = "y" ]; then
    git add .

    # Use --no-verify if SKIP_VERIFY is set (skip git hooks)
    if [ "$SKIP_VERIFY" = "1" ]; then
        echo -e "${CYAN}⚠️  Skipping git hooks (--no-verify)${RESET}"
        git commit --no-verify -m "$(echo -e "$COMMIT_MSG")"
    else
        git commit -m "$(echo -e "$COMMIT_MSG")"
    fi

    echo -e "${GREEN}✅ Committed!${RESET}"
    echo ""
    echo -e "${CYAN}Next steps:${RESET}"
    echo "  make session-push"
else
    echo -e "${RED}❌ Commit cancelled${RESET}"
fi
