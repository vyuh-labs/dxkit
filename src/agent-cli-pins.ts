/**
 * The coding-agent CLIs the generated devcontainer installs, at the exact
 * versions this dxkit release pins. The ONE source of truth: the devcontainer
 * installer renders `install-agent-clis.sh` from this list, so the version a
 * container gets is decided here, at dxkit release time, and moves only when
 * a dxkit release bumps it and `update` re-renders the script.
 *
 * The class this closes (4.5.0): the script defaulted both CLIs to `latest`
 * while its own comment said they were pinned at template publish time, so
 * two containers built from the same files on different days ran different
 * agents. `test/agent-cli-pins.test.ts` fails on `latest`, a range, a tag or
 * any version that is not an exact `x.y.z`.
 *
 * Bumping a pin: check the published version (`npm view <package> version`),
 * change `version` here, and nothing else.
 */

export interface AgentCliPin {
  /** Human label the install script prints. */
  readonly label: string;
  /** npm package the CLI is published as. */
  readonly package: string;
  /** Exact `x.y.z` version this dxkit release installs. */
  readonly version: string;
  /** Environment variable that overrides the pin per container: an exact
   *  version to install instead, or `skip` to not install the CLI. */
  readonly versionEnv: string;
  /** Binary the package puts on PATH (verified after install). */
  readonly bin: string;
}

export const AGENT_CLI_PINS: readonly AgentCliPin[] = [
  {
    label: 'Claude Code CLI',
    package: '@anthropic-ai/claude-code',
    version: '2.1.327',
    versionEnv: 'CLAUDE_CODE_VERSION',
    bin: 'claude',
  },
  {
    label: 'OpenAI Codex CLI',
    package: '@openai/codex',
    version: '0.169.1',
    versionEnv: 'CODEX_VERSION',
    bin: 'codex',
  },
];

/** An exact release version: digits only, no range, tag or pre-release. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Whole-line placeholder in `install-agent-clis.sh` replaced by one
 *  `install_agent_cli` call per pin. */
export const AGENT_CLI_INSTALLS_PLACEHOLDER = '__DXKIT_AGENT_CLI_INSTALLS__';

/** The `install_agent_cli` calls for the given pins (one per line). The pin
 *  is the default of the per-container override variable. */
export function renderAgentCliInstallCalls(pins: readonly AgentCliPin[] = AGENT_CLI_PINS): string {
  return pins
    .map(
      (p) =>
        `install_agent_cli "${p.label}" ${p.versionEnv} "\${${p.versionEnv}:-${p.version}}" "${p.package}" ${p.bin}`,
    )
    .join('\n');
}
