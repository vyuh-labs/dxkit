/**
 * Changed-file computation for incremental scanning (opt 3).
 *
 * The loop guardrail blocks only on NET-NEW findings, and the scanners it
 * file-scopes (semgrep) are intraprocedural — every finding is local to a
 * single file. So a net-new finding can only live in a file the working
 * tree changed relative to the comparison base. Scanning just those files
 * catches every net-new finding while skipping the unchanged majority.
 *
 * # Safety: this set MUST be COMPLETE or fail safe
 *
 * If this under-reports the changed set, the gather would skip a file that
 * actually changed and miss a real net-new finding — a false negative in a
 * safety gate. So the contract is: return the COMPLETE set of files that
 * differ from the base (tracked edits + staged + untracked), or `null` on
 * ANY uncertainty (base unreachable, not a git repo, git error). A `null`
 * tells the caller to fall back to a FULL scan — the safe default. Never
 * return a partial set on error.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

/** Best-effort git stdout as lines; throws are surfaced to the caller so
 *  it can fail safe. `args` is fixed + caller-controlled (no shell). */
function gitLines(cwd: string, args: string[]): string[] {
  const out = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The complete set of project-relative files that differ from `baseSha` in
 * the working tree — tracked modifications/additions (staged + unstaged)
 * plus untracked files — restricted to files that still exist on disk (a
 * deleted file has no current content to scan).
 *
 * Returns `null` when the set cannot be computed completely (base
 * unreachable, not a git repo, any git failure). The caller MUST treat
 * `null` as "scan everything" — never as "nothing changed".
 */
export function computeChangedFiles(cwd: string, baseSha: string): ReadonlyArray<string> | null {
  if (!baseSha) return null;
  try {
    // `git diff --name-only <base>` compares base → working tree, covering
    // both staged and unstaged changes to tracked files (and additions).
    const tracked = gitLines(cwd, ['diff', '--name-only', baseSha, '--']);
    // Untracked, not-ignored files — these are new and unseen by the base.
    const untracked = gitLines(cwd, ['ls-files', '--others', '--exclude-standard']);
    const all = new Set<string>([...tracked, ...untracked]);
    // Keep only files that exist on disk now (drop deletions / renames-away).
    return [...all].filter((rel) => existsSync(path.join(cwd, rel)));
  } catch {
    return null; // any failure → full scan (safe default)
  }
}

/**
 * Line-granularity sibling of `computeChangedFiles` — the ONE changed-line
 * attribution the guardrail consults. Both live in this module because they
 * are two projections of one concept ("what did the working tree change vs
 * the base?") and MUST share a diff basis: base → WORKING TREE. The scan
 * reads the working tree, so attribution that diffed committed HEAD instead
 * demoted every finding an agent's uncommitted edit introduced (the 4.0.3
 * T1.1 hole).
 *
 * Per file, `linesFor` answers one of:
 *   - a set of working-tree line numbers changed vs base (tracked file);
 *   - `'all'` — the file is untracked, so every line is new;
 *   - `null` — attribution failed for this file. Callers must treat `null`
 *     as UNKNOWN (do not demote), never as "nothing changed": under-reporting
 *     here is a false negative in a safety gate.
 */
export interface ChangedLineIndex {
  linesFor(file: string): ReadonlySet<number> | 'all' | null;
}

export function createChangedLineIndex(cwd: string, baseSha: string): ChangedLineIndex | null {
  if (!baseSha) return null;
  let untracked: Set<string>;
  try {
    untracked = new Set(gitLines(cwd, ['ls-files', '--others', '--exclude-standard']));
  } catch {
    return null; // attribution unavailable everywhere → callers see unknown
  }
  const cache = new Map<string, ReadonlySet<number> | 'all' | null>();
  return {
    linesFor(file: string) {
      let hit = cache.get(file);
      if (hit === undefined) {
        hit = untracked.has(file) ? 'all' : readChangedLineSet(cwd, baseSha, file);
        cache.set(file, hit);
      }
      return hit;
    },
  };
}

/**
 * Working-tree line numbers modified since `baseSha` for `file`, from
 * `git diff --unified=0` hunk headers (new-side `+start,count`). One-sided
 * diff: base → working tree, staged + unstaged. Returns `null` on git
 * failure (unknown, per the ChangedLineIndex contract).
 */
function readChangedLineSet(cwd: string, baseSha: string, file: string): Set<number> | null {
  let diff: string;
  try {
    diff = execFileSync(
      'git',
      ['diff', '--unified=0', '--no-color', '--find-renames', baseSha, '--', file],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  const out = new Set<number>();
  if (!diff.trim()) return out;
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkRe.exec(diff)) !== null) {
    const newStart = parseInt(match[1], 10);
    const newCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    if (newCount === 0) {
      // Pure-deletion hunk on the new side — no new-side lines.
      continue;
    }
    for (let i = 0; i < newCount; i++) out.add(newStart + i);
  }
  return out;
}
