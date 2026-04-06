import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'dist', 'index.js');

describe('cli init --detect (integration)', () => {
  let tmpDir: string;

  beforeAll(() => {
    // Ensure the CLI is built. If not, fail loudly so the user knows to run `npm run build`.
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `CLI not built at ${CLI}. Run 'npm run build' before running integration tests.`,
      );
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-test-'));
    // Seed a minimal node project so detect has something to find
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'cli-init-test', version: '0.0.1' }, null, 2),
    );
    // Init a git repo so any tooling that checks for one is happy
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });

    execFileSync('node', [CLI, 'init', '--detect'], {
      cwd: tmpDir,
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates the .claude directory', () => {
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(true);
  });

  it('creates .claude/settings.json with valid JSON', () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(parsed).toHaveProperty('permissions');
  });

  it('creates the standard .claude subdirectories', () => {
    for (const dir of ['agents', 'commands', 'skills']) {
      expect(fs.existsSync(path.join(tmpDir, '.claude', dir))).toBe(true);
    }
  });

  it('writes a manifest at .vyuh-dxkit.json', () => {
    const manifestPath = path.join(tmpDir, '.vyuh-dxkit.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest).toHaveProperty('version');
    expect(manifest).toHaveProperty('files');
  });

  it('creates CLAUDE.md at the project root', () => {
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
  });
});
