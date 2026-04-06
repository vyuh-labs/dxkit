#!/bin/bash
# Sync template updates from the upstream template repository
# This allows pulling improvements without recreating the repo

set -e

# Source .env if it exists (for TEMPLATE_REPO_URL)
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# Configuration (after .env is sourced)
TEMPLATE_REMOTE="template-upstream"
TEMPLATE_REPO="${TEMPLATE_REPO_URL:-https://github.com/siddarthc/codespaces-ai-template-v2.git}"
TEMPLATE_BRANCH="${TEMPLATE_BRANCH:-main}"

# Files/directories to sync from template
SYNC_PATHS=(
    ".template/"
    "bootstrap.sh"
)

# Files to preserve (never overwrite)
PRESERVE_FILES=(
    ".project.yaml"
    ".env"
    ".env.local"
    ".env.secrets"
)

usage() {
    echo -e "${CYAN}Usage:${RESET} $0 [command]"
    echo ""
    echo -e "${CYAN}Commands:${RESET}"
    echo "  check     Check for available updates (default)"
    echo "  preview   Show diff of what would change"
    echo "  apply     Apply template updates"
    echo "  status    Show sync status"
    echo ""
    echo -e "${CYAN}Environment Variables:${RESET}"
    echo "  TEMPLATE_REPO_URL   Override template repository URL"
    echo "  TEMPLATE_BRANCH     Override template branch (default: main)"
}

# Ensure template remote exists
setup_remote() {
    if ! git remote get-url "$TEMPLATE_REMOTE" &>/dev/null; then
        echo -e "${CYAN}Adding template remote...${RESET}"
        git remote add "$TEMPLATE_REMOTE" "$TEMPLATE_REPO"
    else
        # Update URL if changed
        local current_url
        current_url=$(git remote get-url "$TEMPLATE_REMOTE")
        if [ "$current_url" != "$TEMPLATE_REPO" ]; then
            echo -e "${CYAN}Updating template remote URL...${RESET}"
            git remote set-url "$TEMPLATE_REMOTE" "$TEMPLATE_REPO"
        fi
    fi
}

# Fetch latest from template
fetch_template() {
    echo -e "${CYAN}Fetching latest from template repository...${RESET}"
    echo -e "${DIM}URL: $TEMPLATE_REPO${RESET}"

    # Try fetching (use credential helper for private repos)
    if ! git fetch "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH" --quiet 2>/dev/null; then
        # Retry without credentials for public repos
        if ! GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH" --quiet 2>/dev/null; then
            echo -e "${RED}Failed to fetch from template repository${RESET}"
            echo -e "${DIM}For private repos, use SSH URL in .env:${RESET}"
            echo -e "${DIM}  TEMPLATE_REPO_URL=git@github.com:user/repo.git${RESET}"
            exit 1
        fi
    fi
}

# Get current template version (last synced commit)
get_local_version() {
    if [ -f ".template-version" ]; then
        cat ".template-version"
    else
        echo "unknown"
    fi
}

# Get latest template version
get_remote_version() {
    git rev-parse "$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" 2>/dev/null || echo "unknown"
}

# Check for updates
check_updates() {
    setup_remote
    fetch_template

    local local_version
    local remote_version
    local_version=$(get_local_version)
    remote_version=$(get_remote_version)

    echo -e "${CYAN}Template Sync Status${RESET}"
    echo "===================="
    echo ""
    echo -e "  ${DIM}Local version:${RESET}  ${local_version:0:8}"
    echo -e "  ${DIM}Remote version:${RESET} ${remote_version:0:8}"
    echo ""

    if [ "$local_version" = "$remote_version" ]; then
        echo -e "${GREEN}Already up to date${RESET}"
        return 0
    elif [ "$local_version" = "unknown" ]; then
        echo -e "${YELLOW}Template version not tracked yet${RESET}"
        echo -e "${DIM}Run 'make sync-template-apply' to sync and start tracking${RESET}"
        return 1
    else
        # Count commits behind
        local commits_behind
        commits_behind=$(git rev-list --count "$local_version".."$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" 2>/dev/null || echo "?")
        echo -e "${YELLOW}$commits_behind commit(s) behind template${RESET}"
        echo ""
        echo -e "${DIM}Run 'make sync-template-preview' to see changes${RESET}"
        echo -e "${DIM}Run 'make sync-template-apply' to apply updates${RESET}"
        return 1
    fi
}

# Preview changes
preview_changes() {
    setup_remote
    fetch_template

    local local_version
    local_version=$(get_local_version)

    echo -e "${CYAN}Preview: Template Changes${RESET}"
    echo "========================="
    echo ""

    if [ "$local_version" = "unknown" ]; then
        echo -e "${YELLOW}No baseline version - showing current template state${RESET}"
        echo ""
        for path in "${SYNC_PATHS[@]}"; do
            if git ls-tree -r "$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" --name-only "$path" 2>/dev/null | head -10; then
                :
            fi
        done
        return 0
    fi

    echo -e "${DIM}Changes from ${local_version:0:8} to $(get_remote_version | head -c 8)${RESET}"
    echo ""

    # Show commit log
    echo -e "${CYAN}Commits:${RESET}"
    git log --oneline "$local_version".."$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" -- "${SYNC_PATHS[@]}" 2>/dev/null | head -20
    echo ""

    # Show file changes
    echo -e "${CYAN}Changed files:${RESET}"
    git diff --stat "$local_version".."$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" -- "${SYNC_PATHS[@]}" 2>/dev/null
    echo ""

    # Show detailed diff (truncated)
    echo -e "${CYAN}Diff preview (first 100 lines):${RESET}"
    git diff "$local_version".."$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" -- "${SYNC_PATHS[@]}" 2>/dev/null | head -100

    local total_lines
    total_lines=$(git diff "$local_version".."$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" -- "${SYNC_PATHS[@]}" 2>/dev/null | wc -l)
    if [ "$total_lines" -gt 100 ]; then
        echo ""
        echo -e "${DIM}... ($((total_lines - 100)) more lines)${RESET}"
    fi
}

# Apply updates
apply_updates() {
    setup_remote
    fetch_template

    local remote_version
    remote_version=$(get_remote_version)

    echo -e "${CYAN}Applying Template Updates${RESET}"
    echo "========================="
    echo ""

    # Check for uncommitted changes
    if ! git diff-index --quiet HEAD -- "${SYNC_PATHS[@]}" 2>/dev/null; then
        echo -e "${YELLOW}Warning: You have uncommitted changes in template files${RESET}"
        echo -e "${DIM}Consider committing or stashing them first${RESET}"
        echo ""
        read -p "Continue anyway? [y/N]: " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${RED}Aborted${RESET}"
            exit 1
        fi
    fi

    # Backup preserved files
    echo -e "${CYAN}Backing up preserved files...${RESET}"
    local backup_dir=".template-sync-backup"
    rm -rf "$backup_dir"
    mkdir -p "$backup_dir"

    for file in "${PRESERVE_FILES[@]}"; do
        if [ -f "$file" ]; then
            cp "$file" "$backup_dir/"
            echo -e "  ${DIM}Backed up: $file${RESET}"
        fi
    done

    # Checkout template files
    echo ""
    echo -e "${CYAN}Updating template files...${RESET}"
    for path in "${SYNC_PATHS[@]}"; do
        if git ls-tree -r "$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" --name-only "$path" &>/dev/null; then
            echo -e "  ${DIM}Syncing: $path${RESET}"
            git checkout "$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" -- "$path" 2>/dev/null || true
        fi
    done

    # Restore preserved files
    echo ""
    echo -e "${CYAN}Restoring preserved files...${RESET}"
    for file in "${PRESERVE_FILES[@]}"; do
        if [ -f "$backup_dir/$(basename "$file")" ]; then
            cp "$backup_dir/$(basename "$file")" "$file"
            echo -e "  ${DIM}Restored: $file${RESET}"
        fi
    done

    # Clean up backup
    rm -rf "$backup_dir"

    # Update version file
    echo "$remote_version" > ".template-version"
    echo ""
    echo -e "${GREEN}Template updated to ${remote_version:0:8}${RESET}"
    echo ""

    # Show what changed
    echo -e "${CYAN}Changes applied:${RESET}"
    git status --short "${SYNC_PATHS[@]}" .template-version 2>/dev/null
    echo ""

    echo -e "${DIM}Review changes with: git diff${RESET}"
    echo -e "${DIM}Commit with: git add -A && git commit -m 'chore: sync template updates'${RESET}"
}

# Show status
show_status() {
    echo -e "${CYAN}Template Sync Configuration${RESET}"
    echo "============================"
    echo ""
    echo -e "  ${DIM}Remote name:${RESET}    $TEMPLATE_REMOTE"
    echo -e "  ${DIM}Repository:${RESET}     $TEMPLATE_REPO"
    echo -e "  ${DIM}Branch:${RESET}         $TEMPLATE_BRANCH"
    echo ""

    if git remote get-url "$TEMPLATE_REMOTE" &>/dev/null; then
        echo -e "  ${GREEN}Remote configured${RESET}"
    else
        echo -e "  ${YELLOW}Remote not configured${RESET}"
    fi

    echo ""
    echo -e "${CYAN}Sync Paths:${RESET}"
    for path in "${SYNC_PATHS[@]}"; do
        echo -e "  - $path"
    done

    echo ""
    echo -e "${CYAN}Preserved Files:${RESET}"
    for file in "${PRESERVE_FILES[@]}"; do
        if [ -f "$file" ]; then
            echo -e "  - $file ${GREEN}(exists)${RESET}"
        else
            echo -e "  - $file ${DIM}(not found)${RESET}"
        fi
    done

    echo ""
    local_version=$(get_local_version)
    echo -e "${CYAN}Version Tracking:${RESET}"
    if [ "$local_version" = "unknown" ]; then
        echo -e "  ${YELLOW}Not tracking template version${RESET}"
        echo -e "  ${DIM}Run sync-template-apply to start tracking${RESET}"
    else
        echo -e "  ${DIM}Last synced:${RESET} ${local_version:0:8}"
    fi
}

# Main
case "${1:-check}" in
    check)
        check_updates
        ;;
    preview)
        preview_changes
        ;;
    apply)
        apply_updates
        ;;
    status)
        show_status
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo -e "${RED}Unknown command: $1${RESET}"
        usage
        exit 1
        ;;
esac
