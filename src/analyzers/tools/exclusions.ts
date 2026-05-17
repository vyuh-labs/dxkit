/**
 * Centralized exclusions — data-driven from `.gitignore`-style files.
 *
 * Three layers, unioned:
 *   1. Bundled `default-exclusions.gitignore`  — ships with dxkit, always applied.
 *   2. Project `.gitignore`                    — whatever the repo already ignores.
 *   3. Project `.dxkit-ignore` (optional)       — dxkit-specific extras.
 *
 * All three use the same parser so they behave identically. Users add/remove
 * exclusions by editing a plain text file — no code changes needed.
 *
 * The canonical question "should this path be excluded?" is answered by
 * `isExcludedPath()`. Tool-specific flag builders (grep, cloc, semgrep, find,
 * graphify's Python) derive their flags from the same resolved exclusion set,
 * so drift between tools is impossible.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Resolved exclusions for one project root. */
export interface Exclusions {
  /** Directory basenames — single-segment (no slash). Grep/find --exclude-dir friendly. */
  dirs: string[];
  /** Multi-segment path patterns. Need path-based matching. */
  sourcePaths: string[];
  /** File-glob patterns (e.g. *.min.js, *.d.ts, .DS_Store). */
  filePatterns: string[];
}

/** Memo: one entry per cwd so repeated helper calls don't re-read files. */
const cache = new Map<string, Exclusions>();

/** Absolute path to the bundled default exclusions file. */
const DEFAULTS_PATH = path.join(__dirname, 'default-exclusions.gitignore');

/**
 * Load resolved exclusions for a project root.
 *
 * Reads bundled defaults + project .gitignore + project .dxkit-ignore and
 * returns the union. Result is memoized per cwd for the process lifetime.
 */
export function loadExclusions(cwd: string): Exclusions {
  const hit = cache.get(cwd);
  if (hit) return hit;

  const dirs = new Set<string>();
  const sourcePaths = new Set<string>();
  const filePatterns = new Set<string>();

  parseGitignoreFile(DEFAULTS_PATH, dirs, sourcePaths, filePatterns);
  parseGitignoreFile(path.join(cwd, '.gitignore'), dirs, sourcePaths, filePatterns);
  parseGitignoreFile(path.join(cwd, '.dxkit-ignore'), dirs, sourcePaths, filePatterns);

  const resolved: Exclusions = {
    dirs: [...dirs],
    sourcePaths: [...sourcePaths],
    filePatterns: [...filePatterns],
  };
  cache.set(cwd, resolved);
  return resolved;
}

/** Clear memo — useful for tests. */
export function clearExclusionsCache(): void {
  cache.clear();
}

/**
 * Parse a .gitignore-style file, classifying each entry into dirs / sourcePaths
 * / filePatterns. Best-effort mapping of gitignore semantics:
 *
 *   `foo/`          directory basename         → dirs
 *   `foo/bar/`      multi-segment path         → sourcePaths
 *   `*.log`         glob (contains `*`)         → filePatterns
 *   `.DS_Store`     specific file (has `.`)    → filePatterns
 *   `.env`          specific file              → filePatterns
 *   `foo`           bare name, no `.` no slash → dirs
 *
 * Lines starting with `#` or `!`, and blank lines, are skipped. Leading `/`
 * is stripped (we treat all patterns as "anywhere in tree" — the same way
 * gitignore treats leading-slash patterns relative to the repo root).
 */
function parseGitignoreFile(
  filePath: string,
  dirs: Set<string>,
  sourcePaths: Set<string>,
  filePatterns: Set<string>,
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const noSlash = line.replace(/^\//, '');
    const isDir = noSlash.endsWith('/');
    const core = isDir ? noSlash.slice(0, -1) : noSlash;

    if (!core) continue;

    // Glob patterns (*, ?) are always file patterns.
    if (core.includes('*') || core.includes('?')) {
      filePatterns.add(core);
      continue;
    }

    // Multi-segment: directory path OR nested file.
    if (core.includes('/')) {
      sourcePaths.add(core);
      continue;
    }

    // Single segment: `foo/` → dir, `foo.txt` (has extension) → file,
    // `.env` (dotfile without extension) → file, `foo` (bare name) → dir.
    if (isDir) {
      dirs.add(core);
    } else if (/^\.[^.]+$/.test(core) || core.includes('.')) {
      // Dotfiles (.env, .DS_Store) and files with extensions (foo.log).
      filePatterns.add(core);
    } else {
      dirs.add(core);
    }
  }
}

// ─── Path predicate (centralized) ──────────────────────────────────────────

/**
 * Test whether a relative file path should be excluded from analysis.
 *
 * This is the ONE place every tool-wrapper consults. If a caller is tempted
 * to inline `node_modules` / `dist` / `.min.` checks, they should call this
 * instead. Keeps all tools behaving identically.
 *
 * Path must be relative (strip the cwd prefix before calling).
 */
export function isExcludedPath(cwd: string, relPath: string): boolean {
  if (!relPath) return false;
  const { dirs, sourcePaths, filePatterns } = loadExclusions(cwd);
  const segs = relPath.split('/').filter(Boolean);

  if (dirs.some((d) => segs.includes(d))) return true;
  if (sourcePaths.some((p) => relPath.includes(p))) return true;

  const base = segs[segs.length - 1] || '';
  for (const pat of filePatterns) {
    if (matchFileGlob(pat, base)) return true;
  }
  return false;
}

/** Match a basename against a simple glob (* and ?). */
function matchFileGlob(pattern: string, base: string): boolean {
  // If pattern has no wildcards, require exact basename match.
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return base === pattern;
  }
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return regex.test(base);
}

// ─── Tool-specific flag builders ────────────────────────────────────────────

/**
 * Build `find -not -path` flags excluding directories.
 * Usage: `find . -type f ... ${getFindExcludeFlags(cwd)}`
 */
export function getFindExcludeFlags(cwd: string, includeSourcePaths = true): string {
  const { dirs, sourcePaths } = loadExclusions(cwd);
  const all = includeSourcePaths ? [...dirs, ...sourcePaths] : dirs;
  return all.map((d) => `-not -path "*/${d}/*"`).join(' ');
}

/**
 * Build grep `--exclude-dir` flags (basename matching only).
 * Path-based exclusions must be post-filtered via isExcludedPath().
 */
export function getGrepExcludeDirFlags(cwd: string): string {
  const { dirs } = loadExclusions(cwd);
  return dirs.map((d) => `--exclude-dir='${d}'`).join(' ');
}

/**
 * Build cloc exclusion flags — `--exclude-dir` (basenames) PLUS
 * `--fullpath --not-match-d` (Perl regex on full directory path) for
 * multi-segment sourcePaths.
 *
 * D055 (2.4.7): pre-fix, multi-segment paths in `.dxkit-ignore` were
 * flattened to basenames here, so `Dev/Addons/DPLAddon/SAPB1/` silently
 * became `{Dev, Addons, DPLAddon, SAPB1}` — cloc then excluded EVERY
 * directory named `Dev` in the tree, killing 90% of source visibility
 * on dpl-studio. The split-flag construction preserves the path
 * structure for cloc.
 *
 * The regex is anchored on path-segment boundaries with `(?:^|/)` /
 * `(?:/|$)` so `Dev/Addons/Foo` doesn't accidentally match `Dev/AddonsX`
 * or `XDev/Addons`. Path components are regex-escaped so `.`, `+`, etc.
 * aren't interpreted as metachars.
 */
export function getClocExcludeFlags(cwd: string): string {
  const { dirs, sourcePaths } = loadExclusions(cwd);
  const parts: string[] = [];
  if (dirs.length > 0) {
    parts.push(`--exclude-dir=${dirs.join(',')}`);
  }
  if (sourcePaths.length > 0) {
    const escaped = sourcePaths.map(escapeRegex);
    parts.push(`--fullpath --not-match-d='(?:^|/)(?:${escaped.join('|')})(?:/|$)'`);
  }
  return parts.join(' ');
}

/**
 * Build semgrep `--exclude` flags (one per directory/pattern).
 * Usage: `semgrep scan ${getSemgrepExcludeFlags(cwd)} .`
 */
export function getSemgrepExcludeFlags(cwd: string): string {
  const { dirs, sourcePaths, filePatterns } = loadExclusions(cwd);
  const dirFlags = [...dirs, ...sourcePaths].map((d) => `--exclude '${d}'`).join(' ');
  const fileFlags = filePatterns.map((p) => `--exclude '${p}'`).join(' ');
  return `${dirFlags} ${fileFlags}`;
}

/**
 * Python literals for the graphify walker — emits both a basename set
 * (`EXCLUDE_DIRS`) and a multi-segment path list (`EXCLUDE_PATHS`) so
 * the Python filter can preserve the path structure of multi-segment
 * `.dxkit-ignore` entries.
 *
 * D055 (2.4.7): pre-fix, basenames-only flattening here meant
 * `Dev/Addons/DPLAddon/SAPB1/` became `{Dev, Addons, DPLAddon, SAPB1}`
 * — graphify then skipped every `Dev/` subtree in dpl-studio (10 files
 * walked instead of ~1700, Functions=13). The two-set shape lets the
 * walker check basenames via segment membership AND check paths via
 * substring match on the file's relpath.
 */
export function getPythonExcludeFilter(cwd: string): {
  dirsSet: string;
  pathsList: string;
  fileGlobsList: string;
} {
  const { dirs, sourcePaths, filePatterns } = loadExclusions(cwd);
  // `set([...])` rather than `{...}` because `{}` is an empty dict in Python.
  const dirsSet = `set([${dirs.map((d) => `'${d}'`).join(', ')}])`;
  const pathsList = '[' + sourcePaths.map((p) => `'${p}'`).join(', ') + ']';
  // File-glob patterns (`*.min.js`, `*.bundle.js`, `*.chunk.js`,
  // `*.generated.ts`, `*.d.ts`). Pre-extension only `dirs` + `sourcePaths`
  // were passed; the graphify walker enumerated every `*.min.js`
  // matching basename and graphify's AST extractor analyzed them.
  // Web-client's densest-file metric ranked
  // `public/3DFileViewer/assets/index-j54KQSsm.js` (a webpack-hash
  // bundle) as 4,606 "functions" — the kind of metric that makes the
  // "split your densest file" recommendation read as a bug to anyone
  // who knows what the file is.
  const fileGlobsList = '[' + filePatterns.map((p) => `'${p}'`).join(', ') + ']';
  return { dirsSet, pathsList, fileGlobsList };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
