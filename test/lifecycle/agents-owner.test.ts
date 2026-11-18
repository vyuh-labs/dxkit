/**
 * The AGENTS.md owner section across the real CLI lifecycle (4.5.0
 * agents-owner): init → the owner writes product notes → update / update
 * --force / re-init refresh dxkit's sections and keep the notes → uninstall
 * keeps the notes as the file. An edit outside the section keeps today's
 * protection (never clobbered). Runs the built `dist/index.js` against
 * throwaway git repos, like `roundtrip.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const START = '<!-- dxkit:owner:start -->';
const END = '<!-- dxkit:owner:end -->';

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`dist/index.js missing — run \`npm run build\` first (test:run does this).`);
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
function cli(cwd: string, ...args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const NOTES = [
  '## What this is',
  '',
  'Order intake web app for the warehouse team.',
  '',
  '- Build: `msbuild WebApp.sln /p:Configuration=Release` (Windows only)',
  '- Test: none yet',
  '',
].join('\n');

/** Put `notes` between the markers of an AGENTS.md. */
function withNotes(agents: string, notes = NOTES): string {
  const s = agents.indexOf(START) + START.length + 1;
  const e = agents.indexOf(END);
  return agents.slice(0, s) + notes + agents.slice(e);
}
function notesOf(agents: string): string {
  return agents.slice(agents.indexOf(START) + START.length + 1, agents.indexOf(END));
}

let repo: string;
const agentsAbs = () => join(repo, 'AGENTS.md');
const readAgents = () => readFileSync(agentsAbs(), 'utf8');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-owner-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 'test');
  write(repo, 'package.json', JSON.stringify({ name: 'owner', version: '1.0.0' }));
  write(repo, 'src/index.ts', 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'pre-dxkit');
  cli(repo, 'init', '--with-dxkit-agents', '--yes', '--no-finish');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('AGENTS.md owner section across init / update / --force / uninstall', () => {
  it('init writes an empty, explained owner section and no "A project" placeholder', () => {
    const agents = readAgents();
    expect(agents).toContain(`${START}\n${END}`);
    expect(agents).toContain('## About this product');
    expect(agents).not.toContain('A project');
  });

  it('update with owner edits: notes kept, dxkit sections still refreshed', () => {
    const fresh = readAgents();
    // A stale dxkit section the manifest still records as dxkit's (an older
    // version's prose): update must refresh it even though the owner wrote
    // notes, because the notes are outside provenance.
    const stale = fresh.replace('## How to use this file', '## How to use this file (OLD)');
    const mPath = join(repo, '.vyuh-dxkit.json');
    const m = JSON.parse(readFileSync(mPath, 'utf8')) as {
      files: Record<string, { hash: string | null }>;
    };
    m.files['AGENTS.md'].hash = createHash('sha256').update(stale, 'utf-8').digest('hex');
    writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
    writeFileSync(agentsAbs(), withNotes(stale));

    cli(repo, 'update');

    const after = readAgents();
    expect(after).not.toContain('(OLD)');
    expect(notesOf(after)).toBe(NOTES);
  });

  it('update --force and a re-run of init keep the notes', () => {
    writeFileSync(agentsAbs(), withNotes(readAgents()));
    cli(repo, 'update', '--force');
    expect(notesOf(readAgents())).toBe(NOTES);
    cli(repo, 'init', '--with-dxkit-agents', '--yes', '--no-finish', '--force');
    expect(notesOf(readAgents())).toBe(NOTES);
  });

  it('update with an edit OUTSIDE the section leaves the whole file alone, even --force', () => {
    const edited = withNotes(readAgents()).replace('## Conventions', '## Team conventions');
    writeFileSync(agentsAbs(), edited);
    cli(repo, 'update', '--force');
    expect(readAgents()).toBe(edited);
  });

  it('uninstall keeps the owner notes as the file; an empty section is removed', () => {
    writeFileSync(agentsAbs(), withNotes(readAgents()));
    cli(repo, 'uninstall', '--yes', '--remove-devdep');
    expect(readAgents()).toBe(NOTES.replace(/\n+$/, '\n'));
    expect(existsSync(join(repo, '.vyuh-dxkit.json'))).toBe(false);
  });
});

describe('the stack heading on a .NET Framework web app', () => {
  it('names the runtime and app model, not a language version', () => {
    const net = mkdtempSync(join(tmpdir(), 'dxkit-owner-net-'));
    try {
      git(net, 'init', '-q');
      write(
        net,
        'WebApp/WebApp.csproj',
        '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\n' +
          '  <PropertyGroup>\n    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>\n  </PropertyGroup>\n' +
          '  <Import Project="$(VSToolsPath)\\WebApplications\\Microsoft.WebApplication.targets" />\n' +
          '</Project>\n',
      );
      write(net, 'WebApp/Global.asax.cs', 'namespace WebApp { class Global {} }\n');
      cli(net, 'init', '--with-dxkit-agents', '--yes', '--no-finish');
      const agents = readFileSync(join(net, 'AGENTS.md'), 'utf8');
      expect(agents).toMatch(/^## C# on \.NET Framework 4\.8 \(ASP\.NET\)$/m);
      expect(agents).not.toMatch(/^## C# 8\.0$/m);
    } finally {
      rmSync(net, { recursive: true, force: true });
    }
  });
});
