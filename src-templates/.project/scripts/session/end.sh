#!/bin/bash

# Interactive session end script
# Leverages AI context to create comprehensive checkpoint

set -e

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}📋 Session End - Create Checkpoint${RESET}"
echo "================================"
echo ""

# Get developer info
DEVELOPER=$(git config user.name | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g')
DATE=$(date +%Y-%m-%d)
SESSIONS_DIR=".ai/sessions/$DEVELOPER/$DATE"

# Create sessions directory if it doesn't exist
mkdir -p "$SESSIONS_DIR"

# Find next session number
SESSION_NUM=1
while [ -f "$SESSIONS_DIR/session-$SESSION_NUM.md" ]; do
    SESSION_NUM=$((SESSION_NUM + 1))
done

CHECKPOINT_FILE="$SESSIONS_DIR/session-$SESSION_NUM.md"

echo -e "${CYAN}Session Information:${RESET}"
echo "  Developer: $DEVELOPER"
echo "  Date: $DATE"
echo "  Session: $SESSION_NUM"
echo "  Checkpoint: $CHECKPOINT_FILE"
echo ""

# Show recent activity
echo -e "${CYAN}Recent Activity:${RESET}"
echo ""

# Show recent commits (if any)
RECENT_COMMITS=$(git log --since="6 hours ago" --oneline --no-decorate 2>/dev/null | head -5)
if [ -n "$RECENT_COMMITS" ]; then
    echo "Recent commits:"
    echo "$RECENT_COMMITS" | sed 's/^/  /'
    echo ""
fi

# Show current changes
CURRENT_CHANGES=$(git status --short 2>/dev/null)
if [ -n "$CURRENT_CHANGES" ]; then
    echo "Uncommitted changes:"
    echo "$CURRENT_CHANGES" | sed 's/^/  /'
    echo ""
fi

if [ -z "$RECENT_COMMITS" ] && [ -z "$CURRENT_CHANGES" ]; then
    echo "  (No git activity detected)"
    echo ""
fi

# Create AI prompt from template
TMP_PROMPT_FILE="tmp/session-end-$(date +%Y%m%d-%H%M%S).md"
mkdir -p tmp

# Read template and substitute variables
TEMPLATE_FILE=".ai/prompts/session-end-template.md"

if [ ! -f "$TEMPLATE_FILE" ]; then
    echo -e "${YELLOW}⚠${RESET}  Template not found: $TEMPLATE_FILE"
    exit 1
fi

# Build git activity sections
GIT_COMMITS_SECTION=""
GIT_CHANGES_SECTION=""

if [ -n "$RECENT_COMMITS" ]; then
    GIT_COMMITS_SECTION="Recent commits:
\`\`\`
$RECENT_COMMITS
\`\`\`"
fi

if [ -n "$CURRENT_CHANGES" ]; then
    GIT_CHANGES_SECTION="Current changes:
\`\`\`
$CURRENT_CHANGES
\`\`\`"
fi

# Create detailed instructions file
INSTRUCTIONS_FILE="tmp/session-end-instructions-$(date +%Y%m%d-%H%M%S).md"

awk -v dev="$DEVELOPER" \
    -v date="$DATE" \
    -v session="$SESSION_NUM" \
    -v checkpoint="$CHECKPOINT_FILE" \
    -v commits="$GIT_COMMITS_SECTION" \
    -v changes="$GIT_CHANGES_SECTION" \
    '{
        gsub(/{DEVELOPER}/, dev);
        gsub(/{DATE}/, date);
        gsub(/{SESSION_NUM}/, session);
        gsub(/{CHECKPOINT_FILE}/, checkpoint);
        gsub(/{GIT_COMMITS}/, commits);
        gsub(/{GIT_CHANGES}/, changes);
        print;
    }' "$TEMPLATE_FILE" > "$INSTRUCTIONS_FILE"

# Create short prompt file that references the instructions
cat > "$TMP_PROMPT_FILE" << EOF
Please read the checkpoint instructions and create a comprehensive session checkpoint:

📋 **Instructions**: \`$INSTRUCTIONS_FILE\`

Read that file for complete details on:
- Session information (developer, date, checkpoint location)
- What to document
- How to fill the template
- Recent git activity

Then ask me any clarifying questions and create the checkpoint.
EOF

echo -e "${GREEN}✓${RESET} Checkpoint files created"
echo ""

# Show short prompt
echo -e "${CYAN}Copy This Prompt to AI:${RESET}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
cat "$TMP_PROMPT_FILE"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Copy options
echo -e "${CYAN}Files Created:${RESET}"
echo "  📄 Short prompt: ${YELLOW}$TMP_PROMPT_FILE${RESET}"
echo "  📋 Instructions: ${YELLOW}$INSTRUCTIONS_FILE${RESET}"
echo ""
echo "Choose an option:"
echo "  1) Copy short prompt to clipboard"
echo "  2) I'll copy manually"
echo "  3) Skip for now"
echo ""
read -p "Your choice (1/2/3): " -n 1 -r
echo ""
echo ""

case $REPLY in
    1)
        if command -v pbcopy &> /dev/null; then
            cat "$TMP_PROMPT_FILE" | pbcopy
            echo -e "${GREEN}✓${RESET} Short prompt copied to clipboard!"
        elif command -v xclip &> /dev/null; then
            cat "$TMP_PROMPT_FILE" | xclip -selection clipboard
            echo -e "${GREEN}✓${RESET} Short prompt copied to clipboard!"
        elif command -v clip.exe &> /dev/null; then
            cat "$TMP_PROMPT_FILE" | clip.exe
            echo -e "${GREEN}✓${RESET} Short prompt copied to clipboard!"
        else
            echo -e "${YELLOW}⚠${RESET}  Clipboard tool not found"
            echo "Copy manually from: $TMP_PROMPT_FILE"
        fi
        echo ""
        echo "Paste to AI. The AI will read the instructions file and create the checkpoint."
        ;;
    2)
        echo -e "${GREEN}✓${RESET} Prompt saved at: ${YELLOW}$TMP_PROMPT_FILE${RESET}"
        echo ""
        echo "Copy and paste it to your AI assistant."
        ;;
    3)
        echo -e "${YELLOW}⚠${RESET}  Skipped. Run 'make session-end' again when ready."
        exit 0
        ;;
    *)
        echo -e "${YELLOW}Invalid choice.${RESET}"
        echo "Prompt saved at: $TMP_PROMPT_FILE"
        ;;
esac

echo ""
echo -e "${CYAN}After AI Creates Checkpoint:${RESET}"
echo ""
echo "1. Verify checkpoint: ${YELLOW}$CHECKPOINT_FILE${RESET}"
echo "2. Review for completeness"
echo "3. Commit: ${YELLOW}make session-commit${RESET}"
echo ""

# Skill evolution reminder
if [ -d ".claude/skills" ]; then
    echo -e "${CYAN}Skill Evolution:${RESET}"
    echo "  Update skills with session learnings:"
    echo "  - ${YELLOW}.claude/skills/learned/references/gotchas.md${RESET} (general gotchas)"
    echo "  - ${YELLOW}.claude/skills/learned/references/conventions.md${RESET} (new conventions)"
    echo "  - ${YELLOW}.claude/skills/<area>/references/gotchas.md${RESET} (area-specific)"
    echo ""
fi

echo -e "${GREEN}✨ Great session!${RESET}"
echo ""
