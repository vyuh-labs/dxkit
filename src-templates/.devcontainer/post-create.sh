#!/usr/bin/env bash
#
# Devcontainer post-create. Runs once after the container is built
# (and again on Codespaces prebuild). Idempotent — safe to re-run.
#
# Responsibilities:
#   1. Install dxkit itself.
#   2. Install dxkit's scanner toolchain (gitleaks, semgrep, cloc, etc.)
#      via the TOOL_DEFS registry — pinned versions, language-aware.
#   3. Install the AI coding-agent CLIs (Claude Code, Codex) for the
#      AI-native dev loop.

set -euo pipefail

echo "==> dxkit post-create starting..."

# Install dxkit. Local-first: if the project pins dxkit in
# devDependencies (recommended), `npm ci` already brought it in.
# Otherwise install the latest published release globally so the
# binary is on PATH for any subshell.
if [ -f /workspaces/*/package.json ] 2>/dev/null; then
  WORKSPACE=$(find /workspaces -mindepth 1 -maxdepth 1 -type d | head -n1)
  cd "${WORKSPACE}"
  if [ -f package-lock.json ]; then
    npm ci
  elif [ -f package.json ]; then
    npm install
  fi
fi

if ! command -v vyuh-dxkit >/dev/null 2>&1 \
  && [ ! -x ./node_modules/.bin/vyuh-dxkit ]; then
  echo "==> Installing @vyuhlabs/dxkit globally..."
  npm install -g @vyuhlabs/dxkit
fi

# Resolve the binary for subsequent calls.
if [ -x ./node_modules/.bin/vyuh-dxkit ]; then
  DXKIT="./node_modules/.bin/vyuh-dxkit"
else
  DXKIT="vyuh-dxkit"
fi

echo "==> Installing scanner toolchain via dxkit registry..."
# `tools install --yes` reads the detector's required-tools list and
# runs the pinned install command for each one. Tools already present
# are no-ops, so this is fast on warm containers.
"${DXKIT}" tools install --yes || {
  echo "WARN: some scanner tools failed to install — run 'vyuh-dxkit tools list' to see status." >&2
}

echo "==> Installing AI coding-agent CLIs..."
bash "$(dirname "$0")/install-agent-clis.sh"

echo "==> dxkit post-create done. Run 'vyuh-dxkit health' to verify."
