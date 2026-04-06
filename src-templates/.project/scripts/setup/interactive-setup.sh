#!/bin/bash
set -e

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${CYAN}  PROJECT SETUP${RESET}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ============================================================================
# Helper Functions
# ============================================================================

# Read a value from .project.yaml
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
    print('true' if val is True else ('false' if val is False else (val if val else '$default')))
except:
    print('$default')
" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# ============================================================================
# Quality Tools Installation
# ============================================================================

echo -e "${BOLD}Installing Quality Tools${RESET}"
echo ""

# Check enabled languages from config
PYTHON_ENABLED=$(read_config "languages.python.enabled" "false")
GO_ENABLED=$(read_config "languages.go.enabled" "false")
NODE_ENABLED=$(read_config "languages.node.enabled" "false")
RUST_ENABLED=$(read_config "languages.rust.enabled" "false")

# Go tools
if [ "$GO_ENABLED" = "true" ] && command -v go &> /dev/null; then
    echo -e "${CYAN}Go tools:${RESET}"
    if ! command -v golangci-lint &> /dev/null; then
        echo -e "  ${CYAN}→${RESET} Installing golangci-lint..."
        go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest > /dev/null 2>&1 && \
        echo -e "  ${GREEN}✓${RESET} golangci-lint installed"
    else
        echo -e "  ${GREEN}✓${RESET} golangci-lint already installed"
    fi

    if ! command -v goimports &> /dev/null; then
        echo -e "  ${CYAN}→${RESET} Installing goimports..."
        go install golang.org/x/tools/cmd/goimports@latest > /dev/null 2>&1 && \
        echo -e "  ${GREEN}✓${RESET} goimports installed"
    else
        echo -e "  ${GREEN}✓${RESET} goimports already installed"
    fi
    echo ""
fi

# Python tools
if [ "$PYTHON_ENABLED" = "true" ] && command -v pip &> /dev/null; then
    echo -e "${CYAN}Python tools:${RESET}"
    if [ -f "pyproject.toml" ]; then
        echo -e "  ${CYAN}→${RESET} Installing Python dev dependencies..."
        # Versions synced with .template/config/versions.yaml
        pip install -q -e ".[dev]" 2>/dev/null || pip install -q "ruff>=0.8.0" "mypy>=1.8.0" "pytest>=8.0.0" pytest-cov 2>/dev/null
        echo -e "  ${GREEN}✓${RESET} Python tools installed"
    else
        # Versions synced with .template/config/versions.yaml
        pip install -q "ruff>=0.8.0" "mypy>=1.8.0" "pytest>=8.0.0" pytest-cov 2>/dev/null
        echo -e "  ${GREEN}✓${RESET} Python tools installed"
    fi
    echo ""
fi

# Node.js tools
if [ "$NODE_ENABLED" = "true" ] && command -v npm &> /dev/null; then
    echo -e "${CYAN}Node.js tools:${RESET}"
    if [ -f "package.json" ]; then
        echo -e "  ${CYAN}→${RESET} Installing npm dependencies..."
        npm install --silent 2>/dev/null
        echo -e "  ${GREEN}✓${RESET} npm dependencies installed"
    fi
    echo ""
fi

# Rust tools
if [ "$RUST_ENABLED" = "true" ] && command -v rustup &> /dev/null; then
    echo -e "${CYAN}Rust tools:${RESET}"
    rustup component add rustfmt clippy 2>/dev/null
    echo -e "  ${GREEN}✓${RESET} rustfmt and clippy installed"
    echo ""
fi

# ============================================================================
# Cloud Tools Authentication
# ============================================================================

# Read tool configuration
CLAUDE_CODE_ENABLED=$(read_config "tools.claude_code" "false")
GITHUB_CLI_ENABLED=$(read_config "tools.github_cli" "false")
GCLOUD_ENABLED=$(read_config "tools.gcloud" "false")
PULUMI_ENABLED=$(read_config "tools.pulumi" "false")
INFISICAL_ENABLED=$(read_config "tools.infisical" "false")

# Check if any cloud tools are enabled
if [ "$CLAUDE_CODE_ENABLED" = "true" ] || [ "$GITHUB_CLI_ENABLED" = "true" ] || \
   [ "$GCLOUD_ENABLED" = "true" ] || [ "$PULUMI_ENABLED" = "true" ] || \
   [ "$INFISICAL_ENABLED" = "true" ]; then

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${CYAN}  CLOUD TOOLS AUTHENTICATION${RESET}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "${DIM}Set up authentication for your cloud tools.${RESET}"
    echo -e "${DIM}You can skip any tool by pressing Enter or Ctrl+C.${RESET}"
    echo ""
fi

# GitHub CLI
if [ "$GITHUB_CLI_ENABLED" = "true" ]; then
    if command -v gh &> /dev/null; then
        echo -e "${BOLD}GitHub CLI${RESET}"
        if gh auth status &> /dev/null; then
            echo -e "  ${GREEN}✓${RESET} Already authenticated"
            gh auth status 2>&1 | head -3 | sed 's/^/    /'
        else
            echo -e "  ${YELLOW}!${RESET} Not authenticated"
            read -p "  Login to GitHub? [Y/n]: " -n 1 -r gh_login
            echo ""
            if [[ ! $gh_login =~ ^[Nn]$ ]]; then
                gh auth login
            fi
        fi
        echo ""
    fi
fi

# Claude Code CLI
if [ "$CLAUDE_CODE_ENABLED" = "true" ]; then
    if command -v claude &> /dev/null; then
        echo -e "${BOLD}Claude Code CLI${RESET}"

        # Check if API key is configured
        API_KEY_SET=false
        if [ -n "$ANTHROPIC_API_KEY" ] || ([ -f ".env" ] && grep -q "ANTHROPIC_API_KEY" .env 2>/dev/null); then
            API_KEY_SET=true
        fi

        # Check if OAuth is configured (by checking if claude can run without prompting)
        # We can't easily check OAuth status without running claude interactively,
        # so we just check if credentials file exists
        OAUTH_SET=false
        if [ -f "$HOME/.claude/credentials.json" ] || [ -f "$HOME/.config/claude/credentials.json" ]; then
            OAUTH_SET=true
        fi

        if [ "$API_KEY_SET" = "true" ]; then
            echo -e "  ${GREEN}✓${RESET} API key configured (for programmatic use)"
        fi
        if [ "$OAUTH_SET" = "true" ]; then
            echo -e "  ${GREEN}✓${RESET} OAuth login configured (for interactive use)"
        fi

        if [ "$API_KEY_SET" = "false" ] && [ "$OAUTH_SET" = "false" ]; then
            echo -e "  ${YELLOW}!${RESET} Not authenticated"
            echo ""
            echo -e "  ${DIM}Claude Code supports two authentication methods:${RESET}"
            echo -e "  ${DIM}  1. OAuth login (recommended) - Login with Claude.ai/Console account${RESET}"
            echo -e "  ${DIM}  2. API key - For programmatic/CI use${RESET}"
            echo ""
            echo "  Choose authentication method:"
            echo "    1) OAuth login (recommended for interactive use)"
            echo "    2) API key (for CI/programmatic use)"
            echo "    3) Skip"
            read -p "  Enter choice [1-3]: " auth_choice

            case $auth_choice in
                1)
                    echo ""
                    echo -e "  ${CYAN}→${RESET} Starting Claude Code for OAuth login..."
                    echo -e "  ${DIM}This will open a browser for authentication.${RESET}"
                    echo -e "  ${DIM}After login, you can exit with Ctrl+C or /exit${RESET}"
                    echo ""
                    read -p "  Press Enter to continue..."
                    claude || true
                    echo -e "  ${GREEN}✓${RESET} OAuth setup complete"
                    ;;
                2)
                    echo ""
                    echo -e "  ${DIM}Get your API key from: https://console.anthropic.com/settings/keys${RESET}"
                    read -p "  Enter Anthropic API key: " api_key
                    if [ -n "$api_key" ]; then
                        # Add to .env file
                        if [ ! -f ".env" ]; then
                            echo "# Environment variables" > .env
                            echo "" >> .env
                        fi
                        # Remove existing key if present
                        if [ -f ".env" ]; then
                            grep -v "^ANTHROPIC_API_KEY=" .env > .env.tmp 2>/dev/null || true
                            mv .env.tmp .env
                        fi
                        echo "ANTHROPIC_API_KEY=$api_key" >> .env
                        echo -e "  ${GREEN}✓${RESET} API key saved to .env"
                        echo -e "  ${DIM}Run: source .env (or restart your shell)${RESET}"
                    fi
                    ;;
                *)
                    echo -e "  ${DIM}Skipped${RESET}"
                    ;;
            esac
        elif [ "$API_KEY_SET" = "false" ]; then
            # OAuth is set but API key is not - offer to add API key for CI
            read -p "  Add API key for CI/programmatic use? [y/N]: " -n 1 -r add_api_key
            echo ""
            if [[ $add_api_key =~ ^[Yy]$ ]]; then
                echo -e "  ${DIM}Get your API key from: https://console.anthropic.com/settings/keys${RESET}"
                read -p "  Enter Anthropic API key: " api_key
                if [ -n "$api_key" ]; then
                    if [ ! -f ".env" ]; then
                        echo "# Environment variables" > .env
                        echo "" >> .env
                    fi
                    echo "ANTHROPIC_API_KEY=$api_key" >> .env
                    echo -e "  ${GREEN}✓${RESET} API key saved to .env"
                fi
            fi
        fi
        echo ""
    fi
fi

# Google Cloud SDK
if [ "$GCLOUD_ENABLED" = "true" ]; then
    echo -e "${BOLD}Google Cloud SDK${RESET}"

    # Check if CLI is available
    GCLOUD_CLI_AVAILABLE=false
    if command -v gcloud &> /dev/null; then
        GCLOUD_CLI_AVAILABLE=true
    else
        echo -e "  ${DIM}CLI not installed yet (will be installed on container rebuild)${RESET}"
    fi

    # Check if project ID already in .env
    GCLOUD_CONFIGURED=false
    if [ -f ".env" ] && grep -q "GOOGLE_CLOUD_PROJECT" .env 2>/dev/null; then
        GCLOUD_CONFIGURED=true
        GCP_PROJECT=$(grep "GOOGLE_CLOUD_PROJECT" .env | cut -d= -f2)
        echo -e "  ${GREEN}✓${RESET} Project ID configured: $GCP_PROJECT"

        read -p "  Reconfigure GCP project? [y/N]: " -n 1 -r reconfig
        echo ""
        if [[ $reconfig =~ ^[Yy]$ ]]; then
            GCLOUD_CONFIGURED=false
        fi
    fi

    if [ "$GCLOUD_CLI_AVAILABLE" = "true" ]; then
        # CLI is available - check auth status
        if gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q "@"; then
            ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
            echo -e "  ${GREEN}✓${RESET} Authenticated as: $ACCOUNT"

            # Sync project from gcloud config if not in .env
            if [ "$GCLOUD_CONFIGURED" = "false" ]; then
                PROJECT=$(gcloud config get-value project 2>/dev/null)
                if [ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ]; then
                    echo -e "  ${GREEN}✓${RESET} Current gcloud project: $PROJECT"
                    read -p "  Use this project? [Y/n]: " -n 1 -r use_current
                    echo ""
                    if [[ ! $use_current =~ ^[Nn]$ ]]; then
                        gcp_project="$PROJECT"
                    else
                        read -p "  Enter GCP project ID: " gcp_project
                    fi
                else
                    read -p "  Enter GCP project ID (or press Enter to skip): " gcp_project
                fi

                if [ -n "$gcp_project" ]; then
                    gcloud config set project "$gcp_project"
                    # Save to .env
                    if [ ! -f ".env" ]; then
                        echo "# Environment variables" > .env
                        echo "" >> .env
                    fi
                    grep -v "^GOOGLE_CLOUD_PROJECT=" .env > .env.tmp 2>/dev/null || true
                    mv .env.tmp .env
                    echo "GOOGLE_CLOUD_PROJECT=$gcp_project" >> .env
                    echo -e "  ${GREEN}✓${RESET} Project set to: $gcp_project"
                fi
            fi
        else
            echo -e "  ${YELLOW}!${RESET} Not authenticated"
            read -p "  Login to Google Cloud? [Y/n]: " -n 1 -r gcloud_login
            echo ""
            if [[ ! $gcloud_login =~ ^[Nn]$ ]]; then
                gcloud auth login
                read -p "  Enter GCP project ID (or press Enter to skip): " gcp_project
                if [ -n "$gcp_project" ]; then
                    gcloud config set project "$gcp_project"
                    # Save to .env
                    if [ ! -f ".env" ]; then
                        echo "# Environment variables" > .env
                        echo "" >> .env
                    fi
                    grep -v "^GOOGLE_CLOUD_PROJECT=" .env > .env.tmp 2>/dev/null || true
                    mv .env.tmp .env
                    echo "GOOGLE_CLOUD_PROJECT=$gcp_project" >> .env
                    echo -e "  ${GREEN}✓${RESET} Project saved to .env"
                fi
            fi
        fi
    else
        # CLI not available - just prompt for project ID to save in .env
        if [ "$GCLOUD_CONFIGURED" = "false" ]; then
            echo ""
            echo -e "  ${DIM}Enter your GCP project ID to save for later use.${RESET}"
            read -p "  Enter GCP project ID (or press Enter to skip): " gcp_project

            if [ -n "$gcp_project" ]; then
                # Save to .env
                if [ ! -f ".env" ]; then
                    echo "# Environment variables" > .env
                    echo "" >> .env
                fi
                grep -v "^GOOGLE_CLOUD_PROJECT=" .env > .env.tmp 2>/dev/null || true
                mv .env.tmp .env
                echo "GOOGLE_CLOUD_PROJECT=$gcp_project" >> .env
                echo -e "  ${GREEN}✓${RESET} Project ID saved to .env"
                echo -e "  ${DIM}Run 'gcloud auth login' after CLI is installed${RESET}"
            else
                echo -e "  ${DIM}Skipped${RESET}"
            fi
        fi
    fi
    echo ""
fi

# Pulumi
if [ "$PULUMI_ENABLED" = "true" ]; then
    echo -e "${BOLD}Pulumi${RESET}"

    # Check if pulumi is in PATH or in ~/.pulumi/bin
    PULUMI_CMD=""
    if command -v pulumi &> /dev/null; then
        PULUMI_CMD="pulumi"
    elif [ -f "$HOME/.pulumi/bin/pulumi" ]; then
        PULUMI_CMD="$HOME/.pulumi/bin/pulumi"
    fi

    if [ -n "$PULUMI_CMD" ]; then
        if $PULUMI_CMD whoami &> /dev/null; then
            PULUMI_USER=$($PULUMI_CMD whoami 2>/dev/null)
            echo -e "  ${GREEN}✓${RESET} Logged in as: $PULUMI_USER"
        else
            echo -e "  ${YELLOW}!${RESET} Not logged in"
            read -p "  Login to Pulumi? [Y/n]: " -n 1 -r pulumi_login
            echo ""
            if [[ ! $pulumi_login =~ ^[Nn]$ ]]; then
                $PULUMI_CMD login
            fi
        fi
    else
        echo -e "  ${DIM}CLI not installed yet (will be installed on container rebuild)${RESET}"
        echo -e "  ${DIM}Run 'pulumi login' after CLI is installed${RESET}"
    fi
    echo ""
fi

# Infisical
if [ "$INFISICAL_ENABLED" = "true" ]; then
    echo -e "${BOLD}Infisical (Secrets Management)${RESET}"

    # Check if CLI is available
    INFISICAL_CLI_AVAILABLE=false
    if command -v infisical &> /dev/null; then
        INFISICAL_CLI_AVAILABLE=true
    else
        echo -e "  ${DIM}CLI not installed yet (will be installed on container rebuild)${RESET}"
    fi

    # Check if already configured in .env
    INFISICAL_CONFIGURED=false
    if [ -f ".env" ] && grep -q "INFISICAL_TOKEN" .env 2>/dev/null; then
        INFISICAL_CONFIGURED=true
        echo -e "  ${GREEN}✓${RESET} Infisical token configured in .env"

        # Show current config
        if grep -q "INFISICAL_PROJECT_ID" .env 2>/dev/null; then
            PROJECT_ID=$(grep "INFISICAL_PROJECT_ID" .env | cut -d= -f2)
            echo -e "  ${GREEN}✓${RESET} Project ID: $PROJECT_ID"
        fi
        if grep -q "INFISICAL_ENV" .env 2>/dev/null; then
            ENV_NAME=$(grep "INFISICAL_ENV" .env | cut -d= -f2)
            echo -e "  ${GREEN}✓${RESET} Environment: $ENV_NAME"
        fi

        read -p "  Reconfigure Infisical? [y/N]: " -n 1 -r reconfig
        echo ""
        if [[ ! $reconfig =~ ^[Yy]$ ]]; then
            INFISICAL_CONFIGURED=true
        else
            INFISICAL_CONFIGURED=false
        fi
    fi

    if [ "$INFISICAL_CONFIGURED" = "false" ]; then
        echo ""
        echo -e "  ${DIM}Configure Infisical to pull secrets from a specific project/path.${RESET}"
        echo -e "  ${DIM}Get your service token from: https://app.infisical.com${RESET}"
        echo ""

        # Service Token
        read -p "  Enter Infisical Service Token (or press Enter to skip): " infisical_token

        if [ -n "$infisical_token" ]; then
            # Project ID
            read -p "  Enter Project ID: " project_id

            # Environment
            echo "  Environment options: dev, staging, prod (or custom)"
            read -p "  Enter environment [dev]: " env_name
            env_name="${env_name:-dev}"

            # Save to .env
            if [ ! -f ".env" ]; then
                echo "# Environment variables" > .env
                echo "" >> .env
            fi

            # Remove existing Infisical config if present
            if [ -f ".env" ]; then
                grep -v "^INFISICAL_" .env > .env.tmp 2>/dev/null || true
                mv .env.tmp .env
            fi

            # Add Infisical config
            cat >> .env << INFISICAL_EOF

# Infisical Configuration
INFISICAL_TOKEN=$infisical_token
INFISICAL_PROJECT_ID=$project_id
INFISICAL_ENV=$env_name
INFISICAL_EOF

            echo -e "  ${GREEN}✓${RESET} Infisical configuration saved to .env"

            # Offer to pull secrets now (only if CLI is available)
            if [ "$INFISICAL_CLI_AVAILABLE" = "true" ]; then
                read -p "  Pull secrets now? [Y/n]: " -n 1 -r pull_now
                echo ""
                if [[ ! $pull_now =~ ^[Nn]$ ]]; then
                    echo -e "  ${CYAN}→${RESET} Pulling secrets (env: $env_name)..."

                    # Export secrets using the token
                    if INFISICAL_TOKEN="$infisical_token" infisical export \
                        --projectId="$project_id" \
                        --env="$env_name" \
                        --format=dotenv > .env.secrets 2>/dev/null; then

                        # Merge secrets (avoiding duplicates and Infisical config)
                        while IFS= read -r line; do
                            # Skip empty lines and comments
                            [[ -z "$line" || "$line" == \#* ]] && continue
                            key=$(echo "$line" | cut -d= -f1)
                            # Don't overwrite Infisical config vars
                            if [[ "$key" != INFISICAL_* ]] && ! grep -q "^$key=" .env 2>/dev/null; then
                                echo "$line" >> .env
                            fi
                        done < .env.secrets
                        rm .env.secrets

                        echo -e "  ${GREEN}✓${RESET} Secrets pulled and merged into .env"
                    else
                        echo -e "  ${YELLOW}!${RESET} Failed to pull secrets (check token/permissions)"
                        rm -f .env.secrets
                    fi
                fi
            else
                echo -e "  ${DIM}Run 'make secrets-pull' after CLI is installed to pull secrets${RESET}"
            fi

            echo ""
            echo -e "  ${DIM}To pull secrets later: make secrets-pull${RESET}"
        else
            echo -e "  ${DIM}Skipped${RESET}"
        fi
    fi
    echo ""
fi

# ============================================================================
# Create .env template if it doesn't exist
# ============================================================================

if [ ! -f ".env" ] && [ ! -f ".env.example" ]; then
    echo -e "${BOLD}Environment Variables${RESET}"
    echo ""

    # Check what tools are enabled and create appropriate .env.example
    cat > .env.example << 'ENVEOF'
# Environment Variables
# Copy this file to .env and fill in your values
# cp .env.example .env

ENVEOF

    if [ "$CLAUDE_CODE_ENABLED" = "true" ]; then
        echo "# Claude Code" >> .env.example
        echo "ANTHROPIC_API_KEY=your-api-key-here" >> .env.example
        echo "" >> .env.example
    fi

    if [ "$GCLOUD_ENABLED" = "true" ]; then
        echo "# Google Cloud" >> .env.example
        echo "GOOGLE_CLOUD_PROJECT=your-project-id" >> .env.example
        echo "# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json" >> .env.example
        echo "" >> .env.example
    fi

    if [ "$INFISICAL_ENABLED" = "true" ]; then
        echo "# Infisical - Get service token from https://app.infisical.com" >> .env.example
        echo "INFISICAL_TOKEN=your-service-token" >> .env.example
        echo "INFISICAL_PROJECT_ID=your-project-id" >> .env.example
        echo "INFISICAL_ENV=dev" >> .env.example
        echo "" >> .env.example
    fi

    if [ "$PULUMI_ENABLED" = "true" ]; then
        echo "# Pulumi" >> .env.example
        echo "# PULUMI_ACCESS_TOKEN=your-token-here" >> .env.example
        echo "" >> .env.example
    fi

    echo -e "  ${GREEN}✓${RESET} Created .env.example template"
    echo -e "  ${DIM}Copy to .env and fill in your values: cp .env.example .env${RESET}"
    echo ""
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}  SETUP COMPLETE${RESET}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo "  • Run ${CYAN}make doctor${RESET} to verify your setup"
echo "  • Run ${CYAN}make help${RESET} to see available commands"
echo "  • Run ${CYAN}make check${RESET} to verify quality and tests"
echo ""
if [ -f ".env.example" ] && [ ! -f ".env" ]; then
    echo -e "${YELLOW}Don't forget:${RESET} Copy .env.example to .env and add your secrets"
    echo ""
fi
