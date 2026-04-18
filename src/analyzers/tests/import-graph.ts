/**
 * Import-graph test matching.
 *
 * Replaces the filename-based `matchTestsToSource` heuristic with something
 * that actually reflects what a test exercises. A source file is "tested"
 * when at least one active test file imports it, directly or transitively
 * through a small number of hops.
 *
 * The point is to rescue common real-world shapes the filename matcher
 * misses:
 *
 *   test/cli-init.test.ts  imports  src/cli.ts
 *     src/cli.ts           imports  src/generator.ts, src/detect.ts, ...
 *   → all of those count as tested even though none of their filenames
 *     contain "cli-init".
 *
 * Scope: TS/JS + Python. Go, Rust, and C# are follow-ups; for now they
 * fall back to the filename matcher.
 *
 * Implementation: read each candidate file, extract `import` / `from ...
 * import` / `require(...)` module paths with regex, resolve each to a
 * project-relative path, BFS up to `maxHops` from the test-file seed set.
 * Node-style `node_modules` packages are treated as external and skipped.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LANGUAGES } from '../../languages';

export interface ImportGraphOptions {
  /** Transitive depth. 0 = direct imports only. Default 3. */
  maxHops?: number;
}

const TS_JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Build the set of source files reachable from the given test-file seeds by
 * following import edges up to maxHops. Paths are project-relative.
 */
export function buildReachable(
  seeds: string[],
  cwd: string,
  options: ImportGraphOptions = {},
): Set<string> {
  const maxHops = options.maxHops ?? 3;
  const reached = new Set<string>();
  let frontier = seeds.slice();
  for (let hop = 0; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const file of frontier) {
      const imports = extractImports(file, cwd);
      for (const raw of imports) {
        const resolved = resolveImport(file, raw, cwd);
        if (!resolved) continue;
        if (reached.has(resolved)) continue;
        reached.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }
  return reached;
}

// ─── Extraction ─────────────────────────────────────────────────────────────

/** Raw module specifiers imported by the given file. External pkgs included. */
export function extractImports(relPath: string, cwd: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(path.join(cwd, relPath), 'utf-8');
  } catch {
    return [];
  }
  // Dispatch through language registry first; fall back to TS/JS.
  const ext = path.extname(relPath);
  const lang = LANGUAGES.find((l) => l.sourceExtensions.includes(ext));
  if (lang?.extractImports) return lang.extractImports(content);
  return extractTsJsImports(content);
}

/**
 * TS / JS: capture quoted specifiers in import / require / dynamic import.
 * Deliberately loose — we want recall, not parser fidelity.
 */
export function extractTsJsImports(content: string): string[] {
  const out: string[] = [];
  const stripped = stripTsJsComments(content);
  // Static imports: `import X from '...'`, `import { a } from '...'`, or
  // side-effect `import '...';`. Require whitespace after `import` so we
  // don't misfire on `import.meta` or similar.
  const importRe = /\bimport\s+(?:[^'";]*?from\s+)?['"]([^'"]+)['"]/g;
  // Re-exports: `export * from '...'`, `export { x } from '...'` — these
  // are dependency edges even though they're not literal imports.
  const reexportRe = /\bexport\s+(?:[^'";]*?from\s+)['"]([^'"]+)['"]/g;
  // Dynamic imports: import('...')
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // CommonJS: require('...')
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [importRe, reexportRe, dynRe, reqRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      out.push(m[1]);
    }
  }
  return out;
}

/** Python: `import foo.bar`, `from foo.bar import X`, `from .rel import X`. */
export function extractPyImports(content: string): string[] {
  const out: string[] = [];
  const lines = stripPyComments(content).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // `from X import Y` — keep X (may be relative: leading dots)
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+/);
    if (fromMatch) {
      out.push(fromMatch[1]);
      continue;
    }
    // `import X` / `import X as Y` / `import X, Y`
    const impMatch = trimmed.match(/^import\s+(.+)$/);
    if (impMatch) {
      for (const part of impMatch[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) out.push(name);
      }
    }
  }
  return out;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve a raw import specifier to a project-relative file path, or null
 * if it's external or unresolvable.
 */
export function resolveImport(fromFile: string, spec: string, cwd: string): string | null {
  // Dispatch through language registry first; fall back to TS/JS.
  const ext = path.extname(fromFile);
  const lang = LANGUAGES.find((l) => l.sourceExtensions.includes(ext));
  if (lang?.resolveImport) return lang.resolveImport(fromFile, spec, cwd);
  return resolveTsJsImport(fromFile, spec, cwd);
}

function resolveTsJsImport(fromFile: string, spec: string, cwd: string): string | null {
  // Only relative paths are internal; everything else is a package.
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const fromDir = path.dirname(path.join(cwd, fromFile));
  const baseAbs = path.resolve(fromDir, spec);

  // Already has a supported extension?
  for (const ext of TS_JS_EXT) {
    if (baseAbs.endsWith(ext) && fileExists(baseAbs)) {
      return toRel(baseAbs, cwd);
    }
  }

  // Try appending each extension.
  for (const ext of TS_JS_EXT) {
    if (fileExists(baseAbs + ext)) return toRel(baseAbs + ext, cwd);
  }

  // Directory with index.* ?
  for (const ext of TS_JS_EXT) {
    const idx = path.join(baseAbs, 'index' + ext);
    if (fileExists(idx)) return toRel(idx, cwd);
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function toRel(abs: string, cwd: string): string {
  return path.relative(cwd, abs).replace(/\\/g, '/');
}

/**
 * Strip `//` and `/* ... *\/` comments from TS/JS so commented-out imports
 * don't count. Strings aren't parsed carefully — we accept rare false
 * positives in code inside quoted strings; they won't resolve anyway.
 */
function stripTsJsComments(src: string): string {
  // Block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments (don't eat #! shebangs mid-file — unlikely but cheap to keep)
  out = out.replace(/(^|[^:"'/])\/\/[^\n]*/g, '$1');
  return out;
}

/** Strip Python line comments (# ...). Leaves docstrings intact. */
function stripPyComments(src: string): string {
  return src.replace(/(^|[^\w"'])#[^\n]*/g, '$1');
}
