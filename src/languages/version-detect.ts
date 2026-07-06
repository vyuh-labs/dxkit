/**
 * Shared primitives for pack-declared toolchain-version detection
 * (`LanguageSupport.detectVersion`). Each pack reads its own manifest to
 * determine the version the repo targets — .NET TargetFramework, `go.mod`'s
 * `go X.Y`, `.ruby-version`, etc. — and dxkit provisions THAT SDK in CI /
 * the devcontainer instead of a hardcoded default (CLAUDE.md Rule 6: the fact
 * lives in the pack, not a `detect.ts` switch).
 *
 * These are read-only, dependency-free file helpers so a pack's `detectVersion`
 * is a few lines. Detection MUST fail soft: return undefined on any miss so the
 * consumer falls back to the pack's `defaultVersion`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/** Read a repo-relative file, or `''` when it doesn't exist / can't be read. */
export function readRepoFile(cwd: string, relPath: string): string {
  try {
    return fs.readFileSync(path.join(cwd, relPath), 'utf-8');
  } catch {
    return '';
  }
}

export function repoFileExists(cwd: string, ...segments: string[]): boolean {
  return fs.existsSync(path.join(cwd, ...segments));
}

/** The installed Node major (e.g. `'20'`), or undefined — the last-resort node source. */
export function installedNodeMajor(): string | undefined {
  try {
    const out = execSync('node --version', { stdio: 'pipe' }).toString().trim();
    const m = out.replace(/^v/, '').match(/^(\d+)/);
    if (m) return m[1];
  } catch {
    /* node not installed */
  }
  return undefined;
}
