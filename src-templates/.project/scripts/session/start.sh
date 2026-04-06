#!/bin/bash

# Colors
CYAN='\033[36m'
RESET='\033[0m'

echo -e "${CYAN}🤖 AI Session Start${RESET}"
echo "===================="
echo ""

DEVELOPER=$(git config user.name | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g')
SESSIONS_DIR=".ai/sessions/$DEVELOPER"
mkdir -p "$SESSIONS_DIR"

# Find last checkpoint
LAST_CHECKPOINT=$(find "$SESSIONS_DIR" -name "session-*.md" -type f 2>/dev/null | sort -r | head -1)

if [ -n "$LAST_CHECKPOINT" ]; then
    echo -e "${CYAN}📄 Last checkpoint found:${RESET} $LAST_CHECKPOINT"
    echo ""
else
    echo -e "${CYAN}ℹ️  No previous checkpoints found for $DEVELOPER${RESET}"
    echo ""
fi

echo -e "${CYAN}📋 Session Start Prompt Available:${RESET} .ai/prompts/session-start.md"
echo ""

# Ask if user wants to create a tmp file with the prompts
read -p "Would you like to create a tmp file with the session prompts? (y/n): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""

    # If there's a checkpoint, extract info and show to user
    USE_CHECKPOINT="n"
    PREV_GOAL=""

    if [ -n "$LAST_CHECKPOINT" ]; then
        echo -e "${CYAN}═══════════════════════════════════════════════════════════${RESET}"
        echo -e "${CYAN}Previous session found${RESET}"
        echo -e "${CYAN}═══════════════════════════════════════════════════════════${RESET}"
        echo ""

        # Try to extract what was accomplished
        ACCOMPLISHED=$(grep -m 1 "^## Accomplished" "$LAST_CHECKPOINT" -A 1 2>/dev/null | tail -1 | sed 's/^[[:space:]]*-[[:space:]]*//')
        if [ -n "$ACCOMPLISHED" ]; then
            echo "Last accomplished:"
            echo "  → $ACCOMPLISHED"
            echo ""
        fi

        # Try to extract the next session goal from the checkpoint
        PREV_GOAL=$(awk '/^### Goal$/{getline; while(NF==0) getline; print; exit}' "$LAST_CHECKPOINT")
        if [ -n "$PREV_GOAL" ]; then
            echo "Next session goal (from checkpoint):"
            echo "  → $PREV_GOAL"
            echo ""
        fi

        read -p "Continue from this checkpoint? (y/n): " -n 1 -r USE_CHECKPOINT
        echo ""
        echo ""
    fi

    # Now ask for the session goal
    echo -e "${CYAN}What is your goal for this session?${RESET}"

    if [[ $USE_CHECKPOINT =~ ^[Yy]$ ]] && [ -n "$PREV_GOAL" ]; then
        echo ""
        echo "Goal from checkpoint: \"$PREV_GOAL\""
        echo ""
        echo "Your options:"
        echo "  • Press Enter to accept this goal"
        echo "  • Type a new/modified goal to use instead"
        echo "  • Type 'skip' to leave as placeholder {YOUR_GOAL_HERE}"
        echo ""
    elif [ -n "$PREV_GOAL" ]; then
        echo ""
        echo "Available goal from checkpoint: \"$PREV_GOAL\""
        echo ""
        echo "Your options:"
        echo "  • Type your own goal for this fresh start"
        echo "  • Press Enter to leave as placeholder {YOUR_GOAL_HERE}"
        echo ""
    else
        echo "(Press Enter to leave as placeholder if you'll decide later)"
        echo ""
    fi

    read -p "> " SESSION_GOAL

    # Handle 'skip' keyword
    if [ "$SESSION_GOAL" = "skip" ]; then
        SESSION_GOAL=""
    fi

    # Provide feedback on what was chosen
    echo ""
    if [[ $USE_CHECKPOINT =~ ^[Yy]$ ]] && [ -z "$SESSION_GOAL" ] && [ -n "$PREV_GOAL" ]; then
        SESSION_GOAL="$PREV_GOAL"
        echo -e "${CYAN}✓ Using goal from checkpoint${RESET}"
    elif [ -n "$SESSION_GOAL" ]; then
        echo -e "${CYAN}✓ Using custom goal: \"$SESSION_GOAL\"${RESET}"
    else
        echo -e "${CYAN}ℹ Goal left as placeholder - you'll need to edit the prompt${RESET}"
    fi

    # Ensure goal ends with proper punctuation if it's set
    if [ -n "$SESSION_GOAL" ] && [[ ! "$SESSION_GOAL" =~ [.!?]$ ]]; then
        SESSION_GOAL="${SESSION_GOAL}."
    fi

    # Create tmp directory if it doesn't exist
    TMP_DIR="tmp"
    mkdir -p "$TMP_DIR"

    TMP_FILE="$TMP_DIR/session-start-$(date +%Y%m%d-%H%M%S).md"

    {
        echo "# Session Start - Copy & Paste These Prompts"
        echo ""
        if [[ $USE_CHECKPOINT =~ ^[Yy]$ ]] && [ -n "$LAST_CHECKPOINT" ]; then
            echo "**Continuing from checkpoint:** \`$LAST_CHECKPOINT\`"
            echo ""
        elif [ -n "$LAST_CHECKPOINT" ]; then
            echo "**Starting fresh** (previous checkpoint available but not used: \`$LAST_CHECKPOINT\`)"
            echo ""
        fi
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "## 🎯 PROMPT 1: Plan the Session"
        echo ""
        if [ -z "$SESSION_GOAL" ]; then
            echo "**Instructions:** Copy the prompt below, replace \`{YOUR_GOAL_HERE}\` with your actual goal, then paste to AI."
        else
            echo "**Instructions:** Copy the prompt below and paste to AI (goal already filled in)."
        fi
        echo ""
        echo "\`\`\`"

        if [[ $USE_CHECKPOINT =~ ^[Yy]$ ]] && [ -n "$LAST_CHECKPOINT" ]; then
            # User chose to continue from checkpoint
            sed -e "s|{CHECKPOINT_PATH}|$LAST_CHECKPOINT|g" \
                -e "s|{IF_CONTINUING_FROM_CHECKPOINT}||g" \
                -e "s|{END_IF}||g" \
                .ai/prompts/planning-prompt.md | \
            if [ -n "$SESSION_GOAL" ]; then
                sed "s|{YOUR_GOAL_HERE}|$SESSION_GOAL|g"
            else
                cat
            fi
        else
            # User chose fresh start (remove checkpoint section)
            sed -e '/^{IF_CONTINUING_FROM_CHECKPOINT}$/,/^{END_IF}$/d' \
                .ai/prompts/planning-prompt.md | \
            if [ -n "$SESSION_GOAL" ]; then
                sed "s|{YOUR_GOAL_HERE}|$SESSION_GOAL|g"
            else
                cat
            fi
        fi

        echo "\`\`\`"
        echo ""
        echo "**What to expect:** AI will analyze your goal and create a detailed plan with file changes, components, tests, and architecture alignment."
        echo ""
        echo "📚 *For planning best practices, see: .ai/prompts/session-start.md*"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "## ⚡ PROMPT 2: Execute Step-by-Step"
        echo ""
        echo "**Instructions:** After reviewing and approving the plan, copy the prompt below and replace \`{FIRST_COMPONENT_FROM_PLAN}\` with the first component from the plan."
        echo ""
        echo "\`\`\`"

        cat .ai/prompts/execution-prompt.md

        echo "\`\`\`"
        echo ""
        echo "**What to expect:** AI will explain what/why/how before implementing each component, ensuring alignment with your architecture."
        echo ""
        echo "📚 *For step-by-step guidance, see: .ai/prompts/step-by-step.md*"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "💡 **Full workflow guide:** docs/developer-guide/session-workflow.md"
    } > "$TMP_FILE"

    echo -e "${CYAN}✅ Created tmp file:${RESET} $TMP_FILE"
    echo ""
    echo "You can now:"
    echo "  • View the file: cat $TMP_FILE"
    echo "  • Edit the file: \$EDITOR $TMP_FILE"
    echo "  • Copy the prompts from the file"
    echo ""
else
    echo -e "${CYAN}Skipped creating tmp file${RESET}"
    echo ""
fi

echo "════════════════════════════════════════════════════════════════"
echo -e "${CYAN}📖 Next Steps:${RESET}"
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "1. Review the tmp file: $TMP_FILE"
    if [ -n "$LAST_CHECKPOINT" ]; then
        echo "2. Decide if you want to continue from the checkpoint or start fresh"
        echo "3. Tell AI your goal (mention checkpoint if continuing)"
    else
        echo "2. Tell AI your goal and ask it to plan the session"
    fi
    echo "$([ -n "$LAST_CHECKPOINT" ] && echo "4" || echo "3"). Validate the plan (scope, architecture alignment)"
    echo "$([ -n "$LAST_CHECKPOINT" ] && echo "5" || echo "4"). Begin step-by-step development"
else
    if [ -n "$LAST_CHECKPOINT" ]; then
        echo "1. Review the checkpoint: $LAST_CHECKPOINT"
        echo "2. Decide if you want to continue from the checkpoint or start fresh"
        echo "3. Tell AI your goal (mention checkpoint if continuing)"
    else
        echo "1. This is a new session (no previous checkpoint)"
        echo "2. Read the session start prompt: .ai/prompts/session-start.md"
        echo "3. Tell AI your goal and ask it to plan the session"
    fi
    echo "$([ -n "$LAST_CHECKPOINT" ] && echo "4" || echo "4"). Validate the plan (scope, architecture alignment)"
    echo "$([ -n "$LAST_CHECKPOINT" ] && echo "5" || echo "5"). Begin step-by-step development"
fi

echo ""
echo "💡 See: docs/developer-guide/session-workflow.md for full guide"
