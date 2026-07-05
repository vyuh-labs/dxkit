/**
 * Install/uninstall LIFECYCLE harness — the real-repo net.
 *
 * Every dogfood-reported install/uninstall bug lived in the seam between dxkit
 * and a real repo (its package manager, its pre-existing files, its toolchain) —
 * a seam the unit suite never exercises because it uses synthetic fixtures and
 * dxkit dogfoods itself. This harness runs the REAL CLI (built `dist/index.js`)
 * against realistic throwaway git repos and asserts the load-bearing promise:
 * after `uninstall`, the working tree is byte-identical to the pre-dxkit commit,
 * and dxkit never claims provenance over a file it didn't author.
 *
 * It shells out to a separate node process, so it stays cheap even under the
 * default suite's coverage instrumentation, and it is package-manager-agnostic
 * (it drives dxkit's own code paths; the PM-behavior scenarios that need a real
 * pnpm live in the multi-ecosystem fixtures).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

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
function porcelain(cwd: string): string {
  return git(cwd, 'status', '--porcelain').trim();
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-lifecycle-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 'test');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('install/uninstall round-trip restores the exact pre-dxkit state', () => {
  it('a fresh repo returns byte-clean after uninstall', () => {
    write(repo, 'package.json', JSON.stringify({ name: 'fresh', version: '1.0.0' }));
    write(repo, 'src/index.ts', 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'pre-dxkit');

    cli(repo, 'init', '--with-dxkit-agents', '--yes');
    expect(porcelain(repo)).not.toBe(''); // dxkit added files
    cli(repo, 'uninstall', '--yes', '--remove-devdep');
    expect(porcelain(repo)).toBe(''); // …and removed every trace
    expect(existsSync(join(repo, '.vyuh-dxkit.json'))).toBe(false); // manifest gone too
  });

  it('a tool `tools install` recorded is removed on uninstall (no disowned artifact)', () => {
    write(repo, 'package.json', '{\n  "name": "cov",\n  "version": "1.0.0"\n}\n');
    write(repo, 'src/index.ts', 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'pre-dxkit');

    cli(repo, 'init', '--with-dxkit-agents', '--yes');
    // Simulate what `tools install` now does: add a coverage devDep AND record
    // it in the manifest so uninstall owns it (real `tools install` needs a
    // network install; here we drive the recorded-state contract directly).
    const pkgPath = join(repo, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), '@vitest/coverage-v8': '^4.0.0' };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const mPath = join(repo, '.vyuh-dxkit.json');
    const m = JSON.parse(readFileSync(mPath, 'utf8')) as { toolDeps?: unknown[] };
    m.toolDeps = [{ package: '@vitest/coverage-v8', ecosystem: 'node' }];
    writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
    // Everything dxkit added stays UNCOMMITTED (as in a real install), so a
    // clean uninstall returns the tree to the committed pre-dxkit state.

    cli(repo, 'uninstall', '--yes', '--remove-devdep');
    expect(porcelain(repo)).toBe(''); // coverage devDep removed too → byte-clean
    expect(readFileSync(pkgPath, 'utf8')).not.toMatch(/coverage-v8/);
  });

  it('preserves a TAB-indented package.json byte-for-byte across the round-trip', () => {
    // 2.27.0 root cause: init reformatted package.json (compact/tab → 2-space
    // pretty), a change uninstall could not undo. `serializePreservingJson`
    // detects the original style; the compact + 2-space branches are covered by
    // the scenarios above, this pins the TAB branch — a real style dxkit must
    // not silently rewrite to spaces on a devDep add.
    const tabPkg = '{\n\t"name": "tabbed",\n\t"version": "1.0.0"\n}\n';
    write(repo, 'package.json', tabPkg);
    write(repo, 'src/index.ts', 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'pre-dxkit tab-indented');

    cli(repo, 'init', '--with-dxkit-agents', '--yes');
    // If init added a devDep it must have kept the tab indentation (no diff on
    // the pre-existing lines); if it touched package.json at all, the style
    // holds. Either way the round-trip must land byte-clean.
    const afterInit = readFileSync(join(repo, 'package.json'), 'utf8');
    if (afterInit !== tabPkg) expect(afterInit).toMatch(/\n\t"/); // still tab-indented

    cli(repo, 'uninstall', '--yes', '--remove-devdep');
    expect(readFileSync(join(repo, 'package.json'), 'utf8')).toBe(tabPkg);
    expect(porcelain(repo)).toBe('');
  });

  it('NEVER claims a pre-existing AGENTS.md / CLAUDE.md as dxkit-created (data-loss guard)', () => {
    // These files predate dxkit — the project authored them.
    const agents = '# My Project\n\nProject-authored agent guidance.\n';
    const claude = '# My CLAUDE config\n\nProject-authored notes.\n';
    write(repo, 'AGENTS.md', agents);
    write(repo, 'CLAUDE.md', claude);
    write(repo, 'package.json', JSON.stringify({ name: 'brown', version: '1.0.0' }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'pre-dxkit brownfield');

    cli(repo, 'init', '--with-dxkit-agents', '--yes');

    // The manifest must not mark a file dxkit merely skipped as one it created.
    const manifest = JSON.parse(readFileSync(join(repo, '.vyuh-dxkit.json'), 'utf8')) as {
      files: Record<string, { provenance?: string }>;
    };
    for (const f of ['AGENTS.md']) {
      const entry = manifest.files[f];
      if (entry) expect(entry.provenance, `${f} provenance`).not.toBe('created');
    }

    // The uninstall plan must never offer to --force-delete a project file.
    const plan = cli(repo, 'uninstall');
    expect(plan).not.toMatch(/AGENTS\.md.*use --force to remove/);

    // Even a --force uninstall must NOT delete or alter the project's own files.
    cli(repo, 'uninstall', '--yes', '--force', '--remove-devdep');
    expect(existsSync(join(repo, 'AGENTS.md')), 'AGENTS.md survives --force').toBe(true);
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(claude);
    expect(porcelain(repo)).toBe(''); // byte-clean: project files intact, dxkit gone
  });
});

describe('load-bearing activation does not depend on a package-manager hook', () => {
  it('init --with-hooks activates core.hooksPath itself (not via postinstall)', () => {
    write(repo, 'package.json', JSON.stringify({ name: 'hooks', version: '1.0.0' }));
    write(repo, 'src/index.ts', 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'pre-dxkit');

    // No package manager runs here — init must not defer the load-bearing
    // git-config write to a postinstall script that a given PM may skip.
    cli(repo, 'init', '--with-hooks', '--yes');
    const hooksPath = git(repo, 'config', '--local', '--get', 'core.hooksPath').trim();
    expect(hooksPath).toBe('.githooks');
  });
});
