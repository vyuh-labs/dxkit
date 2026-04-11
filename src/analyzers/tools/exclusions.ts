/**
 * Centralized exclusion paths for all analyzer tools.
 *
 * Single source of truth for what directories and file patterns to skip
 * during analysis. All tool modules (generic, cloc, graphify, semgrep, gitleaks)
 * derive their exclusion arguments from here.
 *
 * Why centralized:
 * - Prevents the bug where excluding `public/assets` works in one tool but
 *   breaks source file counts in another.
 * - Adding a new excluded path (e.g., a new build artifact directory) is
 *   one edit, not N edits across tool files.
 * - Future: can read .gitignore for project-specific exclusions.
 */

/**
 * Directories to exclude from ALL analysis.
 * These contain third-party code, generated files, or binary artifacts.
 */
export const EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  '.git',
  'vendor',
  'build',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.tox',
  '.venv',
  'venv',
  'target', // rust
  'bin', // csharp
  'obj', // csharp
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
];

/**
 * Deeper paths to exclude — these handle vendored JS/CSS that lives inside
 * otherwise-valid source directories. Only exclude these from source counting,
 * NOT from secret scanning (secrets in vendored JS are still findings).
 */
export const EXCLUDED_SOURCE_PATHS: readonly string[] = [
  'public/assets',
  'static/js',
  'public/static',
];

/**
 * File patterns to exclude (minified/generated).
 */
export const EXCLUDED_FILE_PATTERNS: readonly string[] = [
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.chunk.js',
  '*.generated.ts',
  '*.d.ts',
];

/**
 * Build `find -not -path` flags excluding directories.
 * Usage: `find . -type f ... ${getFindExcludeFlags()}`
 */
export function getFindExcludeFlags(includeSourcePaths = true): string {
  const dirs = [...EXCLUDED_DIRS];
  if (includeSourcePaths) {
    dirs.push(...EXCLUDED_SOURCE_PATHS);
  }
  return dirs.map((d) => `-not -path "*/${d}/*"`).join(' ');
}

/**
 * Build a chain of `| grep -v <dir>` filters for piped commands.
 * Usage: `grep -r ... | ${getGrepVFilters()}`
 */
export function getGrepVFilters(): string {
  return EXCLUDED_DIRS.map((d) => `grep -v '${d}'`).join(' | ');
}

/**
 * Build cloc `--exclude-dir` argument value (comma-separated basenames).
 * cloc matches on directory BASENAMES only, not full paths.
 * So `public/assets` becomes `public,assets` — cloc will exclude any dir
 * named `public` OR `assets` anywhere in the tree.
 * Usage: `cloc --exclude-dir=${getClocExcludeDirs()}`
 */
export function getClocExcludeDirs(): string {
  const basenames = new Set<string>(EXCLUDED_DIRS);
  for (const p of EXCLUDED_SOURCE_PATHS) {
    for (const seg of p.split('/')) {
      if (seg) basenames.add(seg);
    }
  }
  return Array.from(basenames).join(',');
}

/**
 * Build semgrep `--exclude` flags (one per directory).
 * Usage: `semgrep scan ${getSemgrepExcludeFlags()} .`
 */
export function getSemgrepExcludeFlags(): string {
  const dirs = [...EXCLUDED_DIRS, ...EXCLUDED_SOURCE_PATHS];
  const dirFlags = dirs.map((d) => `--exclude '${d}'`).join(' ');
  const fileFlags = EXCLUDED_FILE_PATTERNS.map((p) => `--exclude '${p}'`).join(' ');
  return `${dirFlags} ${fileFlags}`;
}

/**
 * Python set literal for graphify script — basenames only.
 * The graphify filter uses `any(ex in f.parts for ex in EXCLUDE_DIRS)`
 * which checks individual path segments, so we need dir basenames.
 * Usage: embed into a Python string template.
 */
export function getPythonExcludeSet(): string {
  const basenames = new Set<string>(EXCLUDED_DIRS);
  for (const p of EXCLUDED_SOURCE_PATHS) {
    for (const seg of p.split('/')) {
      if (seg) basenames.add(seg);
    }
  }
  return (
    '{' +
    Array.from(basenames)
      .map((d) => `'${d}'`)
      .join(', ') +
    '}'
  );
}
