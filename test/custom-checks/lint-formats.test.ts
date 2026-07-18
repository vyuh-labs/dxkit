import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { parseLocated, parseStructuredLocated } from '../../src/analyzers/custom-checks/parse';
import type { CustomCheckFinding } from '../../src/analyzers/custom-checks/types';
import { LANGUAGES } from '../../src/languages';
import type { LintOutputParse } from '../../src/languages/capabilities/lint-gate';
import { parseEslintJson } from '../../src/languages/typescript';
import { parseRuffJson } from '../../src/languages/python';
import { parseGolangciJson } from '../../src/languages/go';
import { parseRubocopJson } from '../../src/languages/ruby';
import { parseClippyJson } from '../../src/languages/rust';
import { parseKtlintJson } from '../../src/languages/kotlin';
import { parseSwiftlintJson } from '../../src/languages/swift';
import { CSHARP_MSBUILD_WARNING_PARSE } from '../../src/languages/csharp';

/**
 * The lint-gate format contract: each pack's parse must correctly extract
 * (file, line, rule?, message) from a REAL sample of that linter's output in
 * the format the pack's `lintCommand` requests — native machine-readable JSON
 * for six packs, the MSBuild diagnostic line for csharp (the one declared
 * regex exception). If a linter's format is misremembered, the fixture fails
 * here, not in a user's guardrail.
 *
 * PLUS the cross-pack path-parity net: whatever path shape a linter emits,
 * every finding leaving the seam boundary must carry a REPO-RELATIVE POSIX
 * `file` (the same contract the frozen SDK wire format states —
 * `WireFinding.file`: "Repo-relative POSIX path"). `file` feeds the finding's
 * identity (Rule 9), and an identity input must survive a checkout-path
 * change: several linters emit ABSOLUTE paths (eslint/ruff/ktlint JSON,
 * MSBuild), and before this boundary existed 0 of 453 real ktlint identities
 * survived a two-path A/B — the grandfathered backlog false-blocked
 * wholesale. Every pack therefore has BOTH a relative and an absolute
 * fixture, so the post-condition is proven per pack, not per lucky linter.
 *
 * PLUS the noise net: the runner captures COMBINED output (stdout then
 * stderr), so a JSON payload can be preceded/followed by non-JSON noise —
 * every structured fixture is also parsed with noise wrapped around it and
 * must extract the same findings.
 */

/** The repo root every absolute-path fixture pretends the linter ran in. */
const CWD = '/home/ci/work/repo';

interface Fixture {
  readonly label: string;
  /** Which pack's parse this exercises — drives the coverage guard. */
  readonly packId: string;
  readonly parse: LintOutputParse;
  readonly sample: string;
  readonly expect: { file: string; line: number; rule?: string; message?: string };
}

const eslintParse: LintOutputParse = {
  kind: 'structured',
  label: 'eslint-json',
  parse: parseEslintJson,
};
const ruffParse: LintOutputParse = { kind: 'structured', label: 'ruff-json', parse: parseRuffJson };
const golangciParse: LintOutputParse = {
  kind: 'structured',
  label: 'golangci-json',
  parse: parseGolangciJson,
};
const rubocopParse: LintOutputParse = {
  kind: 'structured',
  label: 'rubocop-json',
  parse: parseRubocopJson,
};
const clippyParse: LintOutputParse = {
  kind: 'structured',
  label: 'clippy-json',
  parse: parseClippyJson,
};
const ktlintParse: LintOutputParse = {
  kind: 'structured',
  label: 'ktlint-json',
  parse: parseKtlintJson,
};

/** eslint `--format json` emits ABSOLUTE `filePath`s. */
function eslintSample(filePath: string): string {
  return JSON.stringify([
    {
      filePath,
      messages: [
        {
          ruleId: '@typescript-eslint/no-unused-vars',
          severity: 2,
          message: "'x' is defined but never used.",
          line: 2,
          column: 7,
        },
      ],
      errorCount: 1,
      warningCount: 0,
    },
  ]);
}

/** ruff `--output-format json` emits ABSOLUTE `filename`s. */
function ruffSample(filename: string): string {
  return JSON.stringify([
    {
      cell: null,
      code: 'F401',
      filename,
      location: { row: 1, column: 8 },
      end_location: { row: 1, column: 10 },
      message: '`os` imported but unused',
      noqa_row: 1,
      url: 'https://docs.astral.sh/ruff/rules/unused-import',
    },
  ]);
}

/** golangci-lint `--out-format json` emits repo-relative `Pos.Filename`s. */
function golangciSample(filename: string): string {
  return JSON.stringify({
    Issues: [
      {
        FromLinter: 'typecheck',
        Text: 'undeclared name: foo',
        Severity: '',
        SourceLines: ['\tfoo()'],
        Pos: { Filename: filename, Offset: 100, Line: 42, Column: 2 },
      },
    ],
    Report: { Linters: [{ Name: 'typecheck', Enabled: true }] },
  });
}

/** rubocop `--format json` emits repo-relative `path`s. */
function rubocopSample(p: string): string {
  return JSON.stringify({
    metadata: { rubocop_version: '1.66.0' },
    files: [
      {
        path: p,
        offenses: [
          {
            severity: 'convention',
            message: 'Missing frozen string literal comment.',
            cop_name: 'Style/FrozenStringLiteralComment',
            corrected: false,
            location: { start_line: 2, start_column: 1, line: 2, column: 1, length: 1 },
          },
        ],
      },
    ],
    summary: { offense_count: 1, target_file_count: 1, inspected_file_count: 1 },
  });
}

/** cargo/clippy `--message-format json` NDJSON, workspace-relative spans. */
function clippySample(fileName: string): string {
  return [
    JSON.stringify({
      reason: 'compiler-message',
      package_id: 'path+file:///repo#demo@0.1.0',
      message: {
        rendered: 'warning: unused variable: `x`\n',
        code: { code: 'unused_variables', explanation: null },
        level: 'warning',
        message: 'unused variable: `x`',
        spans: [
          {
            file_name: fileName,
            is_primary: true,
            line_start: 4,
            line_end: 4,
            column_start: 9,
            column_end: 10,
          },
        ],
      },
    }),
    // The end-of-run summary diagnostic has no spans and must be skipped.
    JSON.stringify({
      reason: 'compiler-message',
      message: { code: null, level: 'warning', message: '1 warning emitted', spans: [] },
    }),
    JSON.stringify({ reason: 'build-finished', success: false }),
  ].join('\n');
}

/** ktlint `--reporter=json` emits ABSOLUTE `file`s (runtime-proven). */
function ktlintSample(file: string): string {
  return JSON.stringify([
    {
      file,
      errors: [
        {
          line: 1,
          column: 1,
          message: 'Unexpected blank line(s) before "}"',
          rule: 'standard:no-blank-line-before-rbrace',
        },
      ],
    },
  ]);
}

const swiftlintParse: LintOutputParse = {
  kind: 'structured',
  label: 'swiftlint-json',
  parse: parseSwiftlintJson,
};

/** swiftlint `--reporter json` emits ABSOLUTE `file`s (runtime-proven against
 *  0.65.0 — field names + severity casing match the captured bytes in
 *  test/fixtures/raw/swift/lint-output.json). */
function swiftlintSample(file: string): string {
  return JSON.stringify([
    {
      character: 27,
      file,
      line: 4,
      reason: 'Force casts should be avoided',
      rule_id: 'force_cast',
      severity: 'Error',
      type: 'Force Cast',
    },
  ]);
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    label: 'eslint --format json (absolute filePath — eslint convention)',
    packId: 'typescript',
    parse: eslintParse,
    sample: eslintSample(`${CWD}/src/a.ts`),
    expect: {
      file: 'src/a.ts',
      line: 2,
      rule: '@typescript-eslint/no-unused-vars',
      message: "'x' is defined but never used.",
    },
  },
  {
    label: 'eslint --format json (relative filePath)',
    packId: 'typescript',
    parse: eslintParse,
    sample: eslintSample('src/a.ts'),
    expect: { file: 'src/a.ts', line: 2, rule: '@typescript-eslint/no-unused-vars' },
  },
  {
    label: 'ruff --output-format json (absolute filename — ruff convention)',
    packId: 'python',
    parse: ruffParse,
    sample: ruffSample(`${CWD}/app/main.py`),
    expect: { file: 'app/main.py', line: 1, rule: 'F401', message: '`os` imported but unused' },
  },
  {
    label: 'ruff --output-format json (relative filename)',
    packId: 'python',
    parse: ruffParse,
    sample: ruffSample('app/main.py'),
    expect: { file: 'app/main.py', line: 1, rule: 'F401' },
  },
  {
    label: 'golangci-lint --out-format json (relative Pos.Filename — go convention)',
    packId: 'go',
    parse: golangciParse,
    sample: golangciSample('internal/svc/user.go'),
    expect: {
      file: 'internal/svc/user.go',
      line: 42,
      rule: 'typecheck',
      message: 'undeclared name: foo',
    },
  },
  {
    label: 'golangci-lint --out-format json (absolute Pos.Filename)',
    packId: 'go',
    parse: golangciParse,
    sample: golangciSample(`${CWD}/internal/svc/user.go`),
    expect: { file: 'internal/svc/user.go', line: 42, rule: 'typecheck' },
  },
  {
    label: 'rubocop --format json (relative path — rubocop convention)',
    packId: 'ruby',
    parse: rubocopParse,
    sample: rubocopSample('app/models/user.rb'),
    expect: {
      file: 'app/models/user.rb',
      line: 2,
      rule: 'Style/FrozenStringLiteralComment',
      message: 'Missing frozen string literal comment.',
    },
  },
  {
    label: 'rubocop --format json (absolute path)',
    packId: 'ruby',
    parse: rubocopParse,
    sample: rubocopSample(`${CWD}/app/models/user.rb`),
    expect: { file: 'app/models/user.rb', line: 2, rule: 'Style/FrozenStringLiteralComment' },
  },
  {
    label: 'clippy --message-format json (relative span — cargo convention, rule now captured)',
    packId: 'rust',
    parse: clippyParse,
    sample: clippySample('src/main.rs'),
    expect: {
      file: 'src/main.rs',
      line: 4,
      rule: 'unused_variables',
      message: 'unused variable: `x`',
    },
  },
  {
    label: 'clippy --message-format json (absolute span)',
    packId: 'rust',
    parse: clippyParse,
    sample: clippySample(`${CWD}/src/main.rs`),
    expect: { file: 'src/main.rs', line: 4, rule: 'unused_variables' },
  },
  {
    label: 'ktlint --reporter=json (absolute file — ktlint convention, runtime-proven)',
    packId: 'kotlin',
    parse: ktlintParse,
    sample: ktlintSample(`${CWD}/src/Main.kt`),
    expect: {
      file: 'src/Main.kt',
      line: 1,
      rule: 'standard:no-blank-line-before-rbrace',
      message: 'Unexpected blank line(s) before "}"',
    },
  },
  {
    label: 'ktlint --reporter=json (relative file)',
    packId: 'kotlin',
    parse: ktlintParse,
    sample: ktlintSample('src/Main.kt'),
    expect: { file: 'src/Main.kt', line: 1, rule: 'standard:no-blank-line-before-rbrace' },
  },
  {
    label: 'swiftlint --reporter json (absolute file — swiftlint convention, runtime-proven)',
    packId: 'swift',
    parse: swiftlintParse,
    sample: swiftlintSample(`${CWD}/Sources/App/BadLint.swift`),
    expect: {
      file: 'Sources/App/BadLint.swift',
      line: 4,
      rule: 'force_cast',
      message: 'Force casts should be avoided',
    },
  },
  {
    label: 'swiftlint --reporter json (relative file)',
    packId: 'swift',
    parse: swiftlintParse,
    sample: swiftlintSample('Sources/App/BadLint.swift'),
    expect: { file: 'Sources/App/BadLint.swift', line: 4, rule: 'force_cast' },
  },
  {
    label:
      'dotnet build analyzer warning (absolute path — MSBuild prints absolute, runtime-proven)',
    packId: 'csharp',
    parse: { kind: 'regex', pattern: CSHARP_MSBUILD_WARNING_PARSE },
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
    parse: { kind: 'regex', pattern: CSHARP_MSBUILD_WARNING_PARSE },
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

/** Run a fixture's sample through the seam entry its parse mode uses. */
function runFixture(parse: LintOutputParse, output: string): CustomCheckFinding[] {
  return parse.kind === 'regex'
    ? parseLocated('lint:test', true, parse.pattern, output, CWD)
    : parseStructuredLocated('lint:test', true, parse.parse, output, CWD);
}

/**
 * Packs whose lint gate is DORMANT (lintCommand always returns null, so no
 * parse exists to exercise). A declared exemption with a reason — never a
 * silent omission (same discipline as `RECALL_VERSION_EXEMPT` /
 * `DEFERRED_KINDS`). Wiring a real command for one of these means adding
 * relative + absolute fixtures above, or the coverage guard below fails.
 */
const DORMANT_LINT_GATES: ReadonlySet<string> = new Set([
  'java', // no stable machine-parseable default linter pinned yet — gate ships dormant
]);

describe('lint-gate parse-format contract', () => {
  for (const fx of FIXTURES) {
    it(`${fx.label} → extracts a located finding`, () => {
      const found = runFixture(fx.parse, fx.sample);
      expect(found, fx.label).toHaveLength(1);
      const f = found[0];
      expect(f.file, 'file').toBe(fx.expect.file);
      expect(f.line, 'line').toBe(fx.expect.line);
      if (fx.expect.rule !== undefined) expect(f.rule, 'rule').toBe(fx.expect.rule);
      if (fx.expect.message !== undefined) expect(f.message, 'message').toBe(fx.expect.message);
    });
  }

  it('non-diagnostic output (summary / banner / empty) yields no findings, every pack', () => {
    const noise = [
      'Found 3 errors in 2 files.',
      'Build succeeded.',
      '',
      '  42 problems (40 errors, 2 warnings)',
      '[]',
      '{}',
    ];
    for (const fx of FIXTURES) {
      for (const line of noise) {
        expect(runFixture(fx.parse, line), `${fx.label}: "${line}"`).toEqual([]);
      }
    }
  });

  it('a structured payload wrapped in combined-stream noise still parses (stderr appended)', () => {
    // The runner captures stdout THEN stderr, whole streams concatenated. A
    // deprecation warning after the payload (or an npx banner before it) must
    // cost nothing. NDJSON (clippy) tolerates interleaving by construction;
    // blob JSON goes through extractJsonBlob.
    //
    // The prefix uses ktlint's REAL log shape, verbatim from a live run —
    // ktlint logs to STDOUT before its JSON, and its log lines contain
    // BRACKETS (`[main]`, `[**/*.kt, **/*.kts]`). Anchoring the blob
    // extraction on the first bracket read `[main]`, failed the parse, and
    // silently downgraded a 453-finding Kotlin run to one binary finding
    // (found live on a real repo, VERIFY-39 F-10).
    for (const fx of FIXTURES) {
      if (fx.parse.kind !== 'structured') continue;
      const noisy =
        `npx: installed 1 package\n` +
        `10:36:22.984 [main] INFO com.pinterest.ktlint.cli.internal.KtlintCommandLine -- Enable default patterns [**/*.kt, **/*.kts]\n` +
        `10:36:23.627 [main] WARN {main} -- Lint has found errors than can be autocorrected using 'ktlint --format'\n` +
        `${fx.sample}\n(node:42) DeprecationWarning: legacy config detected\n`;
      const clean = runFixture(fx.parse, fx.sample);
      const wrapped = runFixture(fx.parse, noisy);
      expect(wrapped, `${fx.label}: noise-wrapped parse must match clean parse`).toEqual(clean);
      expect(clean.length, `${fx.label}: clean parse found nothing`).toBeGreaterThan(0);
    }
  });

  it('a structured parse never throws on garbage, truncation, or wrong shapes', () => {
    const garbage = ['not json at all', '[{"trunc', '{"Issues": "nope"}', '[42, null, "x"]'];
    for (const fx of FIXTURES) {
      if (fx.parse.kind !== 'structured') continue;
      for (const g of garbage) {
        const out = runFixture(fx.parse, g);
        expect(Array.isArray(out), `${fx.label}: "${g}"`).toBe(true);
      }
    }
  });
});

describe('lint-gate path parity (identity must survive a checkout-path change)', () => {
  it('no finding leaves the seam with an absolute or repo-escaping file, on any pack', () => {
    // The post-condition, asserted across EVERY fixture — including the
    // absolute-path ones, which is what makes this bite: eslint, ruff and
    // ktlint emit absolute paths in their native JSON.
    for (const fx of FIXTURES) {
      for (const f of runFixture(fx.parse, fx.sample)) {
        expect(f.file, `${fx.label}: a located finding must carry a file`).toBeDefined();
        if (f.file === undefined) continue; // narrows for TS; the assert above already failed
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
      for (const f of runFixture(fx.parse, fx.sample)) {
        if (f.file !== undefined) files.add(f.file);
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

  it("every live pack's fixtures use the parse its lintCommand actually declares", () => {
    // A fixture exercising a stale parse (yesterday's regex) reports coverage
    // that does not exist. For structured parses, reference identity pins it;
    // regex fixtures must use the declared pattern verbatim.
    for (const pack of LANGUAGES) {
      if (!pack.lintGate || DORMANT_LINT_GATES.has(pack.id)) continue;
      const cmd = pack.lintGate.lintCommand({ cwd: process.cwd(), changedFiles: [] });
      if (cmd === null) continue; // resolves against THIS machine; absent linter is fine
      for (const fx of FIXTURES.filter((f) => f.packId === pack.id)) {
        if (cmd.parse.kind === 'structured' && fx.parse.kind === 'structured') {
          expect(fx.parse.parse, `${pack.id}: fixture parse fn ≠ declared parse fn`).toBe(
            cmd.parse.parse,
          );
        } else if (cmd.parse.kind === 'regex' && fx.parse.kind === 'regex') {
          expect(fx.parse.pattern, `${pack.id}: fixture pattern ≠ declared pattern`).toBe(
            cmd.parse.pattern,
          );
        } else {
          expect.fail(`${pack.id}: fixture parse kind ≠ declared parse kind`);
        }
      }
    }
  });
});
