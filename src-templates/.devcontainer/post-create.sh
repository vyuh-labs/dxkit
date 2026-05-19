#!/usr/bin/env bash
#
# Devcontainer post-create. Runs once after the container is built
# (and again on Codespaces prebuild). Idempotent — safe to re-run.
#
# Responsibilities:
#   1. Install project dependencies if this is a Node project.
#   2. Ensure dxkit is on PATH (project-local first, global fallback).
#   3. Install dxkit's scanner toolchain (gitleaks, semgrep, cloc, etc.)
#      via the TOOL_DEFS registry — pinned versions, language-aware.
#   4. Install the AI coding-agent CLIs for the AI-native dev loop.
#
# Run from the repo root — the devcontainer's workspaceFolder is set
# by `devcontainer.json` so the post-create command starts there.

set -euo pipefail

echo "==> dxkit post-create starting in $(pwd)"

# Install project dependencies if this is a Node project. Soft-fail
# the whole step: a lockfile that won't resolve (tarball moved,
# private-registry auth not configured yet, peer-dep churn) is
# annoying but shouldn't take down the rest of the post-create. The
# user can re-run `npm install` after authenticating or fixing the
# lockfile.
if [ -f package.json ]; then
  echo "==> Installing project dependencies..."
  if [ -f package-lock.json ]; then
    npm ci || npm install || {
      echo "WARN: project dependency install failed — re-run 'npm install' manually if needed." >&2
    }
  else
    npm install || {
      echo "WARN: project dependency install failed — re-run 'npm install' manually if needed." >&2
    }
  fi
fi

# Resolve dxkit. Prefer the project-local install if a `package.json`
# pinned dxkit in devDependencies; otherwise install globally so the
# binary is on PATH for the rest of the script and any subshell.
if [ -x ./node_modules/.bin/vyuh-dxkit ]; then
  DXKIT="./node_modules/.bin/vyuh-dxkit"
elif command -v vyuh-dxkit >/dev/null 2>&1; then
  DXKIT="vyuh-dxkit"
else
  echo "==> Installing @vyuhlabs/dxkit globally..."
  npm install -g @vyuhlabs/dxkit
  DXKIT="vyuh-dxkit"
fi
echo "==> Using dxkit binary: ${DXKIT}"

echo "==> Installing scanner toolchain via dxkit registry..."
# `tools install --yes` reads the detector's required-tools list and
# runs the pinned install command for each one. Tools already present
# are no-ops, so this is fast on warm containers. Soft-fail so a
# single tool's install hiccup doesn't break the whole container.
"${DXKIT}" tools install --yes || {
  echo "WARN: some scanner tools failed to install — run 'vyuh-dxkit tools list' to see status." >&2
}

echo "==> Installing AI coding-agent CLIs..."
bash "$(dirname "$0")/install-agent-clis.sh" || {
  echo "WARN: agent CLI install had issues — install manually if needed." >&2
}

echo "==> dxkit post-create done. Run 'vyuh-dxkit health' to verify."
