import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'dist', 'index.js');

// ── bare `init --detect` ────────────────────────────────────────────────
// Asserts the 2.5.1 default-quiet shape: no `.claude/` scaffold written
// unless the user opts in via `--with-dxkit-agents` (or `--full`).
describe('cli init --detect (integration, no agent scaffold)', () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `CLI not built at ${CLI}. Run 'npm run build' before running integration tests.`,
      );
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-test-bare-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'cli-init-test', version: '0.0.1' }, null, 2),
    );
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    execFileSync('node', [CLI, 'init', '--detect'], { cwd: tmpDir, stdio: 'pipe' });
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes a manifest at .vyuh-dxkit.json', () => {
    const manifestPath = path.join(tmpDir, '.vyuh-dxkit.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest).toHaveProperty('version');
    expect(manifest).toHaveProperty('files');
  });

  it('does NOT write CLAUDE.md without --with-dxkit-agents (or --full)', () => {
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
  });

  it('does NOT write AGENTS.md without --with-dxkit-agents (or --full)', () => {
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('does NOT create .claude/ scaffold on bare init', () => {
    // Bare init is the quiet default — agent scaffold is opt-in.
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
  });
});

// ── `init --full --yes` ────────────────────────────────────────────────
// Asserts the full ship surface, including the six dxkit-specific
// skills, AGENTS.md, the CLAUDE.md shim, and settings.json.
describe('cli init --full --yes (integration, full agent scaffold)', () => {
  let tmpDir: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI}. Run 'npm run build'.`);
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-test-full-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'cli-init-test-full', version: '0.0.1' }, null, 2),
    );
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    execFileSync('node', [CLI, 'init', '--full', '--yes'], { cwd: tmpDir, stdio: 'pipe' });
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates AGENTS.md at the project root', () => {
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('creates CLAUDE.md shim at the project root', () => {
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
  });

  it('creates .claude/settings.json with valid JSON', () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(parsed).toHaveProperty('permissions');
  });

  it('wires the fail-open context-hook as a Grep|Glob PreToolUse hook', () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const preToolUse = parsed.hooks?.PreToolUse ?? [];
    const entry = preToolUse.find((h: { matcher?: string }) => h.matcher === 'Grep|Glob');
    expect(entry).toBeDefined();
    const cmd = entry.hooks?.[0]?.command ?? '';
    expect(cmd).toContain('vyuh-dxkit context-hook');
  });

  it('writes all dxkit-* skills under .claude/skills/', () => {
    const expected = [
      'dxkit-learn',
      'dxkit-init',
      'dxkit-config',
      'dxkit-hooks',
      'dxkit-reports',
      'dxkit-action',
      'dxkit-fix',
      'dxkit-update',
      'dxkit-onboard',
      'dxkit-feature',
      'dxkit-docs',
      'dxkit-ingest',
      'dxkit-allowlist',
    ];
    for (const name of expected) {
      const skillPath = path.join(tmpDir, '.claude', 'skills', name, 'SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
    }
  });

  it('does NOT ship the deleted generic .claude/commands or .claude/agents dirs', () => {
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'agents-available'))).toBe(false);
  });

  it('writes a manifest at .vyuh-dxkit.json', () => {
    const manifestPath = path.join(tmpDir, '.vyuh-dxkit.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest).toHaveProperty('version');
    expect(manifest).toHaveProperty('files');
  });
});
