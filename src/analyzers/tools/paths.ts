/**
 * Path normalization helpers shared across tool wrappers.
 *
 * Every tool that shells out and parses a JSON report (gitleaks, semgrep,
 * jscpd, graphify, ...) ends up with file paths whose shape depends on
 * the tool and the cwd it was invoked with. Instead of each wrapper
 * inventing its own `.replace(cwd, '')` slicing — which silently
 * corrupts filenames when `cwd === '.'` (the literal `.` in `.env` is
 * treated as the cwd match and stripped) — they go through
 * `toProjectRelative` here.
 */

import * as path from 'path';

/**
 * Normalize a tool-reported path to a POSIX project-relative string.
 *
 * Handles: absolute paths, paths relative to cwd, cwd passed as `.` or
 * with a trailing slash, filenames with literal leading dots (`.env`,
 * `.dxkit-suppressions.json`). Uses `path.relative` on resolved
 * absolute forms so there's no string munging to go wrong.
 */
export function toProjectRelative(cwd: string, fileFromTool: string): string {
  const absCwd = path.resolve(cwd);
  const absFile = path.isAbsolute(fileFromTool) ? fileFromTool : path.resolve(absCwd, fileFromTool);
  return path.relative(absCwd, absFile).split(path.sep).join('/');
}
