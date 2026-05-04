/**
 * Ruby pack — pack-specific tests.
 *
 * Source-text parsers (`extractRubyImportsRaw`, Gemfile-text scan in
 * `gatherRubyTestFrameworkResult`) consume language syntax that is
 * stable across versions, so they're tested here against synthetic
 * inline strings — same convention kotlin/rust/java packs use for
 * their import parsers.
 *
 * RECIPE NOTE: when tool-output parsers land (RuboCop JSON, SimpleCov
 * resultset.json, bundler-audit output) under 10k.2.4-6, they MUST be
 * tested against REAL fixture files under `test/fixtures/raw/ruby/`,
 * NOT synthetic strings. The C# defect lesson (5 months silent,
 * parsers passed unit tests on synthetic JSON but returned 0 findings
 * on real input — fixed in Phase 10h.6.8) is the cautionary tale.
 * Capture commands live in `test/fixtures/raw/ruby/HARVEST.md`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ruby, extractRubyImportsRaw } from '../src/languages/ruby';

describe('ruby pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(ruby.id).toBe('ruby');
    expect(ruby.displayName).toBe('Ruby');
  });

  it('declares the imports + testFramework capability providers (10k.2.3)', () => {
    expect(ruby.capabilities?.imports).toBeDefined();
    expect(ruby.capabilities?.testFramework).toBeDefined();
  });

  it('lint / coverage / depVulns providers are not yet wired (land in 10k.2.4-6)', () => {
    expect(ruby.capabilities?.lint).toBeUndefined();
    expect(ruby.capabilities?.coverage).toBeUndefined();
    expect(ruby.capabilities?.depVulns).toBeUndefined();
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
