/**
 * The ruby remediation capabilities (4.4.7 V2): the Gemfile explicit-entry
 * pin as a pure transform (applied / refused / adversarial), the gem-name
 * rail, the `gem search` probe parser total over garbage, the bundle add
 * install command, and the rubocop fix-mode parser dropping corrected
 * offenses. No network, no spawns.
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { rubyRemediation, isValidGemName } from '../../src/languages/ruby-remediation';
import { parseRubocopFixJson, parseRubocopJson } from '../../src/languages/ruby';
import type {
  DeclareDependencyProvider,
  PinTransitiveProvider,
} from '../../src/languages/capabilities/remediation';

const pin = (rubyRemediation.pinTransitive as { provider: PinTransitiveProvider }).provider;
const declare = (rubyRemediation.declareDependency as { provider: DeclareDependencyProvider })
  .provider;

const GEMFILE = `source "https://rubygems.org"

ruby "3.3.0"

gem "rails", "~> 7.1"
gem 'pg'

group :development, :test do
  gem "rspec-rails"
end
`;

function planPin(pkg = 'rack', version = '2.2.9') {
  return pin.plan({ cwd: os.tmpdir(), rootDir: '', pkg, version });
}

describe('pinTransitive: the Gemfile explicit-entry pin', () => {
  it('appends the exact-version gem line at the top level, preserving the Gemfile', () => {
    const plan = planPin();
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') return;
    expect(plan.edit.file).toBe('Gemfile');
    const out = plan.edit.transform(GEMFILE);
    if (!('text' in out)) throw new Error(out.refused);
    expect(out.text.startsWith(GEMFILE)).toBe(true);
    expect(out.text).toContain('gem "rack", "2.2.9"');
    expect(out.text).toContain('Pins a transitive dependency');
    expect(plan.revert).toContain('rack');
  });

  it('refuses a directly declared gem (either quote style) and non-Gemfile text', () => {
    const doubleQuoted = planPin('rails');
    if (doubleQuoted.kind !== 'plan') throw new Error(doubleQuoted.reason);
    const d = doubleQuoted.edit.transform(GEMFILE);
    expect(d).toHaveProperty('refused');
    if ('refused' in d) expect(d.refused).toContain('dep-bump');

    const singleQuoted = planPin('pg');
    if (singleQuoted.kind !== 'plan') throw new Error(singleQuoted.reason);
    expect(singleQuoted.edit.transform(GEMFILE)).toHaveProperty('refused');

    // A group-declared gem is still declared.
    const grouped = planPin('rspec-rails');
    if (grouped.kind !== 'plan') throw new Error(grouped.reason);
    expect(grouped.edit.transform(GEMFILE)).toHaveProperty('refused');

    for (const garbage of ['', 'not a manifest {', '42']) {
      const p = planPin();
      if (p.kind !== 'plan') throw new Error(p.reason);
      expect(p.edit.transform(garbage)).toHaveProperty('refused');
    }
  });

  it('refuses injection-shaped tokens before any edit exists (Rule 11)', () => {
    expect(planPin('-x').kind).toBe('refused');
    expect(planPin('a b').kind).toBe('refused');
    expect(planPin('rack', '2.2.9"; system "id').kind).toBe('refused');
  });
});

describe('the ruby pin-version grammar (RubyGems 4-segment security releases)', () => {
  const scheme = pin.versions!;
  it('accepts up to five numeric segments (7.0.8.7, the rails-family fix shape); refuses ranges and prereleases', () => {
    for (const ok of ['1.16.5', '7.0.8.7', '6.1.7.10', '3.2']) {
      expect(scheme.concrete(ok), ok).toBe(true);
    }
    for (const bad of ['>= 7.0.8', '~> 7.0', '7.0.8.rc1', '7.x', '*', '']) {
      expect(scheme.concrete(bad), bad).toBe(false);
    }
  });
  it('orders numerically, never lexicographically (6.1.7.10 outranks 6.1.7.9)', () => {
    expect(scheme.compare('6.1.7.10', '6.1.7.9')).toBeGreaterThan(0);
    expect(scheme.compare('7.0.8', '7.0.8.7')).toBeLessThan(0);
    expect(scheme.compare('7.0.8.7', '7.0.8.7')).toBe(0);
  });
});

describe('declareDependency: the gem rail, probe parsing, bundle add', () => {
  it('the rail rejects flag shapes and nested require paths', () => {
    expect(isValidGemName('nokogiri')).toBe(true);
    expect(isValidGemName('rspec-rails')).toBe(true);
    for (const bad of [
      '',
      '-x',
      '--source=https://evil',
      'a b',
      'a\nb',
      'active_support/core_ext',
    ]) {
      expect(declare.validSpecifier(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('parses gem search --remote --exact output, platform variants included; null on garbage', () => {
    expect(declare.parseProbeOutput('\n*** REMOTE GEMS ***\n\nnokogiri (1.16.5)\n')).toBe('1.16.5');
    expect(declare.parseProbeOutput('nokogiri (1.16.5 ruby java, 1.16.4)\n')).toBe('1.16.5');
    for (const garbage of ['', 'npm error 404', '\n\n', 'not-a-version']) {
      expect(declare.parseProbeOutput(garbage)).toBeNull();
    }
  });

  it('bundle add carries the exact version, and test-only importers land in :development', () => {
    const ctx = { cwd: os.tmpdir(), rootDir: '', specifier: 'nokogiri', version: '1.16.5' };
    expect(declare.installCommand({ ...ctx, dev: false })).toEqual({
      bin: 'bundle',
      args: ['add', 'nokogiri', '--version', '1.16.5'],
    });
    expect(declare.installCommand({ ...ctx, dev: true })).toEqual({
      bin: 'bundle',
      args: ['add', 'nokogiri', '--version', '1.16.5', '--group', 'development'],
    });
  });
});

describe('the rubocop fix-mode parser (corrected offenses are not leftovers)', () => {
  const sample = JSON.stringify({
    files: [
      {
        path: 'app/models/user.rb',
        offenses: [
          {
            cop_name: 'Layout/TrailingWhitespace',
            message: 'Trailing whitespace detected.',
            corrected: true,
            location: { line: 3 },
          },
          {
            cop_name: 'Lint/UselessAssignment',
            message: 'Useless assignment to variable - x.',
            corrected: false,
            location: { line: 9 },
          },
        ],
      },
    ],
  });

  it('drops corrected offenses in fix mode; the gate parser keeps reporting them', () => {
    expect(parseRubocopFixJson(sample)).toEqual([
      {
        file: 'app/models/user.rb',
        line: 9,
        rule: 'Lint/UselessAssignment',
        message: 'Useless assignment to variable - x.',
      },
    ]);
    expect(parseRubocopJson(sample)).toHaveLength(2);
  });

  it('is total over garbage', () => {
    for (const garbage of ['', 'not json', '{"files": 42}']) {
      expect(parseRubocopFixJson(garbage)).toEqual([]);
    }
  });
});
