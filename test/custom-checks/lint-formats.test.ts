import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { parseLocated } from '../../src/analyzers/custom-checks/parse';
import { LANGUAGES } from '../../src/languages';
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
 *
 * PLUS the cross-pack path-parity net: whatever path shape a linter prints,
 * every finding leaving `parseLocated` must carry a REPO-RELATIVE POSIX `file`
 * (the same contract the frozen SDK wire format states — `WireFinding.file`:
 * "Repo-relative POSIX path"). `file` feeds the finding's identity (Rule 9),
 * and an identity input must survive a checkout-path change: three linters
 * print ABSOLUTE paths (ktlint, MSBuild via `dotnet build`, rubocop's emacs
 * formatter), and before this boundary existed 0 of 453 real ktlint identities
 * survived a two-path A/B — the grandfathered backlog false-blocked wholesale.
 * The packs whose linters print relative paths were safe by convention, not by
 * design; every pack therefore has BOTH a relative and an absolute fixture, so
 * the post-condition is proven per pack, not per lucky linter.
 */

/** The repo root every absolute-path fixture pretends the linter ran in. */
const CWD = '/home/ci/work/repo';

interface Fixture {
  readonly label: string;
  /** Which pack's parse pattern this exercises — drives the coverage guard. */
  readonly packId: string;
  readonly pattern: string;
  readonly sample: string;
  readonly expect: { file: string; line: number; rule?: string; message?: string };
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    label: 'eslint --format unix (plugin rule with slash, absolute path)',
    packId: 'typescript',
    pattern: TS_ESLINT_UNIX_PARSE,
    sample: `${CWD}/src/a.ts:2:7: 'x' is defined but never used. [Error/@typescript-eslint/no-unused-vars]`,
    expect: {
      file: 'src/a.ts',
      line: 2,
      rule: '@typescript-eslint/no-unused-vars',
      message: "'x' is defined but never used.",
    },
  },
  {
    label: 'eslint --format unix (core rule, relative path)',
    packId: 'typescript',
    pattern: TS_ESLINT_UNIX_PARSE,
    sample: 'src/a.ts:10:1: Unexpected console statement. [Warning/no-console]',
    expect: { file: 'src/a.ts', line: 10, rule: 'no-console' },
  },
  {
    label: 'ruff --output-format concise (relative path — ruff convention)',
    packId: 'python',
    pattern: PY_RUFF_CONCISE_PARSE,
    sample: 'app/main.py:1:8: F401 `os` imported but unused',
    expect: { file: 'app/main.py', line: 1, rule: 'F401', message: '`os` imported but unused' },
  },
  {
    label: 'ruff --output-format concise (absolute path)',
    packId: 'python',
    pattern: PY_RUFF_CONCISE_PARSE,
    sample: `${CWD}/app/main.py:1:8: F401 \`os\` imported but unused`,
    expect: { file: 'app/main.py', line: 1, rule: 'F401', message: '`os` imported but unused' },
  },
  {
    label: 'golangci-lint --out-format line-number (relative path — go convention)',
    packId: 'go',
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
    label: 'golangci-lint --out-format line-number (absolute path)',
    packId: 'go',
    pattern: GO_GOLANGCI_LINE_PARSE,
    sample: `${CWD}/internal/svc/user.go:42:2: undeclared name: foo (typecheck)`,
    expect: {
      file: 'internal/svc/user.go',
      line: 42,
      rule: 'typecheck',
      message: 'undeclared name: foo',
    },
  },
  {
    label: 'rubocop --format emacs (absolute path — the emacs formatter prints raw)',
    packId: 'ruby',
    pattern: RUBY_RUBOCOP_EMACS_PARSE,
    sample: `${CWD}/app/models/user.rb:2:1: C: Style/FrozenStringLiteralComment: Missing frozen string literal comment.`,
    expect: {
      file: 'app/models/user.rb',
      line: 2,
      rule: 'Style/FrozenStringLiteralComment',
      message: 'Missing frozen string literal comment.',
    },
  },
  {
    label: 'rubocop --format emacs (relative path)',
    packId: 'ruby',
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
    label: 'clippy --message-format short (relative path, no rule group)',
    packId: 'rust',
    pattern: RUST_CLIPPY_SHORT_PARSE,
    sample: 'src/main.rs:4:9: warning: unused variable: `x`',
    expect: { file: 'src/main.rs', line: 4, message: 'unused variable: `x`' },
  },
  {
    label: 'clippy --message-format short (absolute path)',
    packId: 'rust',
    pattern: RUST_CLIPPY_SHORT_PARSE,
    sample: `${CWD}/src/main.rs:4:9: warning: unused variable: \`x\``,
    expect: { file: 'src/main.rs', line: 4, message: 'unused variable: `x`' },
  },
  {
    label: 'ktlint default (absolute path — ktlint prints absolute, runtime-proven)',
    packId: 'kotlin',
    pattern: KOTLIN_KTLINT_PARSE,
    sample: `${CWD}/src/Main.kt:1:1: Unexpected blank line(s) before "}" (standard:no-blank-line-before-rbrace)`,
    expect: {
      file: 'src/Main.kt',
      line: 1,
      rule: 'standard:no-blank-line-before-rbrace',
      message: 'Unexpected blank line(s) before "}"',
    },
  },
  {
    label: 'ktlint default (relative path)',
    packId: 'kotlin',
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
    label:
      'dotnet build analyzer warning (absolute path — MSBuild prints absolute, runtime-proven)',
    packId: 'csharp',
    pattern: CSHARP_MSBUILD_WARNING_PARSE,
    sample: `${CWD}/Controllers/HomeController.cs(12,5): warning CA1822: Member does not access instance data [${CWD}/App.csproj]`,
    expect: {
      file: 'Controllers/HomeController.cs',
      line: 12,
      rule: 'CA1822',
      message: 'Member does not access instance data',
    },
  },
  {
    label: 'dotnet build analyzer warning (relative path, with project suffix)',
    packId: 'csharp',
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

/**
 * Packs whose lint gate is DORMANT (lintCommand always returns null, so no
 * parse pattern exists to exercise). A declared exemption with a reason —
 * never a silent omission (same discipline as `RECALL_VERSION_EXEMPT` /
 * `DEFERRED_KINDS`). Wiring a real command for one of these means adding
 * relative + absolute fixtures above, or the coverage guard below fails.
 */
const DORMANT_LINT_GATES: ReadonlySet<string> = new Set([
  'java', // no stable machine-parseable default linter pinned yet — gate ships dormant
]);

describe('lint-gate parse-format contract', () => {
  for (const fx of FIXTURES) {
    it(`${fx.label} → extracts a located finding`, () => {
      const found = parseLocated('lint:test', true, fx.pattern, fx.sample, CWD);
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
        expect(
          parseLocated('lint:test', true, fx.pattern, line, CWD),
          `${fx.label}: "${line}"`,
        ).toEqual([]);
      }
    }
  });
});

describe('lint-gate path parity (identity must survive a checkout-path change)', () => {
  it('no finding leaves parseLocated with an absolute or repo-escaping file, on any pack', () => {
    // The post-condition, asserted across EVERY fixture — including the
    // absolute-path ones, which is what makes this bite: before the boundary,
    // the ktlint/MSBuild/rubocop fixtures produced `file` values embedding CWD.
    for (const fx of FIXTURES) {
      for (const f of parseLocated('lint:test', true, fx.pattern, fx.sample, CWD)) {
        expect(path.isAbsolute(f.file), `${fx.label}: "${f.file}" is absolute`).toBe(false);
        expect(f.file.startsWith('..'), `${fx.label}: "${f.file}" escapes the repo`).toBe(false);
        expect(f.file.includes('\\'), `${fx.label}: "${f.file}" is not POSIX`).toBe(false);
      }
    }
  });

  it('relative and absolute renderings of the same diagnostic mint the SAME file (one identity)', () => {
    // The two-machine scenario in one process: the same diagnostic printed
    // relative on one machine and absolute on another must not fork the
    // finding's identity input.
    const byPack = new Map<string, Set<string>>();
    for (const fx of FIXTURES) {
      const files = byPack.get(fx.packId) ?? new Set<string>();
      for (const f of parseLocated('lint:test', true, fx.pattern, fx.sample, CWD)) {
        files.add(f.file);
      }
      byPack.set(fx.packId, files);
    }
    for (const [packId, files] of byPack) {
      expect(files.size, `${packId}: fixtures should converge on one relative path`).toBe(1);
    }
  });

  it('every pack with a live lint gate has parse-format fixtures (coverage guard)', () => {
    const covered = new Set(FIXTURES.map((f) => f.packId));
    for (const pack of LANGUAGES) {
      if (!pack.lintGate || DORMANT_LINT_GATES.has(pack.id)) continue;
      expect(
        covered.has(pack.id),
        `pack '${pack.id}' declares a lint gate but has no fixture`,
      ).toBe(true);
    }
  });
});
