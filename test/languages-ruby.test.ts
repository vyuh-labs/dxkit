/**
 * Ruby pack — pack-specific tests.
 *
 * Two test conventions per the recipe v3 → v4 split (`G_v4_1`):
 *
 *   - Source-text parsers (`extractRubyImportsRaw`, Gemfile-text scan
 *     in `gatherRubyTestFrameworkResult`) → synthetic inline strings.
 *     Language syntax is spec-stable; the value of real fixtures is
 *     catching schema drift, which doesn't apply here.
 *   - Tool-output parsers (`parseSimpleCovResultset`, plus 10k.2.5-6's
 *     RuboCop / bundler-audit) → REAL fixture files under
 *     `test/fixtures/raw/ruby/`. The C# defect lesson (5 months
 *     silent, parsers passed unit tests on synthetic JSON but
 *     returned 0 findings on real input — fixed in Phase 10h.6.8) is
 *     the reason. Capture commands live in
 *     `test/fixtures/raw/ruby/HARVEST.md`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ruby,
  extractRubyImportsRaw,
  gatherSimpleCovOutcome,
  mapRubocopSeverity,
  parseRubocopOutput,
  parseSimpleCovResultset,
} from '../src/languages/ruby';
import { parseOsvScannerFindings } from '../src/analyzers/tools/osv-scanner-deps';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'ruby');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('ruby pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(ruby.id).toBe('ruby');
    expect(ruby.displayName).toBe('Ruby');
  });

  it('declares all five capability providers (Phase 10k.2 complete)', () => {
    expect(ruby.capabilities?.imports).toBeDefined();
    expect(ruby.capabilities?.testFramework).toBeDefined();
    expect(ruby.capabilities?.coverage).toBeDefined();
    expect(ruby.capabilities?.lint).toBeDefined();
    expect(ruby.capabilities?.depVulns).toBeDefined();
    // licenses deliberately omitted — no canonical pure-CLI license tool
    // for RubyGems analogous to pip-licenses (license_finder gem exists
    // but requires bundle install + a venv-style setup that's out of
    // scope for the depVulns commit).
    expect(ruby.capabilities?.licenses).toBeUndefined();
  });

  it('declares osv-scanner + rubocop + simplecov as required tools (10k.2.4-6)', () => {
    expect(ruby.tools).toContain('osv-scanner');
    expect(ruby.tools).toContain('rubocop');
    expect(ruby.tools).toContain('simplecov');
  });
});

describe('extractRubyImportsRaw', () => {
  it('extracts a single-quoted require', () => {
    expect(extractRubyImportsRaw("require 'json'")).toEqual(['json']);
  });

  it('extracts a double-quoted require', () => {
    expect(extractRubyImportsRaw('require "json"')).toEqual(['json']);
  });

  it('extracts require_relative with a relative path', () => {
    expect(extractRubyImportsRaw("require_relative '../lib/foo'")).toEqual(['../lib/foo']);
  });

  it('extracts autoload paths (drops the symbol)', () => {
    expect(extractRubyImportsRaw("autoload :Bar, 'foo/bar'")).toEqual(['foo/bar']);
  });

  it('extracts multiple imports of mixed shapes', () => {
    const src = `
      require 'json'
      require_relative '../lib/foo'
      autoload :Bar, 'foo/bar'
    `;
    expect(extractRubyImportsRaw(src)).toEqual(['json', '../lib/foo', 'foo/bar']);
  });

  it('skips line-commented requires', () => {
    const src = `
      # require 'commented_out'
      require 'real_one'
    `;
    expect(extractRubyImportsRaw(src)).toEqual(['real_one']);
  });

  it('skips trailing-comment requires', () => {
    // A trailing `#` comment after a real require should not strip the
    // require itself — only the comment portion.
    const src = `require 'real_one' # plus a comment`;
    expect(extractRubyImportsRaw(src)).toEqual(['real_one']);
  });

  it('does not match dynamic require with no literal string', () => {
    expect(extractRubyImportsRaw('require some_var')).toEqual([]);
  });

  it('returns empty for files with no requires', () => {
    expect(extractRubyImportsRaw('class Foo\n  def bar; end\nend')).toEqual([]);
  });
});

describe('gatherRubyTestFrameworkResult — Gemfile text scan', () => {
  async function withTempDir(
    setup: (dir: string) => void,
    body: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-test-'));
    try {
      setup(dir);
      await body(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('detects rspec when Gemfile names the gem', async () => {
    await withTempDir(
      (d) => fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'rspec', '~> 3.12'\n"),
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result).not.toBeNull();
        expect(result!.name).toBe('rspec');
        expect(result!.tool).toBe('ruby');
      },
    );
  });

  it('detects rspec-rails as rspec', async () => {
    await withTempDir(
      (d) => fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'rspec-rails', '~> 6.0'\n"),
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result?.name).toBe('rspec');
      },
    );
  });

  it('detects minitest when only minitest is present', async () => {
    await withTempDir(
      (d) => fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'minitest', '~> 5.0'\n"),
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result?.name).toBe('minitest');
      },
    );
  });

  it('prefers rspec over minitest when both are declared', async () => {
    await withTempDir(
      (d) => fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'rspec'\ngem 'minitest'\n"),
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result?.name).toBe('rspec');
      },
    );
  });

  it('detects test-unit when neither rspec nor minitest is present', async () => {
    await withTempDir(
      (d) => fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'test-unit', '~> 3.6'\n"),
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result?.name).toBe('test-unit');
      },
    );
  });

  it('falls back to spec-glob count when no Gemfile is present', async () => {
    await withTempDir(
      (d) => {
        fs.writeFileSync(path.join(d, 'foo_spec.rb'), '');
        fs.writeFileSync(path.join(d, 'bar_spec.rb'), '');
      },
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result?.name).toBe('rspec');
      },
    );
  });

  it('falls back to test-glob count when no Gemfile is present', async () => {
    await withTempDir(
      (d) => {
        fs.writeFileSync(path.join(d, 'foo_test.rb'), '');
        fs.writeFileSync(path.join(d, 'test_bar.rb'), '');
      },
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result?.name).toBe('minitest');
      },
    );
  });

  it('returns null when nothing identifies a framework', async () => {
    await withTempDir(
      (d) => fs.writeFileSync(path.join(d, 'app.rb'), 'puts "hi"\n'),
      async (d) => {
        const result = await ruby.capabilities!.testFramework!.gather(d);
        expect(result).toBeNull();
      },
    );
  });
});

describe('gatherRubyImportsResult — file enumeration', () => {
  it('captures per-file imports across .rb files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-imp-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.rb'), "require 'json'\nrequire_relative 'b'\n");
      fs.writeFileSync(path.join(dir, 'b.rb'), "autoload :C, 'c'\n");
      fs.writeFileSync(path.join(dir, 'c.rb'), '# no imports\n');
      const result = await ruby.capabilities!.imports!.gather(dir);
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('ruby-imports');
      expect(result!.sourceExtensions).toEqual(['.rb']);
      expect(result!.extracted.size).toBe(3);
      expect(result!.extracted.get('a.rb')).toEqual(['json', 'b']);
      expect(result!.extracted.get('b.rb')).toEqual(['c']);
      expect(result!.extracted.get('c.rb')).toEqual([]);
      // No file-level resolver — edges always empty (mirrors rust/kotlin/csharp/java).
      expect(result!.edges.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when there are no .rb files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-imp-empty-'));
    try {
      const result = await ruby.capabilities!.imports!.gather(dir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseSimpleCovResultset', () => {
  // Real fixture provenance: SimpleCov v0.22.0 output captured 2026-05-04
  // from a synthetic 4-method Calculator with 2 tested + 2 untested
  // methods. Path normalized to `<HARVEST_ROOT>/lib/calculator.rb`. See
  // test/fixtures/raw/ruby/HARVEST.md for capture commands.
  //
  // Empirical assertion: rspec self-reported "Line Coverage: 70.0%
  // (7 / 10)" — the parser MUST agree.

  it('computes overall line coverage from the real fixture (matches rspec self-report)', () => {
    const raw = readFixture('coverage-output.json');
    const result = parseSimpleCovResultset(raw, 'coverage/.resultset.json', '<HARVEST_ROOT>');
    expect(result).not.toBeNull();
    expect(result!.linePercent).toBe(70.0);
    expect(result!.source).toBe('simplecov');
  });

  it('emits one per-file entry with covered/total/pct against the real fixture', () => {
    const raw = readFixture('coverage-output.json');
    const result = parseSimpleCovResultset(raw, 'coverage/.resultset.json', '<HARVEST_ROOT>');
    expect(result!.files.size).toBe(1);
    const file = result!.files.get('lib/calculator.rb');
    expect(file).toBeDefined();
    expect(file!.covered).toBe(7);
    expect(file!.total).toBe(10);
    expect(file!.pct).toBe(70.0);
  });

  it('relativizes absolute paths against cwd', () => {
    // Synthesize a payload with a host-style absolute path; verify the
    // parser returns a project-relative key.
    const synthetic = JSON.stringify({
      RSpec: {
        coverage: {
          '/repo/lib/foo.rb': { lines: [1, null, 0] },
        },
      },
    });
    const result = parseSimpleCovResultset(synthetic, 'coverage/.resultset.json', '/repo');
    expect(result).not.toBeNull();
    expect([...result!.files.keys()]).toEqual(['lib/foo.rb']);
  });

  it('treats null as non-executable (excluded from total), 0 as uncovered, >0 as covered', () => {
    const synthetic = JSON.stringify({
      RSpec: {
        coverage: {
          '/repo/a.rb': { lines: [5, 0, null, 1, null, 0, 2] },
        },
      },
    });
    const result = parseSimpleCovResultset(synthetic, 'r.json', '/repo');
    const file = result!.files.get('a.rb')!;
    // Executable entries: 5, 0, 1, 0, 2 → 5 lines. Covered (>0): 5, 1, 2 → 3.
    expect(file.total).toBe(5);
    expect(file.covered).toBe(3);
    expect(file.pct).toBe(60.0);
  });

  it('unions per-file lines across multiple suites (max per index)', () => {
    // RSpec covers line 0 with hit-count 1; Minitest covers lines 1,2.
    // After union, the file should report 3 of 3 covered (100%).
    const multi = JSON.stringify({
      RSpec: {
        coverage: {
          '/repo/multi.rb': { lines: [1, 0, 0] },
        },
      },
      Minitest: {
        coverage: {
          '/repo/multi.rb': { lines: [0, 1, 1] },
        },
      },
    });
    const result = parseSimpleCovResultset(multi, 'r.json', '/repo');
    const file = result!.files.get('multi.rb')!;
    expect(file.covered).toBe(3);
    expect(file.total).toBe(3);
    expect(file.pct).toBe(100.0);
  });

  it('returns null on malformed JSON', () => {
    expect(parseSimpleCovResultset('not-json', 'r.json', '/repo')).toBeNull();
  });

  it('returns null on empty resultset (no suites)', () => {
    expect(parseSimpleCovResultset('{}', 'r.json', '/repo')).toBeNull();
  });

  it('returns null when suites have no coverage entries', () => {
    const empty = JSON.stringify({ RSpec: { timestamp: 1 } });
    expect(parseSimpleCovResultset(empty, 'r.json', '/repo')).toBeNull();
  });
});

describe('gatherSimpleCovCoverageResult — file probe', () => {
  it('reads coverage/.resultset.json when present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      // Use the real fixture bytes so this exercises the same parser path
      // as the real artifact in production.
      const raw = readFixture('coverage-output.json').replace(/<HARVEST_ROOT>/g, dir);
      fs.writeFileSync(path.join(dir, 'coverage', '.resultset.json'), raw);
      const result = await ruby.capabilities!.coverage!.gather(dir);
      expect(result).not.toBeNull();
      expect(result!.coverage.source).toBe('simplecov');
      expect(result!.coverage.linePercent).toBe(70.0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to coverage/coverage.json (simplecov-json formatter output)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-fmt-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      const raw = readFixture('coverage-output.json').replace(/<HARVEST_ROOT>/g, dir);
      fs.writeFileSync(path.join(dir, 'coverage', 'coverage.json'), raw);
      const result = await ruby.capabilities!.coverage!.gather(dir);
      expect(result).not.toBeNull();
      expect(result!.coverage.linePercent).toBe(70.0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no SimpleCov artifact exists (capability provider contract)', async () => {
    // The dispatcher contract is `CoverageResult | null`. The provider
    // collapses both the html-only and the unavailable states to null;
    // `gatherSimpleCovOutcome` is the right surface for the richer
    // distinction (exercised in the next describe block).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-html-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      fs.writeFileSync(path.join(dir, 'coverage', 'index.html'), '<html>fake</html>');
      const result = await ruby.capabilities!.coverage!.gather(dir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gatherSimpleCovOutcome — discriminated outcome (Recipe v4 G_v4_3)', () => {
  it('returns `unavailable` when neither JSON nor HTML exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-out-none-'));
    try {
      const outcome = gatherSimpleCovOutcome(dir);
      expect(outcome.kind).toBe('unavailable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns `unavailable` even when coverage/ exists but is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-out-empty-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      const outcome = gatherSimpleCovOutcome(dir);
      expect(outcome.kind).toBe('unavailable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns `html-only` with a hint when SimpleCov produced HTML only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-out-html-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      fs.writeFileSync(path.join(dir, 'coverage', 'index.html'), '<html>real</html>');
      const outcome = gatherSimpleCovOutcome(dir);
      expect(outcome.kind).toBe('html-only');
      if (outcome.kind === 'html-only') {
        expect(outcome.hint).toContain('simplecov-json');
        expect(outcome.hint).toContain('.resultset.json');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns `success` with a parsed envelope when .resultset.json is parseable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-out-success-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      const raw = readFixture('coverage-output.json').replace(/<HARVEST_ROOT>/g, dir);
      fs.writeFileSync(path.join(dir, 'coverage', '.resultset.json'), raw);
      const outcome = gatherSimpleCovOutcome(dir);
      expect(outcome.kind).toBe('success');
      if (outcome.kind === 'success') {
        expect(outcome.envelope.coverage.linePercent).toBe(70.0);
        expect(outcome.envelope.coverage.source).toBe('simplecov');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns `html-only` (not `unavailable`) when JSON is corrupt but HTML exists', () => {
    // Subtle but important: a corrupt JSON shouldn't masquerade as
    // "tool didn't run" — the user clearly ran SimpleCov (HTML is the
    // tell). Surfacing `html-only` keeps the hint actionable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-cov-out-corrupt-'));
    try {
      fs.mkdirSync(path.join(dir, 'coverage'));
      fs.writeFileSync(path.join(dir, 'coverage', '.resultset.json'), 'not valid json {{{');
      fs.writeFileSync(path.join(dir, 'coverage', 'index.html'), '<html>real</html>');
      const outcome = gatherSimpleCovOutcome(dir);
      expect(outcome.kind).toBe('html-only');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mapRubocopSeverity', () => {
  // Synthetic-string assertions per the recipe convention: source-text
  // parsers (severity classification consumes language-stable strings)
  // do not need real fixtures. The full 5-tier mapping is exercised
  // here; the real fixture only naturally surfaces 2 tiers
  // (convention + warning).
  it('maps rubocop severities into the dxkit four-tier scheme', () => {
    expect(mapRubocopSeverity('fatal')).toBe('critical');
    expect(mapRubocopSeverity('error')).toBe('high');
    expect(mapRubocopSeverity('warning')).toBe('medium');
    expect(mapRubocopSeverity('convention')).toBe('low');
    expect(mapRubocopSeverity('refactor')).toBe('low');
  });

  it('handles uppercased / mixed-case input defensively', () => {
    expect(mapRubocopSeverity('FATAL')).toBe('critical');
    expect(mapRubocopSeverity('Warning')).toBe('medium');
    expect(mapRubocopSeverity('Convention')).toBe('low');
  });

  it('defaults unknown severities to low rather than dropping them', () => {
    expect(mapRubocopSeverity('info')).toBe('low');
    expect(mapRubocopSeverity('')).toBe('low');
    expect(mapRubocopSeverity(null)).toBe('low');
    expect(mapRubocopSeverity(undefined)).toBe('low');
  });
});

describe('parseRubocopOutput', () => {
  // Real fixture provenance: rubocop v1.86.1 verbatim JSON output
  // against test/fixtures/benchmarks/ruby/bad_lint.rb. 3 offenses:
  // 2× convention (Style/FrozenStringLiteralComment, Style/RedundantReturn),
  // 1× warning (Lint/UselessAssignment). See HARVEST.md for capture
  // commands.

  it('counts offenses by severity tier in the real fixture', () => {
    const raw = readFixture('lint-output.json');
    const counts = parseRubocopOutput(raw);
    // 2 convention → low; 1 warning → medium; no error/fatal.
    expect(counts).toEqual({ critical: 0, high: 0, medium: 1, low: 2 });
  });

  it('returns zero counts when files[].offenses[] is empty', () => {
    const empty = JSON.stringify({
      metadata: { rubocop_version: '1.86.1' },
      files: [{ path: 'clean.rb', offenses: [] }],
      summary: { offense_count: 0, target_file_count: 1 },
    });
    const counts = parseRubocopOutput(empty);
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('aggregates offenses across multiple files', () => {
    const multi = JSON.stringify({
      files: [
        { path: 'a.rb', offenses: [{ severity: 'warning' }, { severity: 'convention' }] },
        { path: 'b.rb', offenses: [{ severity: 'error' }] },
      ],
    });
    const counts = parseRubocopOutput(multi);
    expect(counts).toEqual({ critical: 0, high: 1, medium: 1, low: 1 });
  });

  it('returns zero counts on malformed JSON (no throw)', () => {
    const counts = parseRubocopOutput('not-json');
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('returns zero counts when the JSON has no files key (rubocop crashed)', () => {
    expect(parseRubocopOutput(JSON.stringify({ metadata: {} }))).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });
});

describe('parseOsvScannerFindings (RubyGems ecosystem)', () => {
  // Real fixture: osv-scanner v2.x against a hand-crafted Gemfile.lock
  // pinning nokogiri 1.10.0 + rack 2.0.1 + loofah 2.2.0. Captured
  // 2026-05-04 for Phase 10k.2.6. 73 advisories total: 31 nokogiri +
  // 36 rack + 6 loofah. See HARVEST.md for the lockfile contents.

  it('extracts findings from the real RubyGems osv-scanner output', () => {
    const raw = readFixture('depvulns-output.json');
    const { counts, findings } = parseOsvScannerFindings(raw, 'RubyGems');
    // The fixture has 3 RubyGems packages totalling 73 vulns. The
    // parser dedups by (package, version, id) — every advisory id
    // here is unique per package, so the dedup pass is a no-op and
    // the count holds.
    expect(findings.length).toBeGreaterThanOrEqual(70);
    expect(findings.length).toBe(73);
    const totalCounted = counts.critical + counts.high + counts.medium + counts.low;
    expect(totalCounted).toBe(findings.length);
  });

  it('attributes findings to the correct RubyGems package coordinates', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings } = parseOsvScannerFindings(raw, 'RubyGems');
    const nokogiriFindings = findings.filter((f) => f.package === 'nokogiri');
    const rackFindings = findings.filter((f) => f.package === 'rack');
    const loofahFindings = findings.filter((f) => f.package === 'loofah');
    expect(nokogiriFindings.length).toBe(31);
    expect(rackFindings.length).toBe(36);
    expect(loofahFindings.length).toBe(6);
    // Spot-check: every loofah finding pinned to 2.2.0
    for (const f of loofahFindings) {
      expect(f.installedVersion).toBe('2.2.0');
      expect(f.tool).toBe('osv-scanner');
    }
  });

  it('captures CVE aliases for advisories that ship them', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings } = parseOsvScannerFindings(raw, 'RubyGems');
    // Loofah's GHSA-x7rv-cr6v-4vm4 has CVE-2018-8048 as alias.
    const loofahCve = findings.find((f) => f.id === 'GHSA-x7rv-cr6v-4vm4');
    expect(loofahCve).toBeDefined();
    expect(loofahCve!.aliases).toContain('CVE-2018-8048');
  });

  it('synthesizes osv.dev reference URL for every advisory', () => {
    const raw = readFixture('depvulns-output.json');
    const { findings } = parseOsvScannerFindings(raw, 'RubyGems');
    for (const f of findings) {
      expect(f.references).toBeDefined();
      expect(f.references!.length).toBeGreaterThan(0);
    }
  });

  it("filters out non-RubyGems ecosystems when called with 'RubyGems'", () => {
    // Use the existing kotlin Maven fixture and filter for RubyGems —
    // should produce zero findings (no RubyGems packages there).
    const mavenRaw = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'raw', 'kotlin', 'osv-scanner-output.json'),
      'utf-8',
    );
    const { findings } = parseOsvScannerFindings(mavenRaw, 'RubyGems');
    expect(findings.length).toBe(0);
  });
});

describe('gatherRubyDepVulnsResult — manifest probe', () => {
  it('reads Gemfile.lock when present and produces an envelope (network-dependent)', async () => {
    // This test validates the file-probe + tool-invocation path.
    // It depends on osv-scanner being installed; if not, gather()
    // returns null and we just assert the gate is honest.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-vuln-'));
    try {
      // Empty Gemfile.lock — osv-scanner accepts it but reports no
      // packages. We assert the gather function doesn't throw and
      // returns either a success envelope OR null (depending on
      // local osv-scanner availability + network).
      fs.writeFileSync(path.join(dir, 'Gemfile.lock'), 'GEM\n  remote: https://rubygems.org/\n');
      const result = await ruby.capabilities!.depVulns!.gather(dir);
      // Either: osv-scanner ran and found nothing (envelope w/ zero counts),
      // or osv-scanner missing (null).
      if (result !== null) {
        expect(result.tool).toBe('osv-scanner');
        expect(result.counts.critical + result.counts.high).toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no Gemfile.lock exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-vuln-empty-'));
    try {
      const result = await ruby.capabilities!.depVulns!.gather(dir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ruby.correctness', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ruby-corr-'));
  }
  const ctx = (
    cwd: string,
    over: Partial<{ changedFiles: string[]; scope: 'affected' | 'full' }> = {},
  ) => ({
    cwd,
    changedFiles: over.changedFiles ?? ['lib/app.rb'],
    scope: over.scope ?? ('affected' as const),
  });

  it('syntaxCheck: compiles each changed .rb via a ruby -e wrapper', () => {
    const dir = tmpDir();
    try {
      const cmd = ruby.correctness!.syntaxCheck(
        ctx(dir, { changedFiles: ['lib/a.rb', 'lib/b.rb', 'README.md'] }),
      );
      expect(cmd?.bin).toBe('ruby');
      expect(cmd?.args[0]).toBe('-e');
      expect(cmd?.args).toContain('lib/a.rb');
      expect(cmd?.args).toContain('lib/b.rb');
      expect(cmd?.args).not.toContain('README.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('syntaxCheck: null when no .rb changed', () => {
    const dir = tmpDir();
    try {
      expect(ruby.correctness!.syntaxCheck(ctx(dir, { changedFiles: ['README.md'] }))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('affectedTests: null when no test framework is detected', () => {
    const dir = tmpDir();
    try {
      expect(ruby.correctness!.affectedTests(ctx(dir))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('affectedTests: rspec runs the changed specs on the affected surface', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'Gemfile'), "gem 'rspec'\n");
      const cmd = ruby.correctness!.affectedTests(
        ctx(dir, { changedFiles: ['lib/a.rb', 'spec/a_spec.rb'] }),
      );
      expect(cmd).toEqual({ label: 'affected-tests', bin: 'rspec', args: ['spec/a_spec.rb'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('affectedTests: rspec runs the whole suite at full scope', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'Gemfile'), "gem 'rspec'\n");
      const cmd = ruby.correctness!.affectedTests(ctx(dir, { scope: 'full' }));
      expect(cmd).toEqual({ label: 'affected-tests', bin: 'rspec', args: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('affectedTests: minitest loads the changed test files on the affected surface', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'Gemfile'), "gem 'minitest'\n");
      const cmd = ruby.correctness!.affectedTests(
        ctx(dir, { changedFiles: ['lib/a.rb', 'test/a_test.rb'] }),
      );
      expect(cmd?.bin).toBe('ruby');
      expect(cmd?.args.slice(0, 2)).toEqual(['-Itest', '-Ilib']);
      expect(cmd?.args).toContain('test/a_test.rb');
      expect(cmd?.args).toContain('ARGV.each { |f| load f }');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('affectedTests: minitest globs the test tree at full scope', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'Gemfile'), "gem 'minitest'\n");
      const cmd = ruby.correctness!.affectedTests(ctx(dir, { scope: 'full' }));
      expect(cmd?.args.join(' ')).toContain('Dir.glob("test/**/*_test.rb")');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('affectedTests: null on the affected surface when no test file changed', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'Gemfile'), "gem 'minitest'\n");
      expect(ruby.correctness!.affectedTests(ctx(dir, { changedFiles: ['lib/a.rb'] }))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
