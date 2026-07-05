/**
 * exportToolPathsToGithubEnv — the recipe-safe CI scanner-PATH export.
 *
 * In CI, the per-language dep audit must find its NATIVE scanner (osv-scanner,
 * pip-audit, govulncheck, cargo-audit, …) or it silently falls back to a
 * wrong-artifact one (npm-audit on a pnpm repo) and drifts from the baseline.
 * Rather than a hardcoded PATH list in the workflow — which a NEW language pack
 * would silently outgrow — the export is derived from the SAME sources
 * `findTool` probes: `getSystemPaths()` + every tool's `probePaths`. These tests
 * pin that so adding a pack (which already declares its tool's probePaths for
 * detection) auto-extends CI PATH coverage with no workflow edit.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportToolPathsToGithubEnv, TOOL_DEFS } from '../src/analyzers/tools/tool-registry';

describe('exportToolPathsToGithubEnv (CI scanner-PATH, recipe-safe)', () => {
  const saved = process.env.GITHUB_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_PATH;
    else process.env.GITHUB_PATH = saved;
  });

  it('off CI (no GITHUB_PATH) it is a no-op but still returns the dir list', () => {
    delete process.env.GITHUB_PATH;
    expect(exportToolPathsToGithubEnv().length).toBeGreaterThan(0);
  });

  it('includes EVERY declared tool probePath — a new pack tool is auto-covered', () => {
    delete process.env.GITHUB_PATH;
    const dirs = exportToolPathsToGithubEnv();
    for (const p of Object.values(TOOL_DEFS).flatMap((d) => d.probePaths ?? [])) {
      expect(dirs).toContain(p);
    }
  });

  it('covers each ecosystem bin dir and writes them to $GITHUB_PATH under CI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-ghpath-'));
    const file = join(dir, 'gh_path');
    process.env.GITHUB_PATH = file;
    try {
      const dirs = exportToolPathsToGithubEnv();
      const written = readFileSync(file, 'utf8');
      // osv-scanner/pip-audit → ~/.local/bin, govulncheck → ~/go/bin,
      // cargo-audit → ~/.cargo/bin: every native scanner's home is present.
      for (const suffix of ['.local/bin', 'go/bin', '.cargo/bin']) {
        expect(
          dirs.some((d) => d.endsWith(suffix)),
          `dirs include *${suffix}`,
        ).toBe(true);
        expect(written).toContain(suffix);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
