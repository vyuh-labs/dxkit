import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installClaudeLoop, isClaudeLoopInstalled } from '../../src/loop/scaffold';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-loop-scaffold-'));
}
function read(cwd: string, rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), 'utf8');
}
// Fields are declared non-optional so the assertions below can dereference
// them without strict-null noise; readJSON's cast is unchecked, so this only
// shapes access, it does not validate. Tests read real runtime values.
interface TestJson {
  hooks: {
    Stop: Array<{ hooks: Array<{ command: string }> }>;
    PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
  };
  permissions: { allow: string[] };
  loop: { preset: string };
  baseline: { mode: string };
  confidence: { critical: number };
}
function readJSON(cwd: string, rel: string): TestJson {
  return JSON.parse(read(cwd, rel)) as TestJson;
}

describe('loop scaffold (additive merges)', () => {
  let repo: string;
  beforeEach(() => {
    repo = tmpRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('creates settings.json + CLAUDE.md + policy on a bare repo', () => {
    const r = installClaudeLoop(repo);
    expect(isClaudeLoopInstalled(repo)).toBe(true);
    const settings = readJSON(repo, '.claude/settings.json');
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/hook stop-gate/);
    expect(read(repo, 'CLAUDE.md')).toContain('Autonomous loop safety');
    expect(readJSON(repo, '.dxkit/policy.json').loop.preset).toBe('security-only');
    expect(r.installed).toContain(path.join('.claude', 'settings.json'));
  });

  it('preserves existing settings.json hooks + permissions (additive merge)', () => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(git status:*)'], deny: [] },
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'my-hook' }] }],
        },
      }),
    );
    installClaudeLoop(repo);
    const s = readJSON(repo, '.claude/settings.json');
    // Existing content survives…
    expect(s.permissions.allow).toContain('Bash(git status:*)');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('my-hook');
    // …and our Stop hook is added.
    expect(s.hooks.Stop[0].hooks[0].command).toMatch(/hook stop-gate/);
  });

  it('is idempotent — re-running does not duplicate the Stop hook or block', () => {
    installClaudeLoop(repo);
    const r2 = installClaudeLoop(repo);
    const s = readJSON(repo, '.claude/settings.json');
    expect(s.hooks.Stop).toHaveLength(1);
    const claude = read(repo, 'CLAUDE.md');
    expect(claude.match(/dxkit:loop:start/g)).toHaveLength(1);
    // Second run is all skips.
    expect(r2.installed).toHaveLength(0);
  });

  it('appends a managed block to an existing CLAUDE.md without touching user prose', () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# My Rules\n\nKeep it simple.\n');
    installClaudeLoop(repo);
    const c = read(repo, 'CLAUDE.md');
    expect(c).toContain('Keep it simple.');
    expect(c).toContain('<!-- dxkit:loop:start -->');
    expect(c.indexOf('Keep it simple.')).toBeLessThan(c.indexOf('dxkit:loop:start'));
  });

  it('explicit preset overrides; absent preset preserves an existing one', () => {
    // Seed full-debt, then re-run with NO explicit preset → preserved.
    installClaudeLoop(repo, { preset: 'full-debt' });
    expect(readJSON(repo, '.dxkit/policy.json').loop.preset).toBe('full-debt');
    installClaudeLoop(repo);
    expect(readJSON(repo, '.dxkit/policy.json').loop.preset).toBe('full-debt');
    // Explicit override flips it.
    installClaudeLoop(repo, { preset: 'security-only' });
    expect(readJSON(repo, '.dxkit/policy.json').loop.preset).toBe('security-only');
  });

  it('preserves other policy fields when setting loop.preset', () => {
    fs.mkdirSync(path.join(repo, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'committed-full' }, confidence: { critical: 0.9 } }),
    );
    installClaudeLoop(repo);
    const p = readJSON(repo, '.dxkit/policy.json');
    expect(p.baseline.mode).toBe('committed-full');
    expect(p.confidence.critical).toBe(0.9);
    expect(p.loop.preset).toBe('security-only');
  });

  it('does not clobber a malformed settings.json — writes a sidecar instead', () => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{ not json');
    const r = installClaudeLoop(repo);
    expect(read(repo, '.claude/settings.json')).toBe('{ not json');
    expect(r.sidecars).toContain(path.join('.claude', 'settings.json.dxkit'));
  });
});
