#!/usr/bin/env bash
#
# Install the AI coding-agent CLIs that pair with dxkit's commit-time
# guardrails. Pinned versions so devcontainer rebuilds produce a
# deterministic environment; bump these intentionally.
#
# Both CLIs are published to npm and install globally into the
# devcontainer image's Node toolchain (provided by the features
# block in devcontainer.json).

set -euo pipefail

# Pinned at devcontainer template publish time. Loosen to `@latest`
# if you want each container start to pull the newest CLI — at the
# cost of non-deterministic builds. Set to `skip` to skip the install
# entirely (useful if you only use one of the two agents).
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-latest}"
CODEX_VERSION="${CODEX_VERSION:-latest}"

if [ "${CLAUDE_CODE_VERSION}" = "skip" ]; then
  echo "==> Claude Code CLI install skipped (CLAUDE_CODE_VERSION=skip)."
else
  echo "==> Installing Claude Code CLI..."
  if command -v claude >/dev/null 2>&1; then
    echo "    Already installed: $(claude --version 2>&1 | head -n1)"
  else
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      || echo "WARN: Claude Code install failed — try manually with 'npm install -g @anthropic-ai/claude-code'." >&2
  fi
fi

if [ "${CODEX_VERSION}" = "skip" ]; then
  echo "==> OpenAI Codex CLI install skipped (CODEX_VERSION=skip)."
else
  echo "==> Installing OpenAI Codex CLI..."
  if command -v codex >/dev/null 2>&1; then
    echo "    Already installed: $(codex --version 2>&1 | head -n1)"
  else
    npm install -g "@openai/codex@${CODEX_VERSION}" \
      || echo "WARN: Codex CLI install failed — try manually with 'npm install -g @openai/codex'." >&2
  fi
fi
