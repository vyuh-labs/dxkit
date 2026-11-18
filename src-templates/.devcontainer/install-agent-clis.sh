#!/usr/bin/env bash
#
# Install the AI coding-agent CLIs that pair with dxkit's commit-time
# guardrails, at the exact versions the dxkit release that generated
# this file pins. Generated and refreshed by dxkit (`vyuh-dxkit update`
# re-renders it with that release's pins); bump a pin by upgrading dxkit,
# not by editing this file.
#
# Both CLIs are published to npm and install globally into the
# devcontainer image's Node toolchain (provided by the features
# block in devcontainer.json).
#
# Per-container overrides, set in the container's environment (for
# example `containerEnv` in devcontainer.json, or a Codespaces secret):
#   CLAUDE_CODE_VERSION / CODEX_VERSION = <x.y.z>  install that version
#   CLAUDE_CODE_VERSION / CODEX_VERSION = skip     do not install the CLI
#
# Exit status is non-zero when a requested CLI did not end up on PATH at
# the requested version, so post-create reports the environment as not
# ready instead of printing a warning nobody reads.

set -uo pipefail

FAILED=0

# The first x.y.z in a CLI's `--version` output (`2.1.0 (Claude Code)`,
# `codex-cli 0.1.0`), or empty when the binary is absent, does not run, or
# exits non-zero.
installed_version() {
  local out
  command -v "$1" >/dev/null 2>&1 || return 0
  out="$("$1" --version 2>/dev/null)" || return 0
  printf '%s\n' "${out}" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1
}

# install_agent_cli <label> <override-var> <requested> <npm-package> <bin>
install_agent_cli() {
  local label="$1" env_name="$2" requested="$3" pkg="$4" bin="$5" have
  if [ "${requested}" = "skip" ]; then
    echo "==> ${label}: install skipped (${env_name}=skip)."
    return 0
  fi
  echo "==> ${label}: ${pkg}@${requested}"
  have="$(installed_version "${bin}")"
  if [ -n "${have}" ] && [ "${have}" = "${requested}" ]; then
    echo "    already installed at ${have}"
    return 0
  fi
  if [ -n "${have}" ]; then
    echo "    found ${have}; installing the requested ${requested}"
  fi
  if ! npm install -g "${pkg}@${requested}"; then
    echo "FAIL: ${label}: 'npm install -g ${pkg}@${requested}' failed." >&2
    FAILED=1
    return 0
  fi
  hash -r
  have="$(installed_version "${bin}")"
  if [ -z "${have}" ]; then
    echo "FAIL: ${label}: installed, but '${bin} --version' does not run from PATH." >&2
    FAILED=1
  elif [[ "${requested}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "${have}" != "${requested}" ]; then
    echo "FAIL: ${label}: '${bin}' on PATH reports ${have}, not the requested ${requested}." >&2
    FAILED=1
  else
    echo "    installed ${have}"
  fi
}

__DXKIT_AGENT_CLI_INSTALLS__

exit "${FAILED}"
