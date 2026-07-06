import { describe, it, expect } from 'vitest';

import { parseLocated } from '../../src/analyzers/custom-checks/parse';
import { TS_ESLINT_UNIX_PARSE } from '../../src/languages/typescript';
import { PY_RUFF_CONCISE_PARSE } from '../../src/languages/python';
import { GO_GOLANGCI_LINE_PARSE } from '../../src/languages/go';
import { RUBY_RUBOCOP_EMACS_PARSE } from '../../src/languages/ruby';
import { RUST_CLIPPY_SHORT_PARSE } from '../../src/languages/rust';
import { KOTLIN_KTLINT_PARSE } from '../../src/languages/kotlin';
import { CSHARP_MSBUILD_WARNING_PARSE } from '../../src/languages/csharp';

/**
 * The lint-gate format contract: each pack's parse regex must correctly extract
 * (file, line, rule?, message) from a REAL sample line of that linter's output.
 * This is the safety net for the per-linter regexes — if a linter's format is
 * misremembered, the fixture line fails here, not in a user's guardrail.
 *
 * Samples are taken from each tool's documented default output format.
 */

interface Fixture {
  readonly label: string;
  readonly pattern: string;
  readonly sample: string;
  readonly expect: { file: string; line: number; rule?: string; message?: string };
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    label: 'eslint --format unix (plugin rule with slash)',
    pattern: TS_ESLINT_UNIX_PARSE,
    sample:
      "/repo/src/a.ts:2:7: 'x' is defined but never used. [Error/@typescript-eslint/no-unused-vars]",
    expect: {
      file: '/repo/src/a.ts',
      line: 2,
      rule: '@typescript-eslint/no-unused-vars',
      message: "'x' is defined but never used.",
    },
  },
  {
    label: 'eslint --format unix (core rule)',
    pattern: TS_ESLINT_UNIX_PARSE,
    sample: 'src/b.js:10:1: Unexpected console statement. [Warning/no-console]',
    expect: { file: 'src/b.js', line: 10, rule: 'no-console' },
  },
  {
    label: 'ruff --output-format concise',
    pattern: PY_RUFF_CONCISE_PARSE,
    sample: 'app/main.py:1:8: F401 `os` imported but unused',
    expect: { file: 'app/main.py', line: 1, rule: 'F401', message: '`os` imported but unused' },
  },
  {
    label: 'golangci-lint --out-format line-number',
    pattern: GO_GOLANGCI_LINE_PARSE,
    sample: 'internal/svc/user.go:42:2: undeclared name: foo (typecheck)',
    expect: {
      file: 'internal/svc/user.go',
      line: 42,
      rule: 'typecheck',
      message: 'undeclared name: foo',
    },
  },
  {
    label: 'rubocop --format emacs',
    pattern: RUBY_RUBOCOP_EMACS_PARSE,
    sample:
      'app/models/user.rb:2:1: C: Style/FrozenStringLiteralComment: Missing frozen string literal comment.',
    expect: {
      file: 'app/models/user.rb',
      line: 2,
      rule: 'Style/FrozenStringLiteralComment',
      message: 'Missing frozen string literal comment.',
    },
  },
  {
    label: 'clippy --message-format short (no rule group)',
    pattern: RUST_CLIPPY_SHORT_PARSE,
    sample: 'src/main.rs:4:9: warning: unused variable: `x`',
    expect: { file: 'src/main.rs', line: 4, message: 'unused variable: `x`' },
  },
  {
    label: 'ktlint default',
    pattern: KOTLIN_KTLINT_PARSE,
    sample:
      'src/Main.kt:1:1: Unexpected blank line(s) before "}" (standard:no-blank-line-before-rbrace)',
    expect: {
      file: 'src/Main.kt',
      line: 1,
      rule: 'standard:no-blank-line-before-rbrace',
      message: 'Unexpected blank line(s) before "}"',
    },
  },
  {
    label: 'dotnet build analyzer warning (with project suffix)',
    pattern: CSHARP_MSBUILD_WARNING_PARSE,
    sample:
      'Controllers/HomeController.cs(12,5): warning CA1822: Member does not access instance data [/repo/App.csproj]',
    expect: {
      file: 'Controllers/HomeController.cs',
      line: 12,
      rule: 'CA1822',
      message: 'Member does not access instance data',
    },
  },
];

describe('lint-gate parse-format contract', () => {
  for (const fx of FIXTURES) {
    it(`${fx.label} → extracts a located finding`, () => {
      const found = parseLocated('lint:test', true, fx.pattern, fx.sample);
      expect(found, fx.label).toHaveLength(1);
      const f = found[0];
      expect(f.file, 'file').toBe(fx.expect.file);
      expect(f.line, 'line').toBe(fx.expect.line);
      if (fx.expect.rule !== undefined) expect(f.rule, 'rule').toBe(fx.expect.rule);
      if (fx.expect.message !== undefined) expect(f.message, 'message').toBe(fx.expect.message);
    });
  }

  it('a non-diagnostic line (summary / banner) is ignored by every pattern', () => {
    const noise = [
      'Found 3 errors in 2 files.',
      'Build succeeded.',
      '',
      '  42 problems (40 errors, 2 warnings)',
    ];
    for (const fx of FIXTURES) {
      for (const line of noise) {
        expect(parseLocated('lint:test', true, fx.pattern, line), `${fx.label}: "${line}"`).toEqual(
          [],
        );
      }
    }
  });
});
