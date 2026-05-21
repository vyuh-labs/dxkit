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
#
# The fallback chain layers three install strategies before giving up:
#
#   1. `npm ci` (lockfile path only) — strict, fast, uses the lockfile
#      verbatim. Happy path on a healthy tree.
#   2. `npm install` — looser; rebuilds lockfile entries if the
#      lockfile drifted (lockfile vs package.json mismatch after a
#      merge, for example).
#   3. `npm install --legacy-peer-deps` — last resort. npm v7+ defaults
#      to strict peer-dep resolution; brownfield monorepos almost
#      always carry unresolved peers (eslint 8↔10, react cross-pkg
#      peer mismatches, etc.) which fail both prior steps with
#      multi-line ERESOLVE dumps. Legacy mode skips the peer-dep
#      check and gets a working node_modules/.
if [ -f package.json ]; then
  echo "==> Installing project dependencies..."
  if [ -f package-lock.json ]; then
    npm ci || npm install || npm install --legacy-peer-deps || {
      echo "WARN: project dependency install failed even with --legacy-peer-deps — re-run 'npm install --legacy-peer-deps' manually after fixing the cause." >&2
    }
  else
    npm install || npm install --legacy-peer-deps || {
      echo "WARN: project dependency install failed even with --legacy-peer-deps — re-run 'npm install --legacy-peer-deps' manually after fixing the cause." >&2
    }
  fi
fi

# Resolve dxkit for THIS script. Prefer the project-local install if a
# package.json pinned dxkit in devDependencies (so the script uses the
# project's pinned version); otherwise install globally and use that.
if [ -x ./node_modules/.bin/vyuh-dxkit ]; then
  DXKIT="./node_modules/.bin/vyuh-dxkit"
elif command -v vyuh-dxkit >/dev/null 2>&1; then
  DXKIT="vyuh-dxkit"
else
  echo "==> Installing @vyuhlabs/dxkit globally (for script use)..."
  npm install -g @vyuhlabs/dxkit
  DXKIT="vyuh-dxkit"
fi

# Make sure `vyuh-dxkit` is on the CUSTOMER's interactive shell PATH
# regardless of where the script-local resolution above ended up.
# Project-local installs (./node_modules/.bin/) are NOT on PATH for
# terminal sessions or for the dxkit-* agent skills' bash invocations
# — only the global install puts the bare command on PATH. Without
# this, the customer types `vyuh-dxkit doctor` and gets "command not
# found" until they discover `npx vyuh-dxkit`. Soft-fail: if global
# install fails (offline / registry hiccup), `npx vyuh-dxkit` still
# works as a fallback.
if ! command -v vyuh-dxkit >/dev/null 2>&1; then
  echo "==> Installing @vyuhlabs/dxkit globally (for shell PATH)..."
  npm install -g @vyuhlabs/dxkit || \
    echo "WARN: global install failed — customer terminal will need 'npx vyuh-dxkit'." >&2
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
