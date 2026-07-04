import { describe, it, expect } from 'vitest';
import {
  stripGitignoreBlock,
  stripAllGitignoreBlocks,
  stripClaudeLoopBlock,
  stripSettingsDxkit,
  stripPackageJsonDxkit,
  STEALTH_HEADER,
} from '../src/uninstall/reversals';
import { GITIGNORE_HEADER } from '../src/ship-installers';
import { CLAUDE_BLOCK_START, CLAUDE_BLOCK_END } from '../src/loop/scaffold';

describe('stripGitignoreBlock — preserves user entries', () => {
  it('removes only the dxkit block, keeping user lines above and below', () => {
    const content = [
      'node_modules/',
      'dist/',
      '',
      GITIGNORE_HEADER,
      '.dxkit/reports/',
      '.dxkit/cache/',
      'graphify-out/',
      '',
      '*.log',
    ].join('\n');
    const { changed, content: out } = stripGitignoreBlock(content, GITIGNORE_HEADER);
    expect(changed).toBe(true);
    expect(out).toContain('node_modules/');
    expect(out).toContain('dist/');
    expect(out).toContain('*.log');
    expect(out).not.toContain(GITIGNORE_HEADER);
    expect(out).not.toContain('.dxkit/reports/');
    expect(out).not.toContain('graphify-out/');
  });

  it('no-op when the block is absent', () => {
    const content = 'node_modules/\ndist/\n';
    expect(stripGitignoreBlock(content, GITIGNORE_HEADER)).toEqual({ changed: false, content });
  });

  it('empties the file when it held only the dxkit block', () => {
    const content = [GITIGNORE_HEADER, '.dxkit/reports/', 'graphify-out/', ''].join('\n');
    const { changed, content: out } = stripGitignoreBlock(content, GITIGNORE_HEADER);
    expect(changed).toBe(true);
    expect(out).toBe('');
  });

  it('stripAllGitignoreBlocks removes both runtime + stealth blocks', () => {
    const content = [
      'node_modules/',
      '',
      GITIGNORE_HEADER,
      '.dxkit/reports/',
      '',
      STEALTH_HEADER,
      '.dxkit/',
      '.vyuh-dxkit.json',
    ].join('\n');
    const { changed, content: out } = stripAllGitignoreBlocks(content);
    expect(changed).toBe(true);
    expect(out).toBe('node_modules/\n');
  });
});

describe('stripClaudeLoopBlock — preserves user prose', () => {
  it('removes the sentinel block, keeping surrounding content', () => {
    const content = [
      '# My project',
      '',
      'Some house rules.',
      '',
      CLAUDE_BLOCK_START,
      'dxkit loop guidance here',
      CLAUDE_BLOCK_END,
      '',
      'More of my own notes.',
    ].join('\n');
    const { changed, content: out } = stripClaudeLoopBlock(content);
    expect(changed).toBe(true);
    expect(out).toContain('# My project');
    expect(out).toContain('Some house rules.');
    expect(out).toContain('More of my own notes.');
    expect(out).not.toContain(CLAUDE_BLOCK_START);
    expect(out).not.toContain('dxkit loop guidance here');
  });

  it('no-op when the block is absent', () => {
    const content = '# My project\n\nRules.\n';
    expect(stripClaudeLoopBlock(content).changed).toBe(false);
  });

  it('empties a CLAUDE.md that held only the loop block', () => {
    const content = [CLAUDE_BLOCK_START, 'x', CLAUDE_BLOCK_END].join('\n');
    expect(stripClaudeLoopBlock(content).content).toBe('');
  });
});

describe('stripSettingsDxkit — surgical hook removal', () => {
  it('removes the Stop stop-gate hook, keeping other Stop hooks', () => {
    const parsed = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'npx vyuh-dxkit hook stop-gate' }] },
          { hooks: [{ type: 'command', command: 'my-own-hook' }] },
        ],
      },
    };
    const { changed, result } = stripSettingsDxkit(parsed);
    expect(changed).toBe(true);
    const stop = (result.hooks as { Stop: unknown[] }).Stop;
    expect(stop).toHaveLength(1);
    expect(JSON.stringify(stop)).toContain('my-own-hook');
    expect(JSON.stringify(stop)).not.toContain('stop-gate');
  });

  it('removes the PreToolUse context-hook and prunes empty hooks', () => {
    const parsed = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read|Edit',
            hooks: [{ type: 'command', command: 'vyuh-dxkit context-hook' }],
          },
        ],
      },
    };
    const { changed, result, isDxkitOnly } = stripSettingsDxkit(parsed);
    expect(changed).toBe(true);
    expect(result.hooks).toBeUndefined();
    expect(isDxkitOnly).toBe(true);
  });

  it('preserves the user permissions when not dxkit-created', () => {
    const parsed = {
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      hooks: { Stop: [{ hooks: [{ command: 'npx vyuh-dxkit hook stop-gate' }] }] },
    };
    const { result, isDxkitOnly } = stripSettingsDxkit(parsed, { dxkitCreated: false });
    expect(result.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: [] });
    expect(isDxkitOnly).toBe(false);
  });

  it('when dxkit-created, drops $schema + permissions → isDxkitOnly', () => {
    const parsed = {
      $schema: 'x',
      permissions: { allow: ['Bash(vyuh-dxkit:*)'], deny: [] },
      hooks: { PreToolUse: [{ hooks: [{ command: 'vyuh-dxkit context-hook' }] }] },
    };
    const { isDxkitOnly } = stripSettingsDxkit(parsed, { dxkitCreated: true });
    expect(isDxkitOnly).toBe(true);
  });
});

describe('stripPackageJsonDxkit', () => {
  it('removes the devDependency, keeping others', () => {
    const parsed = { devDependencies: { '@vyuhlabs/dxkit': '^2.23.0', react: '^18.0.0' } };
    const { changed, result, removedDevDep } = stripPackageJsonDxkit(parsed);
    expect(changed).toBe(true);
    expect(removedDevDep).toBe(true);
    expect(result.devDependencies).toEqual({ react: '^18.0.0' });
  });

  it('drops the whole postinstall when it was only the dxkit cmd', () => {
    const parsed = { scripts: { postinstall: 'vyuh-dxkit hooks activate', build: 'tsc' } };
    const { result, removedPostinstall } = stripPackageJsonDxkit(parsed);
    expect(removedPostinstall).toBe(true);
    expect((result.scripts as Record<string, string>).postinstall).toBeUndefined();
    expect((result.scripts as Record<string, string>).build).toBe('tsc');
  });

  it('trims a chained postinstall suffix, keeping the user command', () => {
    const parsed = { scripts: { postinstall: 'husky install && vyuh-dxkit hooks activate' } };
    const { result } = stripPackageJsonDxkit(parsed);
    expect((result.scripts as Record<string, string>).postinstall).toBe('husky install');
  });

  it('no-op when dxkit is absent', () => {
    const parsed = { devDependencies: { react: '^18.0.0' } };
    expect(stripPackageJsonDxkit(parsed).changed).toBe(false);
  });
});
