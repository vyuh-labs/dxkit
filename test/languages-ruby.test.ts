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

import { ruby, extractRubyImportsRaw, parseSimpleCovResultset } from '../src/languages/ruby';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'ruby');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('ruby pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(ruby.id).toBe('ruby');
    expect(ruby.displayName).toBe('Ruby');
  });

  it('declares imports + testFramework + coverage capability providers (10k.2.3-4)', () => {
    expect(ruby.capabilities?.imports).toBeDefined();
    expect(ruby.capabilities?.testFramework).toBeDefined();
    expect(ruby.capabilities?.coverage).toBeDefined();
  });

  it('lint / depVulns providers are not yet wired (land in 10k.2.5-6)', () => {
    expect(ruby.capabilities?.lint).toBeUndefined();
    expect(ruby.capabilities?.depVulns).toBeUndefined();
  });

  it('declares simplecov as a required tool (10k.2.4)', () => {
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

  it('returns null when no SimpleCov artifact exists (HTML-only state included)', async () => {
    // HTML-only is currently indistinguishable from "tool didn't run" —
    // tracked as Recipe v4 candidate (extend coverage outcome enum).
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
