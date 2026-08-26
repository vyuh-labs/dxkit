/**
 * The ONE no-prompt hardening for machine git spawns (Rule 2). A lane, a
 * refresh, an anchor publish or a remote fetch must fail FAST on a bad
 * remote instead of hanging on an interactive prompt, so both prompt paths
 * are disabled: HTTPS credentials (`GIT_TERMINAL_PROMPT=0`) and SSH
 * passphrase / host-key prompts (`BatchMode=yes`).
 *
 * The SSH half used to be `GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes'`,
 * copied at every spawn site. That had two holes: a user-set
 * `GIT_SSH_COMMAND` lost the batch guard (the hang came back), and when it
 * was unset the default REPLACED whatever git would otherwise have used,
 * a `core.sshCommand` config or a `GIT_SSH` program (a custom key, a jump
 * host, a wrapper), so the spawn authenticated differently from the user's
 * own git. This helper keeps git's own precedence (`GIT_SSH_COMMAND`, then
 * `core.sshCommand`, then `GIT_SSH`, then plain `ssh`) and APPENDS the
 * batch option to whichever wins.
 */
import { execFileSync } from 'child_process';

export interface NoPromptGitEnv {
  readonly GIT_TERMINAL_PROMPT: '0';
  readonly GIT_SSH_COMMAND: string;
}

const BATCH_OPTION = '-o BatchMode=yes';

/** Read `core.sshCommand` the way git resolves it for `cwd` (repo, then
 *  global config); null when unset or git is unavailable. */
export function readCoreSshCommand(cwd?: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', 'core.sshCommand'], {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The SSH command git will run, with batch mode appended to the user's own
 *  choice (never replacing it). Pure: every input is a parameter. */
export function noPromptSshCommand(inputs: {
  readonly gitSshCommand?: string | undefined;
  readonly coreSshCommand?: string | null;
  readonly gitSsh?: string | undefined;
}): string {
  const fromEnv = inputs.gitSshCommand?.trim() ?? '';
  const fromConfig = inputs.coreSshCommand?.trim() ?? '';
  const program = inputs.gitSsh?.trim() ?? '';
  // GIT_SSH names a PROGRAM (git passes no options through it), while
  // GIT_SSH_COMMAND is shell-interpreted, so a program path is quoted when
  // it is lifted into the command form.
  let base = 'ssh';
  if (fromEnv.length > 0) base = fromEnv;
  else if (fromConfig.length > 0) base = fromConfig;
  else if (program.length > 0) base = /\s/.test(program) ? `"${program}"` : program;
  return /BatchMode/i.test(base) ? base : `${base} ${BATCH_OPTION}`;
}

/**
 * The env fragment every machine git spawn layers over `process.env`.
 * `cwd` scopes the `core.sshCommand` lookup to the repo being operated on;
 * `env` and `coreSshCommand` are injectable for tests.
 */
export function noPromptGitEnv(
  opts: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly coreSshCommand?: string | null;
  } = {},
): NoPromptGitEnv {
  const env = opts.env ?? process.env;
  let coreSshCommand: string | null;
  if (opts.coreSshCommand !== undefined) coreSshCommand = opts.coreSshCommand;
  else if (env.GIT_SSH_COMMAND)
    coreSshCommand = null; // git would not consult the config
  else coreSshCommand = readCoreSshCommand(opts.cwd);
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: noPromptSshCommand({
      gitSshCommand: env.GIT_SSH_COMMAND,
      coreSshCommand,
      gitSsh: env.GIT_SSH,
    }),
  };
}
