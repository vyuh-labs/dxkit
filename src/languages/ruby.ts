import * as fs from 'fs';
import * as path from 'path';

import { type Coverage, type FileCoverage, round1, toRelative } from '../analyzers/tools/coverage';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { gatherOsvScannerDepVulnsResult } from '../analyzers/tools/osv-scanner-deps';
import { fileExists, run } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  RunTestsOutcome,
} from './capabilities/provider';
import type {
  CorrectnessCommand,
  CorrectnessContext,
  CorrectnessProvider,
} from './capabilities/correctness';
import type {
  CoverageResult,
  ImportsResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
  TestFrameworkResult,
} from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';
import { readRepoFile, repoFileExists } from './version-detect';
import type { LintGateProvider } from './capabilities/lint-gate';

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Walk the project tree (bounded depth) looking for a `.rb` source file.
 * G9 discipline (Recipe v3): manifest-only detection (Gemfile alone)
 * over-activates on mixed-stack repos and scaffolded-but-empty projects.
 * The pack only matters when there is actual Ruby source to analyze.
 */
function detectRuby(cwd: string): boolean {
  // Depth-unlimited via the canonical walker. The previous depth-5
  // cap missed nested Ruby projects in monorepos and engines layouts.
  return walkPaths(cwd, { extensions: ['.rb'] }).length > 0;
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
  const files = walkSourceFiles(cwd, {
    extensions: ['.rb'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  for (const rel of files) {
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
  // Count test-file conventions via the cross-platform walker and pick
  // the framework whose convention dominates. `includeTests` is required
  // — these ARE test files.
  const rbFiles = walkSourceFiles(cwd, {
    extensions: ['.rb'],
    includeTests: true,
    includeAutogen: true,
  });
  let specs = 0;
  let tests = 0;
  for (const rel of rbFiles) {
    const base = path.basename(rel);
    if (/_spec\.rb$/.test(base)) specs++;
    else if (/_test\.rb$/.test(base) || /^test_.*\.rb$/.test(base)) tests++;
  }
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

// ─── Lint (rubocop --format json) ───────────────────────────────────────────

/**
 * Map RuboCop's severity strings to dxkit's four-tier scheme. RuboCop
 * canonically emits 5 severities (see `RuboCop::Cop::Severity::CODES`
 * in the upstream source — `lib/rubocop/cop/severity.rb`):
 *
 *   - `convention` → low      (style + naming — the bulk of findings)
 *   - `refactor`   → low      (complexity hints; Metrics/* cops)
 *   - `warning`    → medium   (Lint/* cops — actual code-quality risk)
 *   - `error`      → high     (real defects; rare in default config)
 *   - `fatal`      → critical (rubocop-internal failure or syntax error)
 *
 * Defensive `'low'` default for unknown severities — matches the
 * mapDetektSeverity / mapRuffSeverity contract: never silently drop a
 * finding, even if rubocop adds a new tier we don't recognize yet.
 *
 * Exported for unit tests.
 */
export function mapRubocopSeverity(severity: string | null | undefined): LintSeverity {
  if (typeof severity !== 'string') return 'low';
  switch (severity.toLowerCase()) {
    case 'fatal':
      return 'critical';
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'convention':
    case 'refactor':
      return 'low';
    default:
      return 'low';
  }
}

interface RubocopOffense {
  severity?: string;
  cop_name?: string;
  message?: string;
}

interface RubocopFile {
  path?: string;
  offenses?: RubocopOffense[];
}

interface RubocopOutput {
  files?: RubocopFile[];
  summary?: { offense_count?: number; target_file_count?: number };
}

/**
 * Pure parser for RuboCop's JSON output (rubocop --format json). The
 * shape is fixed per the upstream `RuboCop::Formatter::JSONFormatter`
 * contract — `metadata` + `files[*].offenses[*]` + `summary`. We only
 * need the offenses; metadata + summary are surface for future
 * enrichment (per-file attribution, top-N rules) but not needed for
 * the dxkit lint envelope which carries SeverityCounts only.
 *
 * Returns zero counts on malformed input rather than throwing —
 * matches mapDetektSeverity / parseEslintFinal conventions. The
 * gather function distinguishes "rubocop ran fine, found nothing"
 * from "rubocop missing / parse error" via LintGatherOutcome's
 * kind field.
 *
 * Exported for unit tests; consumed by `gatherRubyLintResult`.
 */
export function parseRubocopOutput(raw: string): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  let data: RubocopOutput;
  try {
    data = JSON.parse(raw) as RubocopOutput;
  } catch {
    return counts;
  }
  for (const file of data.files ?? []) {
    for (const offense of file.offenses ?? []) {
      counts[mapRubocopSeverity(offense.severity)]++;
    }
  }
  return counts;
}

/**
 * Single source of truth for the ruby pack's lint gathering. Consumed
 * by `rubyLintProvider` (capability dispatcher).
 *
 * RuboCop is invoked with `--format json` so we always get a
 * machine-readable payload (the default formatter is human-text).
 * Exit code: rubocop exits 1 when offenses are found, 0 when clean.
 * We tolerate any exit code (rubocop writes valid JSON to stdout
 * regardless) and rely on parseRubocopOutput's empty-on-malformed
 * contract.
 */
function gatherRubyLintResult(cwd: string): LintGatherOutcome {
  const rubocop = findTool(TOOL_DEFS.rubocop, cwd);
  if (!rubocop.available || !rubocop.path) {
    return { kind: 'unavailable', reason: 'not installed' };
  }
  const raw = run(`${rubocop.path} --format json .`, cwd, 120000);
  if (!raw) {
    return { kind: 'unavailable', reason: 'no rubocop output' };
  }
  const counts = parseRubocopOutput(raw);
  const envelope: LintResult = { schemaVersion: 1, tool: 'rubocop', counts };
  return { kind: 'success', envelope };
}

const rubyLintProvider: CapabilityProvider<LintResult> = {
  source: 'ruby',
  async gather(cwd) {
    const outcome = gatherRubyLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
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
 */
function findSimpleCovResultset(cwd: string): string | null {
  const candidates = ['coverage/.resultset.json', 'coverage/coverage.json'];
  for (const rel of candidates) {
    if (fileExists(cwd, rel)) return rel;
  }
  return null;
}

/**
 * Discriminated outcome of a SimpleCov coverage probe (Recipe v4 G_v4_3).
 *
 * Pre-G_v4_3, `gatherSimpleCovCoverageResult` returned `CoverageResult |
 * null` and the `null` branch silently merged two genuinely different
 * states: "SimpleCov never ran" and "SimpleCov ran but only produced
 * HTML output." The second is a legitimate user state (vanilla
 * SimpleCov ships HTML by default; JSON requires either the binary-
 * intermediate `.resultset.json` — produced by default but undocumented
 * as stable — or the third-party `simplecov-json` gem). Users in that
 * state need actionable guidance, not a silent "no coverage data."
 *
 * The capability dispatcher contract (`CoverageResult | null`) is
 * unchanged — the adapter still returns null for both unavailable and
 * html-only states so existing consumers keep working. Consumers that
 * want the richer signal (coverage CLI under D021, dashboard renderer)
 * call `gatherSimpleCovOutcome` directly.
 */
export type SimpleCovOutcome =
  | { kind: 'unavailable' }
  | { kind: 'html-only'; hint: string }
  | { kind: 'success'; envelope: CoverageResult };

/**
 * Probe SimpleCov state and produce the discriminated outcome. Three
 * paths, all distinguishable downstream:
 *   1. `success`     — parseable JSON found at `.resultset.json` or
 *                      `coverage.json`; envelope ready to ship.
 *   2. `html-only`   — `coverage/index.html` exists but no JSON;
 *                      SimpleCov ran, but in a format we can't parse.
 *                      Includes a hint string for the user.
 *   3. `unavailable` — neither JSON nor HTML; tool didn't run.
 */
export function gatherSimpleCovOutcome(cwd: string): SimpleCovOutcome {
  const reportRel = findSimpleCovResultset(cwd);
  if (reportRel) {
    try {
      const raw = fs.readFileSync(path.join(cwd, reportRel), 'utf-8');
      const coverage = parseSimpleCovResultset(raw, reportRel, cwd);
      if (coverage) {
        return {
          kind: 'success',
          envelope: { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage },
        };
      }
    } catch {
      // Fall through to the html-only / unavailable check — a corrupt
      // JSON shouldn't masquerade as "tool didn't run" when the user
      // clearly did run SimpleCov (HTML is the tell).
    }
  }
  if (fileExists(cwd, 'coverage/index.html')) {
    return {
      kind: 'html-only',
      hint:
        'SimpleCov produced HTML output only. ' +
        'Install the simplecov-json gem to emit `coverage/coverage.json`, ' +
        'or keep the default formatter (which produces the binary intermediate ' +
        '`coverage/.resultset.json` that dxkit also reads).',
    };
  }
  return { kind: 'unavailable' };
}

/**
 * Single source of truth for the ruby pack's coverage gathering.
 * Consumed by `rubyCoverageProvider` (capability dispatcher).
 *
 * Thin adapter over `gatherSimpleCovOutcome`: collapses the three-way
 * outcome to the dispatcher's binary `CoverageResult | null` contract.
 * Callers that need the html-only signal should use
 * `gatherSimpleCovOutcome` directly.
 */
function gatherSimpleCovCoverageResult(cwd: string): CoverageResult | null {
  const outcome = gatherSimpleCovOutcome(cwd);
  return outcome.kind === 'success' ? outcome.envelope : null;
}

/**
 * Check that SimpleCov is required + started in the project's
 * `spec_helper.rb` or `rails_helper.rb`. Without this, `bundle exec
 * rspec` runs cleanly but writes no `.resultset.json` — the user
 * spends 30+ seconds running tests then sees "tests ran but no
 * coverage artifact was produced." Better to short-circuit upfront
 * with the actionable hint.
 *
 * Looks for the canonical setup form: `require 'simplecov'` followed
 * eventually by `SimpleCov.start`. Tolerates double quotes and any
 * whitespace. spec_helper / rails_helper are the conventional
 * locations; we check both because Rails projects use the latter.
 */
function simplecovIsRequired(cwd: string): boolean {
  const candidates = ['spec/spec_helper.rb', 'spec/rails_helper.rb', 'test/test_helper.rb'];
  for (const c of candidates) {
    const abs = path.join(cwd, c);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const hasRequire = /\brequire\s+['"]simplecov['"]/.test(raw);
    const hasStart = /\bSimpleCov\.start\b/.test(raw);
    if (hasRequire && hasStart) return true;
  }
  return false;
}

/**
 * Run `bundle exec rspec` from cwd (D021).
 *
 * SimpleCov is the canonical Ruby coverage tool. It's required from
 * `spec_helper.rb` (not invoked separately) and writes its resultset
 * during the rspec run itself — `bundle exec rspec` is therefore the
 * coverage command, no extra flags needed.
 *
 * Preflight (in order, cheapest first):
 *   1. `Gemfile` must exist — without one, bundler can't resolve the
 *      gem set and rspec won't be invokable.
 *   2. `simplecov` gem must be installed (registry-tracked via
 *      `TOOL_DEFS.simplecov`, library-only gem detected via
 *      `gemPackage`).
 *   3. `simplecov` must be `require`d AND `SimpleCov.start` called in
 *      `spec_helper.rb` / `rails_helper.rb` / `test_helper.rb`. SimpleCov
 *      is opt-in per-project; merely installing the gem doesn't
 *      instrument the test run. This check matches the G_v4_3
 *      gatherSimpleCovOutcome shape (html-only outcome surfaces
 *      separately on the read side).
 *
 * If all three pass, rspec is invoked via bundler so it resolves to
 * the project's pinned version + plugins. Artifact is the canonical
 * `coverage/.resultset.json` that `gatherSimpleCovOutcome` reads.
 */
function runRubyTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'ruby',
      cmd: 'bundle exec rspec',
      cwd,
      artifact: 'coverage/.resultset.json',
      preflight: (cwd) => {
        if (!fileExists(cwd, 'Gemfile')) {
          return 'no Gemfile in this directory — not a Ruby/bundler project';
        }
        if (!findTool(TOOL_DEFS.simplecov, cwd).available) {
          return 'simplecov gem not installed — run `vyuh-dxkit tools install`';
        }
        if (!simplecovIsRequired(cwd)) {
          return "simplecov not required/started in spec_helper.rb — add `require 'simplecov'` + `SimpleCov.start` at the top";
        }
        return null;
      },
    }),
  );
}

const rubyCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'ruby',
  async gather(cwd) {
    return gatherSimpleCovCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runRubyTestsWithCoverage(cwd);
  },
};

// ─── DepVulns (osv-scanner against Gemfile.lock) ────────────────────────────
//
// Parser + manifest discovery + tool invocation + CVSS resolution all
// live in `src/analyzers/tools/osv-scanner-deps.ts` — language-agnostic
// SSOT (CLAUDE.md rule #2). Same module powers kotlin/java's Maven
// scanning. ParseOsvScannerFindings is exported there for unit tests
// and is exercised by both Maven and RubyGems fixtures.
//
// bundler-audit alternative: deliberately NOT used. Its JSON output
// is unstable upstream (line-oriented text is the canonical format),
// and osv-scanner gives us SSOT consistency across Maven/RubyGems/PyPI
// + stable JSON + CVSS resolution + the same enrichment surface. If a
// future customer needs bundler-audit specifically (e.g. air-gapped
// env where osv.dev queries are unavailable), it can be added as a
// secondary tool without disturbing this primary path.

const RUBY_DEP_MANIFESTS = ['Gemfile.lock'];

const rubyDepVulnsProvider: DepVulnsProvider = {
  source: 'ruby',
  // osv-scanner audits Gemfile.lock; Gemfile / *.gemspec carry the dependency
  // declarations, so include them for the incremental skip check.
  manifestPatterns: [...RUBY_DEP_MANIFESTS, 'Gemfile', '*.gemspec'],
  async gather(cwd) {
    const outcome = await gatherOsvScannerDepVulnsResult(
      cwd,
      'ruby',
      'RubyGems',
      RUBY_DEP_MANIFESTS,
    );
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherOsvScannerDepVulnsResult(cwd, 'ruby', 'RubyGems', RUBY_DEP_MANIFESTS);
  },
};

// ─── Pack export ────────────────────────────────────────────────────────────

/** A changed Ruby file that is a spec/test (`*_spec.rb`, `*_test.rb`,
 *  `test_*.rb`) — the pack's file-level affected-selection unit. */
function isRubyTestFile(rel: string): boolean {
  const base = path.basename(rel);
  return /_spec\.rb$/.test(base) || /_test\.rb$/.test(base) || /^test_.*\.rb$/.test(base);
}

/**
 * The Ruby correctness floor.
 *
 * syntaxCheck: parse every changed `.rb`. `ruby -c` checks one file, so a tiny
 * `-e` wrapper compiles each via `RubyVM::InstructionSequence.compile`, which
 * raises `SyntaxError` (non-zero exit + the `file:line` message) on a parse
 * error and is silent on success — the universal Ruby "does it parse" check,
 * needing only an interpreter. Runs on the changed files; the full-scope
 * backstop is the test run, which loads the code.
 *
 * affectedTests: FILE-LEVEL selection (Ruby has no native impact analysis; the
 * honest rung, like Python's). RSpec runs the changed `*_spec.rb` (whole suite
 * at full scope); minitest / test-unit loads the changed `*_test.rb` (bundled
 * minitest's `at_exit` runs them), globbing `test/**` at full scope. A change
 * touching no test file on the fast surface skips (the syntax check still runs;
 * CI's full scope is the backstop).
 */
const rubyCorrectnessProvider: CorrectnessProvider = {
  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
    const changedRb = ctx.changedFiles.filter((f) => f.endsWith('.rb'));
    if (changedRb.length === 0) return null;
    return {
      label: 'syntax',
      bin: 'ruby',
      args: [
        '-e',
        'ARGV.each { |f| RubyVM::InstructionSequence.compile(File.read(f), f) }',
        ...changedRb,
      ],
    };
  },

  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
    const fw = gatherRubyTestFrameworkResult(ctx.cwd);
    if (fw === null) return null; // no test framework detected
    const undeterminable = ctx.changedFiles.length === 0;
    const changedTests = ctx.changedFiles.filter((f) => f.endsWith('.rb') && isRubyTestFile(f));
    const affected = ctx.scope === 'affected' && !undeterminable;
    if (affected && changedTests.length === 0) return null; // no changed test file

    if (fw.name === 'rspec') {
      // `rspec <specs>` on the fast surface; bare `rspec` runs the whole suite.
      return {
        label: 'affected-tests',
        bin: 'rspec',
        args: affected ? [...changedTests] : [],
      };
    }
    // minitest / test-unit: `load` each test file so bundled minitest's at_exit
    // runs it. `-Itest -Ilib` puts the conventional dirs on the load path.
    const loadArgs = affected
      ? ['-e', 'ARGV.each { |f| load f }', ...changedTests]
      : ['-e', 'Dir.glob("test/**/*_test.rb").each { |f| load f }'];
    return { label: 'affected-tests', bin: 'ruby', args: ['-Itest', '-Ilib', ...loadArgs] };
  },
};

/**
 * Lint-GATE provider: rubocop, for the net-new lint gate. Resolved via the tool
 * registry (Rule 1); null when it isn't installed. `--format emacs` emits
 * `file:line:col: severity: Cop: message` per offense, mapped to located
 * findings; rubocop exits non-zero when it reports offenses (expectedExit 0 =
 * clean).
 */
/** rubocop `--format emacs` line: `<file>:<line>:<col>: <sev>: <Cop>: <message>`.
 *  Exported so the lint-gate format contract is testable against a real sample. */
export const RUBY_RUBOCOP_EMACS_PARSE =
  '^(?<file>.+?):(?<line>\\d+):\\d+:\\s+\\w:\\s+(?<rule>[\\w/]+):\\s+(?<message>.*)$';

const rubyLintGateProvider: LintGateProvider = {
  lintCommand(ctx) {
    const rubocop = findTool(TOOL_DEFS.rubocop, ctx.cwd);
    if (!rubocop.available || !rubocop.path) return null;
    return {
      bin: rubocop.path,
      args: ['--format', 'emacs'],
      parse: RUBY_RUBOCOP_EMACS_PARSE,
      expectedExit: 0,
    };
  },
};

/**
 * The Ruby version this repo targets — `.ruby-version` or a Gemfile
 * `ruby "X.Y.Z"` directive. Feeds setup-ruby's `ruby-version` + the
 * devcontainer.
 */
function detectRubyVersion(cwd: string): string | undefined {
  if (repoFileExists(cwd, '.ruby-version')) {
    const m = readRepoFile(cwd, '.ruby-version')
      .trim()
      .match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) return m[1];
  }
  const gemfile = readRepoFile(cwd, 'Gemfile');
  const m = gemfile.match(/^\s*ruby\s+["']([~>=< ]*)?(\d+\.\d+(?:\.\d+)?)/m);
  return m ? m[2] : undefined;
}

export const ruby: LanguageSupport = {
  id: 'ruby',
  displayName: 'Ruby',
  commentSyntax: { lineComment: '#', blockCommentStart: '=begin', blockCommentEnd: '=end' },

  sourceExtensions: ['.rb'],

  testFilePatterns: [
    '*_spec.rb',
    '*_test.rb',
    'test_*.rb',
    'spec/**/*_spec.rb',
    'test/**/*_test.rb',
  ],

  extraExcludes: ['vendor/bundle', '.bundle', 'coverage', 'tmp', 'log'],

  exportDetection: {
    reliability: 'unreliable',
    strategy:
      'Static detection unreliable — Ruby metaprogramming (`define_method`, `method_missing`, monkey-patching) defeats AST analysis',
  },

  // D027 (2.4.7): YARD documentation convention uses `##` block
  // comments (distinguished from regular `#` line comments). Plain
  // `#` would over-match every commented-out line; `##` is the
  // documented-block marker.
  docCommentPatterns: ['^[[:space:]]*##'],

  // D034 (2.4.7): OpenSSL TLS-bypass idioms for Ruby's stdlib
  // `net/http` and `httpclient` gems. `VERIFY_NONE` is the constant
  // ruby code sets on `http.verify_mode` to disable cert checks.
  tlsBypassPatterns: [
    'OpenSSL::SSL::VERIFY_NONE',
    'verify_mode[[:space:]]*=[[:space:]]*.*VERIFY_NONE',
  ],

  upgradeCommand(name, version) {
    return `# Edit Gemfile: \`gem '${name}', '${version}'\`, then \`bundle install\``;
  },

  // Rails (`app/controllers/`, `app/services/`, `app/models/`,
  // `app/views/`) is the dominant Ruby application shape. Sinatra
  // and Hanami sometimes diverge but typically also adopt the Rails
  // app/<role> convention. Paths are anchored at `/app/<role>/` to
  // avoid matching a top-level `models/` directory in a non-Rails
  // gem.
  architecturalShape: {
    primaryComponentPaths: [
      '/app/controllers/',
      '/app/services/',
      '/app/jobs/',
      '/app/helpers/',
      '/app/views/',
      '/app/channels/',
      '/app/workers/',
    ],
    routePaths: ['/app/controllers/', '/app/channels/'],
    modelPaths: ['/app/models/', '/app/serializers/'],
    vocabulary: {
      components: 'controllers/services',
      models: 'models',
      routes: 'routes',
    },
    testGapPriority: {
      high: ['/app/controllers/', '/app/services/', '/app/jobs/', '/app/workers/'],
      medium: ['/app/helpers/', '/app/views/', '/app/channels/', '/app/serializers/'],
    },
  },

  clocLanguageNames: ['Ruby'],

  detect: detectRuby,

  tools: ['osv-scanner', 'rubocop', 'simplecov'],

  semgrepRulesets: ['p/ruby'],
  // CodeQL `ruby` extractor (no build); Snyk Code supports Ruby.
  deepSast: { codeqlLanguage: 'ruby', snykCode: true },

  correctness: rubyCorrectnessProvider,
  lintGate: rubyLintGateProvider,

  capabilities: {
    imports: rubyImportsProvider,
    testFramework: rubyTestFrameworkProvider,
    coverage: rubyCoverageProvider,
    lint: rubyLintProvider,
    depVulns: rubyDepVulnsProvider,
  },

  mapLintSeverity: mapRubocopSeverity,

  permissions: [
    'Bash(bundle:*)',
    'Bash(rake:*)',
    'Bash(rspec:*)',
    'Bash(rubocop:*)',
    'Bash(ruby:*)',
  ],

  ruleFile: 'ruby.md',

  cliBinaries: ['ruby', 'bundle'],

  ciSetup: {
    steps: [
      {
        name: 'Set up Ruby',
        uses: 'ruby/setup-ruby@v1',
        with: { 'ruby-version': '3.3.0' },
        versionInput: 'ruby-version',
      },
    ],
  },
  defaultVersion: '3.3.0',
  detectVersion: detectRubyVersion,
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/ruby:1',
    opts: { version: '3.3' },
  },
  devcontainerExtensions: ['rebornix.ruby'],
};
