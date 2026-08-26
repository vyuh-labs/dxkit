import { describe, it, expect } from 'vitest';
import { noPromptGitEnv, noPromptSshCommand } from '../src/git-no-prompt';

/**
 * The ONE no-prompt hardening for machine git spawns. Two holes it closes:
 * a user-set GIT_SSH_COMMAND used to lose the batch guard (the hang came
 * back), and the `ssh -o BatchMode=yes` default used to REPLACE a
 * core.sshCommand / GIT_SSH the user relies on (a custom key, a jump host),
 * so the spawn authenticated differently from the user's own git. The
 * helper keeps git's precedence and appends batch mode to whichever wins.
 */
describe('noPromptSshCommand', () => {
  it('defaults to plain ssh in batch mode', () => {
    expect(noPromptSshCommand({})).toBe('ssh -o BatchMode=yes');
  });

  it('APPENDS batch mode to a user-set GIT_SSH_COMMAND instead of dropping it', () => {
    expect(noPromptSshCommand({ gitSshCommand: 'ssh -i ~/.ssh/deploy_key' })).toBe(
      'ssh -i ~/.ssh/deploy_key -o BatchMode=yes',
    );
  });

  it('keeps a core.sshCommand the user configured (never replaced by the default)', () => {
    expect(noPromptSshCommand({ coreSshCommand: 'ssh -J bastion' })).toBe(
      'ssh -J bastion -o BatchMode=yes',
    );
  });

  it('honors git precedence: GIT_SSH_COMMAND over core.sshCommand over GIT_SSH', () => {
    expect(
      noPromptSshCommand({
        gitSshCommand: 'ssh -i a',
        coreSshCommand: 'ssh -i b',
        gitSsh: '/usr/bin/plink',
      }),
    ).toBe('ssh -i a -o BatchMode=yes');
    expect(noPromptSshCommand({ coreSshCommand: 'ssh -i b', gitSsh: '/usr/bin/plink' })).toBe(
      'ssh -i b -o BatchMode=yes',
    );
    expect(noPromptSshCommand({ gitSsh: '/usr/bin/plink' })).toBe(
      '/usr/bin/plink -o BatchMode=yes',
    );
  });

  it('quotes a GIT_SSH program path with whitespace when lifting it into command form', () => {
    expect(noPromptSshCommand({ gitSsh: '/opt/my tools/ssh' })).toBe(
      '"/opt/my tools/ssh" -o BatchMode=yes',
    );
  });

  it('does not double the option when the user already set batch mode', () => {
    expect(noPromptSshCommand({ gitSshCommand: 'ssh -o BatchMode=yes -i k' })).toBe(
      'ssh -o BatchMode=yes -i k',
    );
  });

  it('treats blank values as unset', () => {
    expect(noPromptSshCommand({ gitSshCommand: '   ', coreSshCommand: '', gitSsh: ' ' })).toBe(
      'ssh -o BatchMode=yes',
    );
  });
});

describe('noPromptGitEnv', () => {
  it('disables both prompt paths from injected inputs', () => {
    expect(noPromptGitEnv({ env: {}, coreSshCommand: null })).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
    expect(
      noPromptGitEnv({ env: { GIT_SSH_COMMAND: 'ssh -i k' }, coreSshCommand: 'ssh -J b' })
        .GIT_SSH_COMMAND,
    ).toBe('ssh -i k -o BatchMode=yes');
    expect(noPromptGitEnv({ env: {}, coreSshCommand: 'ssh -J b' }).GIT_SSH_COMMAND).toBe(
      'ssh -J b -o BatchMode=yes',
    );
  });
});
