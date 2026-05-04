import * as fs from 'fs';
import * as path from 'path';

import { type Coverage, type FileCoverage, round1, toRelative } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { fileExists, run } from '../analyzers/tools/runner';
import type { CapabilityProvider } from './capabilities/provider';
import type { CoverageResult, ImportsResult, TestFrameworkResult } from './capabilities/types';
import type { LanguageSupport } from './types';

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Walk the project tree (bounded depth) looking for a `.rb` source file.
 * G9 discipline (Recipe v3): manifest-only detection (Gemfile alone)
 * over-activates on mixed-stack repos and scaffolded-but-empty projects.
 * The pack only matters when there is actual Ruby source to analyze.
 */
function hasRubySourceWithinDepth(cwd: string, maxDepth = 5): boolean {
  function search(dir: string, depth: number): boolean {
    if (depth > maxDepth) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || ['node_modules', 'vendor', 'tmp', 'log'].includes(e.name)) {
        continue;
      }
      if (e.isFile() && e.name.endsWith('.rb')) return true;
      if (e.isDirectory() && search(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }
  return search(cwd, 0);
}

function detectRuby(cwd: string): boolean {
  return hasRubySourceWithinDepth(cwd, 5);
}

// ─── Imports (regex extraction, no resolver) ────────────────────────────────

/**
 * Capture Ruby require / require_relative / autoload specifiers from source
 * text. Three forms recognised:
 *
 *   require 'json'                  → 'json'
 *   require_relative '../foo/bar'   → '../foo/bar'
 *   autoload :Sym, 'foo/bar'        → 'foo/bar'
 *
 * Ruby's metaprogramming (`__send__`, `Object.const_missing`, Rails'
 * Zeitwerk autoloader) makes static import analysis fundamentally
 * best-effort — many "imports" in idiomatic Ruby never appear as
 * literal `require` calls. This parser extracts the literal-string
 * cases only; downstream consumers should treat the output as a lower
 * bound. Future v4 candidate: explicit best-effort contract on the
 * imports envelope so consumers can distinguish "exhaustive" (TS, Go)
 * from "best-effort" (Ruby, kotlin/Java reflection paths).
 *
 * Comments are stripped (single-line `#`) before matching so a
 * commented-out `# require 'foo'` does not false-match. Multi-line
 * `=begin ... =end` blocks containing requires are not extracted
 * (acceptable: comment-out-import is intentional non-use).
 *
 * Both single and double quotes are accepted; dynamic `require x` (no
 * literal string) is skipped — there is no specifier to capture.
 *
 * Exported for unit tests; consumed by `gatherRubyImportsResult`.
 */
export function extractRubyImportsRaw(content: string): string[] {
  const out: string[] = [];
  // Strip line comments first so `# require 'foo'` doesn't false-match.
  // Conservative: only `#` at start-of-line or after whitespace, to avoid
  // mangling `#{interpolation}` inside double-quoted strings.
  const stripped = content.replace(/(^|\s)#[^\n]*/g, '$1');

  const requireRe = /^\s*(?:require|require_relative)\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = requireRe.exec(stripped)) !== null) {
    out.push(m[1]);
  }

  // autoload :Sym, 'path' — capture the path arg only (the symbol is the
  // local binding name, not the import target).
  const autoloadRe = /^\s*autoload\s+:[A-Za-z_]\w*\s*,\s*['"]([^'"]+)['"]/gm;
  while ((m = autoloadRe.exec(stripped)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Enumerate `.rb` files under cwd and capture per-file imports. Ruby has
 * no file-level resolver — `require 'foo'` searches `$LOAD_PATH` (a
 * runtime-mutable array), Rails projects defer wholly to Zeitwerk's
 * convention-based autoload, and `require_relative` paths sometimes
 * lack the `.rb` extension. Mirrors rust/kotlin/csharp/java packs:
 * `extracted` is populated for completeness, `edges` is always empty,
 * file-level resolution is left to graphify if downstream consumers
 * need it.
 */
function gatherRubyImportsResult(cwd: string): ImportsResult | null {
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f -name "*.rb" ${excludes} 2>/dev/null`, cwd);
  if (!raw) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    const rel = p.replace(/^\.\//, '');
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    extracted.set(rel, extractRubyImportsRaw(content));
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'ruby-imports',
    sourceExtensions: ['.rb'],
    extracted,
    edges: new Map(),
  };
}

const rubyImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'ruby',
  async gather(cwd) {
    return gatherRubyImportsResult(cwd);
  },
};

// ─── Test framework (Gemfile / Gemfile.lock text scan) ──────────────────────

/**
 * Detect the Ruby test framework by scanning Gemfile + Gemfile.lock for
 * known gem names. Order of precedence: rspec → minitest → test-unit.
 *
 *   - RSpec ('rspec', 'rspec-rails') — by far the most common Ruby
 *     test runner, takes precedence when present.
 *   - Minitest — Ruby stdlib's runner, often used directly or via
 *     Rails' default `test/` directory.
 *   - test-unit — Ruby 1.8-era runner; still used by some legacy
 *     projects and by Ruby itself's stdlib tests.
 *
 * Falls back to test-file glob counts when no Gemfile is present (a
 * vendored library directory or scratch script repo). The glob counts
 * mirror the test patterns declared on the pack: `*_spec.rb` → rspec,
 * `*_test.rb` / `test_*.rb` → minitest.
 *
 * Returns null when nothing identifies a framework — analyzers should
 * treat null as "test-runner unknown" rather than "no tests."
 */
function gatherRubyTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  const manifests = ['Gemfile', 'Gemfile.lock'];
  let combined = '';
  for (const rel of manifests) {
    if (!fileExists(cwd, rel)) continue;
    try {
      combined += fs.readFileSync(path.join(cwd, rel), 'utf-8') + '\n';
    } catch {
      /* ignore unreadable */
    }
  }

  if (combined) {
    if (/\brspec(?:-rails)?\b/.test(combined)) {
      return { schemaVersion: 1, tool: 'ruby', name: 'rspec' };
    }
    if (/\bminitest\b/.test(combined)) {
      return { schemaVersion: 1, tool: 'ruby', name: 'minitest' };
    }
    if (/\btest-unit\b/.test(combined)) {
      return { schemaVersion: 1, tool: 'ruby', name: 'test-unit' };
    }
  }

  // Glob-count fallback: no Gemfile (or Gemfile mentions no known runner).
  // Run two cheap finds and pick the framework whose convention dominates.
  const excludes = getFindExcludeFlags(cwd);
  const specCount = run(`find . -type f -name "*_spec.rb" ${excludes} 2>/dev/null | wc -l`, cwd);
  const testCount = run(
    `find . -type f \\( -name "*_test.rb" -o -name "test_*.rb" \\) ${excludes} 2>/dev/null | wc -l`,
    cwd,
  );
  const specs = parseInt(specCount, 10) || 0;
  const tests = parseInt(testCount, 10) || 0;
  if (specs === 0 && tests === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'ruby',
    name: specs >= tests ? 'rspec' : 'minitest',
  };
}

const rubyTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'ruby',
  async gather(cwd) {
    return gatherRubyTestFrameworkResult(cwd);
  },
};

// ─── Coverage (SimpleCov resultset.json) ────────────────────────────────────

/**
 * SimpleCov's `.resultset.json` shape (binary intermediate, JSON-shaped):
 *
 *   {
 *     "RSpec": {                              // suite name (RSpec / Minitest / Test::Unit)
 *       "coverage": {
 *         "/abs/path/to/file.rb": {
 *           "lines": [int|null, ...]          // one entry per source line
 *         }
 *       },
 *       "timestamp": 1777904063
 *     },
 *     // multiple suites possible when a project mixes RSpec + Minitest:
 *     "Minitest": { ... }
 *   }
 *
 * Line entries:
 *   - positive int → line was hit (covered)
 *   - 0            → line was not hit (uncovered, but executable)
 *   - null         → line is not executable (blank, comment, `end`, etc.)
 *
 * Multi-suite handling: the same file can appear under multiple suites
 * if a project runs both runners. We union by taking max coverage per
 * line index — a line covered by RSpec is covered, period, even if
 * Minitest didn't reach it. Mirrors SimpleCov's own resultset merge
 * semantics from `simplecov/lib/simplecov/result_merger.rb`.
 */
interface SimpleCovResultset {
  [suite: string]: {
    coverage?: Record<string, { lines?: Array<number | null> }>;
    timestamp?: number;
  };
}

/**
 * Pure parser for SimpleCov `.resultset.json`. Returns null when the
 * input has no parseable suites (empty file, missing `coverage` key,
 * or malformed JSON) — distinct from "0% coverage" (where suites
 * exist with zero hits).
 *
 * Exported for unit tests; consumed by `gatherSimpleCovCoverageResult`.
 */
export function parseSimpleCovResultset(
  raw: string,
  sourceFile: string,
  cwd: string,
): Coverage | null {
  let data: SimpleCovResultset;
  try {
    data = JSON.parse(raw) as SimpleCovResultset;
  } catch {
    return null;
  }

  // Per-file line arrays unioned across suites (max per index).
  const merged = new Map<string, Array<number | null>>();
  for (const suite of Object.values(data)) {
    const cov = suite?.coverage;
    if (!cov || typeof cov !== 'object') continue;
    for (const [absPath, entry] of Object.entries(cov)) {
      const lines = entry?.lines;
      if (!Array.isArray(lines)) continue;
      const existing = merged.get(absPath);
      if (!existing) {
        merged.set(absPath, lines.slice());
        continue;
      }
      // Union: per index, keep max(existing, new). null stays null only if
      // both are null; any int wins over null; max int wins between two ints.
      const len = Math.max(existing.length, lines.length);
      const out: Array<number | null> = new Array(len);
      for (let i = 0; i < len; i++) {
        const a = existing[i] ?? null;
        const b = lines[i] ?? null;
        if (a === null && b === null) out[i] = null;
        else if (a === null) out[i] = b;
        else if (b === null) out[i] = a;
        else out[i] = Math.max(a, b);
      }
      merged.set(absPath, out);
    }
  }

  if (merged.size === 0) return null;

  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalExecutable = 0;
  for (const [absPath, lines] of merged) {
    let covered = 0;
    let executable = 0;
    for (const v of lines) {
      if (v === null) continue;
      executable += 1;
      if (v > 0) covered += 1;
    }
    const rel = toRelative(absPath, cwd);
    files.set(rel, {
      path: rel,
      covered,
      total: executable,
      pct: round1(executable > 0 ? (covered / executable) * 100 : 0),
    });
    totalCovered += covered;
    totalExecutable += executable;
  }

  return {
    source: 'simplecov',
    sourceFile,
    linePercent: round1(totalExecutable > 0 ? (totalCovered / totalExecutable) * 100 : 0),
    files,
  };
}

/**
 * Probe SimpleCov's canonical artifact path. The default formatter
 * writes `coverage/.resultset.json`; the simplecov-json gem writes
 * `coverage/coverage.json` (less common). We probe the canonical
 * path first — it ships with vanilla SimpleCov and is the most
 * likely to exist.
 *
 * HTML-only fallback (no JSON, only `coverage/index.html`) is currently
 * not parseable — the analyzer reports "no coverage" in that state,
 * which is indistinguishable from "tool didn't run." Tracked as a
 * Recipe v4 candidate (extend the coverage outcome enum to distinguish
 * 'output-format-incompatible' from 'unavailable').
 */
function findSimpleCovResultset(cwd: string): string | null {
  const candidates = ['coverage/.resultset.json', 'coverage/coverage.json'];
  for (const rel of candidates) {
    if (fileExists(cwd, rel)) return rel;
  }
  return null;
}

/**
 * Single source of truth for the ruby pack's coverage gathering.
 * Consumed by `rubyCoverageProvider` (capability dispatcher).
 */
function gatherSimpleCovCoverageResult(cwd: string): CoverageResult | null {
  const reportRel = findSimpleCovResultset(cwd);
  if (!reportRel) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, reportRel), 'utf-8');
  } catch {
    return null;
  }
  const coverage = parseSimpleCovResultset(raw, reportRel, cwd);
  if (!coverage) return null;
  return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
}

const rubyCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'ruby',
  async gather(cwd) {
    return gatherSimpleCovCoverageResult(cwd);
  },
};

// ─── Pack export ────────────────────────────────────────────────────────────

export const ruby: LanguageSupport = {
  id: 'ruby',
  displayName: 'Ruby',

  sourceExtensions: ['.rb'],

  testFilePatterns: [
    '*_spec.rb',
    '*_test.rb',
    'test_*.rb',
    'spec/**/*_spec.rb',
    'test/**/*_test.rb',
  ],

  extraExcludes: ['vendor/bundle', '.bundle', 'coverage', 'tmp', 'log'],

  detect: detectRuby,

  tools: ['simplecov'],

  semgrepRulesets: ['p/ruby'],

  capabilities: {
    imports: rubyImportsProvider,
    testFramework: rubyTestFrameworkProvider,
    coverage: rubyCoverageProvider,
  },

  permissions: [
    'Bash(bundle:*)',
    'Bash(rake:*)',
    'Bash(rspec:*)',
    'Bash(rubocop:*)',
    'Bash(ruby:*)',
  ],

  ruleFile: 'ruby.md',

  templateFiles: [],

  cliBinaries: ['ruby', 'bundle'],

  defaultVersion: '3.3.0',

  projectYamlBlock: ({ config, enabled }) =>
    [
      `  ruby:`,
      `    enabled: ${enabled}`,
      `    version: "${config.versions['ruby' as keyof typeof config.versions] ?? '3.3.0'}"`,
    ].join('\n'),
};
