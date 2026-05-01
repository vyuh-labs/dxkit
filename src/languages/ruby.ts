import * as fs from 'fs';
import * as path from 'path';

import type { LanguageSupport } from './types';

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

  tools: [],

  semgrepRulesets: ['p/ruby'],

  capabilities: {},

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
