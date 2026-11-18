/**
 * "No tests ran" is its own floor result, never a pass (4.5.0).
 *
 * The shipped defect: a .NET web app with no test project ran `dotnet test`
 * as its floor test command, which exited 0 having run nothing, and every
 * surface read the repo as "tests pass". The same class sat in every pack
 * whose runner exits 0 on an empty suite (jest/vitest under
 * `--passWithNoTests`, `go test`, `cargo test`, rspec, minitest, phpunit,
 * Gradle), and pytest's exit 5 recorded the opposite lie, a blocking failure.
 *
 * Pinned here, across packs:
 *   1. each pack's `ranNoTests` recogniser against REAL runner output (both
 *      sides: zero-test output is no-tests, output of a run that executed a
 *      test never is — the precision side), fixtures in
 *      `test/fixtures/raw/floor-no-tests/` with provenance in HARVEST.md;
 *   2. the wiring: every pack's affected-tests command carries its
 *      recogniser, or the pack is in the declared exemption table with a
 *      reason (a new pack fails here until it decides);
 *   3. the runner: one status, `no-tests`, that sets neither `ran` nor
 *      `blocks`, and a recogniser throw keeps the plain verdict;
 *   4. every renderer and recorder: no surface prints a no-tests floor as
 *      green.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runCorrectnessFloor,
  describeCorrectnessFloor,
  describeNoTestsRan,
  type CommandExec,
  type CorrectnessFloorResult,
} from '../src/analyzers/correctness/run';
import { runFloorForSurface } from '../src/analyzers/correctness/surface-run';
import {
  floorDisclosureMarkdown,
  githubAnnotations,
} from '../src/analyzers/correctness/floor-disclosure';
import { LANGUAGES } from '../src/languages';
import type { LanguageSupport } from '../src/languages/types';
import type { CorrectnessCommand } from '../src/languages/capabilities/correctness';
import { tsRanNoTests } from '../src/languages/ts-test-entry';
import { pytestRanNoTests } from '../src/languages/python';
import { goTestRanNoTests } from '../src/languages/go';
import { cargoTestRanNoTests } from '../src/languages/rust';
import { dotnetTestRanNoTests } from '../src/languages/csharp';
import { rspecRanNoTests, minitestLoadRanNoTests } from '../src/languages/ruby';
import { phpunitRanNoTests } from '../src/languages/php';
import { swiftTestRanNoTests } from '../src/languages/swift';
import { gradleTestRanNoTests } from '../src/languages/jvm-build';
import { floorLedgerStatuses, describeFloorNoTests } from '../src/loop/floor-gate';
import { writeFloorBaseline, readFloorBaseline } from '../src/loop/floor-state';
import { renderFloorVerification } from '../src/lanes/verification-render';
import { floorOrderDone } from '../src/loop/order-scope';

type Recogniser = (run: { code: number; output: string }) => boolean;

const FIXTURES = path.join(__dirname, 'fixtures', 'raw', 'floor-no-tests');
const fixture = (f: string): string => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

/** file → [recogniser, exit code the runner saw, expected answer]. */
const CASES: Record<string, [Recogniser, number, boolean]> = {
  // .NET (captured; the MTP file is documented)
  'dotnet10-web-sln-no-test-project.txt': [dotnetTestRanNoTests, 0, true],
  'dotnet9-web-sln-no-test-project.txt': [dotnetTestRanNoTests, 0, true],
  'dotnet10-xunit-project-zero-tests.txt': [dotnetTestRanNoTests, 0, true],
  'dotnet10-xunit-one-test.txt': [dotnetTestRanNoTests, 0, false],
  'dotnet-mtp-zero-tests.txt': [dotnetTestRanNoTests, 8, true],
  // Rust (captured)
  'cargo-lib-zero-tests.txt': [cargoTestRanNoTests, 0, true],
  'cargo-bin-zero-tests.txt': [cargoTestRanNoTests, 0, true],
  'cargo-lib-one-test.txt': [cargoTestRanNoTests, 0, false],
  // Python (captured)
  'pytest-zero-collected.txt': [pytestRanNoTests, 5, true],
  'pytest-test-file-zero-tests.txt': [pytestRanNoTests, 5, true],
  'pytest-one-test.txt': [pytestRanNoTests, 0, false],
  // Ruby (captured)
  'minitest-load-no-test-files.txt': [minitestLoadRanNoTests, 0, true],
  'minitest-zero-runs.txt': [minitestLoadRanNoTests, 0, true],
  'minitest-one-run.txt': [minitestLoadRanNoTests, 0, false],
  'rspec-no-spec-files.txt': [rspecRanNoTests, 0, true],
  'rspec-zero-examples.txt': [rspecRanNoTests, 0, true],
  'rspec-one-example.txt': [rspecRanNoTests, 0, false],
  // PHP (captured)
  'phpunit-no-tests-executed.txt': [phpunitRanNoTests, 0, true],
  'phpunit-one-test.txt': [phpunitRanNoTests, 0, false],
  // TS/JS (captured)
  'jest-zero-tests.txt': [tsRanNoTests, 0, true],
  'jest-related-zero-tests.txt': [tsRanNoTests, 0, true],
  'jest-via-npm-script-zero-tests.txt': [tsRanNoTests, 0, true],
  'jest-one-test-stdout.txt': [tsRanNoTests, 0, false],
  'vitest-run-zero-files.txt': [tsRanNoTests, 0, true],
  'vitest-related-zero-files.txt': [tsRanNoTests, 0, true],
  'vitest-run-one-test.txt': [tsRanNoTests, 0, false],
  'vitest-related-one-test.txt': [tsRanNoTests, 0, false],
  'node-test-zero-tests.txt': [tsRanNoTests, 0, true],
  // Go (documented)
  'go-module-no-test-files.txt': [goTestRanNoTests, 0, true],
  'go-no-tests-to-run.txt': [goTestRanNoTests, 0, true],
  'go-one-package-with-tests.txt': [goTestRanNoTests, 0, false],
  'go-cached-pass.txt': [goTestRanNoTests, 0, false],
  // Swift (documented)
  'swift-no-test-target.txt': [swiftTestRanNoTests, 1, true],
  'swift-xctest-zero.txt': [swiftTestRanNoTests, 0, true],
  'swift-testing-ran-xctest-zero.txt': [swiftTestRanNoTests, 0, false],
  // Gradle (documented)
  'gradle-test-no-source.txt': [gradleTestRanNoTests, 0, true],
  'gradle-test-executed.txt': [gradleTestRanNoTests, 0, false],
  'gradle-multiproject-one-ran.txt': [gradleTestRanNoTests, 0, false],
  'gradle-custom-test-task-ran.txt': [gradleTestRanNoTests, 0, false],
};

describe('per-pack zero-tests recognisers on real runner output', () => {
  it('every fixture file is covered by a case (no silently unused capture)', () => {
    const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'));
    expect(files.sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const [file, [recognise, code, expected]] of Object.entries(CASES)) {
    it(`${file} → ${expected ? 'no-tests' : 'tests ran'}`, () => {
      expect(recognise({ code, output: fixture(file) })).toBe(expected);
    });
  }

  it('a failing run is never no-tests, whatever its output says', () => {
    // A non-zero exit carries a real verdict for every recogniser except
    // the documented zero-test exit codes (pytest 5, MTP 8, SwiftPM's
    // no-test-target error, PHPUnit failOnEmptyTestSuite).
    const failing: Array<[Recogniser, string]> = [
      [dotnetTestRanNoTests, 'dotnet10-web-sln-no-test-project.txt'],
      [cargoTestRanNoTests, 'cargo-lib-zero-tests.txt'],
      [rspecRanNoTests, 'rspec-zero-examples.txt'],
      [minitestLoadRanNoTests, 'minitest-load-no-test-files.txt'],
      [tsRanNoTests, 'jest-zero-tests.txt'],
      [goTestRanNoTests, 'go-module-no-test-files.txt'],
      [gradleTestRanNoTests, 'gradle-test-no-source.txt'],
    ];
    for (const [r, f] of failing) expect(r({ code: 1, output: fixture(f) })).toBe(false);
    expect(pytestRanNoTests({ code: 1, output: fixture('pytest-zero-collected.txt') })).toBe(false);
    expect(phpunitRanNoTests({ code: 2, output: fixture('phpunit-no-tests-executed.txt') })).toBe(
      false,
    );
  });

  it('a .NET run in a CLI language dxkit cannot read is never guessed as zero', () => {
    // No English restore/test marker, no summary dxkit understands: keep the
    // plain verdict (false-negative bias).
    expect(dotnetTestRanNoTests({ code: 0, output: '  Wiederherstellung abgeschlossen.\n' })).toBe(
      false,
    );
    expect(dotnetTestRanNoTests({ code: 0, output: '' })).toBe(false);
  });
});

// ── 2. wiring + declared exemptions ────────────────────────────────────────

/** Packs whose floor declares NO recogniser, each with the reason. A pack
 *  absent from both tables below fails the coverage assertion. */
const NO_TESTS_EXEMPT: Record<string, string> = {
  abap: 'the ABAP floor runs no tests at all: affectedTests is null by design',
};
/** JVM packs share one provider: Gradle carries a recogniser, Maven does not
 *  (the floor runs `mvn -q`, which hides surefire's "No tests to run."). */
const MAVEN_EXEMPT_REASON = 'mvn -q prints the same nothing for an empty and a passing run';

const tmpDirs: string[] = [];
function repo(files: Record<string, string>, executables: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-no-tests-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const rel of executables) fs.chmodSync(path.join(dir, rel), 0o755);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** pack id → [minimal repo, the recogniser its full-scope command must carry]. */
const WIRING: Record<string, () => [string, Recogniser]> = {
  typescript: () => [
    repo(
      {
        'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
        'node_modules/.bin/jest': '#!/bin/sh\n',
      },
      ['node_modules/.bin/jest'],
    ),
    tsRanNoTests,
  ],
  python: () => [
    repo(
      {
        'pytest.ini': '[pytest]\n',
        '.venv/bin/python': '#!/bin/sh\n',
        '.venv/bin/pytest': '#!/bin/sh\n',
      },
      ['.venv/bin/python', '.venv/bin/pytest'],
    ),
    pytestRanNoTests,
  ],
  csharp: () => [repo({ 'App.sln': '' }), dotnetTestRanNoTests],
  go: () => [repo({ 'go.mod': 'module example.com/app\n' }), goTestRanNoTests],
  rust: () => [repo({ 'Cargo.toml': '[package]\nname = "app"\n' }), cargoTestRanNoTests],
  kotlin: () => [repo({ 'build.gradle.kts': '' }), gradleTestRanNoTests],
  java: () => [repo({ 'build.gradle': '' }), gradleTestRanNoTests],
  ruby: () => [repo({ Gemfile: "gem 'rspec'\n" }), rspecRanNoTests],
  swift: () => [repo({ 'Package.swift': '' }), swiftTestRanNoTests],
  php: () => [
    repo({ 'phpunit.xml': '<phpunit/>', 'vendor/bin/phpunit': '#!/bin/sh\n' }, [
      'vendor/bin/phpunit',
    ]),
    phpunitRanNoTests,
  ],
};

function fullScopeTestCommand(p: LanguageSupport, cwd: string): CorrectnessCommand | null {
  // The builder is invoked only to READ the command (never spawned); the
  // arch-check confines builder calls to the runner, hence the annotation.
  return p.correctness.affectedTests({ cwd, changedFiles: [], scope: 'full' }); // correctness-runner-ok
}

describe('every pack decides how it recognises "ran zero tests"', () => {
  it('every built-in pack is either wired or a declared exemption', () => {
    for (const p of LANGUAGES) {
      expect(
        p.id in WIRING || p.id in NO_TESTS_EXEMPT,
        `${p.id}: add a ranNoTests recogniser (or a reasoned exemption)`,
      ).toBe(true);
    }
    for (const reason of [...Object.values(NO_TESTS_EXEMPT), MAVEN_EXEMPT_REASON]) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  for (const [id, build] of Object.entries(WIRING)) {
    it(`${id}: the affected-tests command carries its recogniser`, () => {
      const pack = LANGUAGES.find((p) => p.id === id)!;
      const [cwd, recogniser] = build();
      const cmd = fullScopeTestCommand(pack, cwd);
      expect(cmd, `${id} built no command in its minimal repo`).not.toBeNull();
      expect(cmd!.ranNoTests).toBe(recogniser);
    });
  }

  it('ruby minitest repos carry the load recogniser', () => {
    const ruby = LANGUAGES.find((p) => p.id === 'ruby')!;
    const cmd = fullScopeTestCommand(ruby, repo({ Gemfile: "gem 'minitest'\n" }));
    expect(cmd!.ranNoTests).toBe(minitestLoadRanNoTests);
  });

  it('a TS test script that is a pipeline carries no recogniser (an earlier runner may have run tests)', () => {
    const ts = LANGUAGES.find((p) => p.id === 'typescript')!;
    const cwd = repo(
      {
        'package.json': JSON.stringify({ scripts: { test: 'jest && vitest run' } }),
        'node_modules/.bin/vitest': '#!/bin/sh\n',
      },
      ['node_modules/.bin/vitest'],
    );
    const cmd = fullScopeTestCommand(ts, cwd);
    expect(cmd).not.toBeNull();
    expect(cmd!.ranNoTests).toBeUndefined();
  });

  it('a Maven build carries no recogniser (declared exemption)', () => {
    const java = LANGUAGES.find((p) => p.id === 'java')!;
    const cmd = fullScopeTestCommand(java, repo({ 'pom.xml': '<project/>' }));
    expect(cmd).not.toBeNull();
    expect(cmd!.ranNoTests).toBeUndefined();
  });
});

// ── 3. the runner ──────────────────────────────────────────────────────────

function synthetic(id: string, test: CorrectnessCommand, syntax?: CorrectnessCommand) {
  return {
    id,
    correctness: {
      execution: () => ({
        hosts: ['any' as const],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none' as const,
        weight: 'cheap' as const,
      }),
      syntaxCheck: () => syntax ?? null,
      affectedTests: () => test,
    },
  } as unknown as LanguageSupport;
}

const testCmd: CorrectnessCommand = {
  label: 'affected-tests',
  bin: 'dotnet',
  args: ['test'],
  ranNoTests: dotnetTestRanNoTests,
};
const build: CorrectnessCommand = { label: 'build', bin: 'dotnet', args: ['build'] };
const webSln = fixture('dotnet10-web-sln-no-test-project.txt');

function floor(
  output: string,
  code = 0,
  opts: { syntax?: boolean; scope?: 'full' | 'affected' } = {},
): CorrectnessFloorResult {
  const exec: CommandExec = (c) =>
    c.args[0] === 'build'
      ? { available: true, code: 0, output: '' }
      : { available: true, code, output };
  return runCorrectnessFloor({
    cwd: '/repo',
    changedFiles: [],
    scope: opts.scope ?? 'full',
    packs: [synthetic('csharp', testCmd, opts.syntax ? build : undefined)],
    exec,
  });
}

describe('the runner records no-tests as its own result', () => {
  it('the field case: dotnet test on a web app solution is no-tests, not pass', () => {
    const r = floor(webSln);
    expect(r.checks.map((c) => c.status)).toEqual(['no-tests']);
    expect(r.ran).toBe(false); // nothing produced a verdict
    expect(r.blocks).toBe(false); // and nothing blocks
  });

  it('beside a passing build: ran (the build), not blocking, never "all checks passed"', () => {
    const r = floor(webSln, 0, { syntax: true });
    expect(r.checks.map((c) => c.status)).toEqual(['pass', 'no-tests']);
    expect(r.ran).toBe(true);
    expect(r.blocks).toBe(false);
    expect(describeCorrectnessFloor(r)).not.toContain('all checks passed');
    expect(describeCorrectnessFloor(r)).toContain('no tests ran');
  });

  it('a run that executed tests stays pass (precision)', () => {
    const r = floor(fixture('dotnet10-xunit-one-test.txt'));
    expect(r.checks[0].status).toBe('pass');
    expect(describeCorrectnessFloor(r)).toBe('correctness floor: all checks passed');
  });

  it("pytest's exit 5 is no-tests, not a blocking failure", () => {
    const py = synthetic('python', {
      label: 'affected-tests',
      bin: 'python',
      args: ['-m', 'pytest'],
      ranNoTests: pytestRanNoTests,
    });
    const r = runCorrectnessFloor({
      cwd: '/repo',
      changedFiles: [],
      scope: 'full',
      packs: [py],
      exec: () => ({ available: true, code: 5, output: fixture('pytest-zero-collected.txt') }),
    });
    expect(r.checks[0].status).toBe('no-tests');
    expect(r.blocks).toBe(false);
  });

  it('a throwing recogniser keeps the plain verdict', () => {
    const r = runCorrectnessFloor({
      cwd: '/repo',
      changedFiles: [],
      scope: 'full',
      packs: [
        synthetic('csharp', {
          ...testCmd,
          ranNoTests: () => {
            throw new Error('boom');
          },
        }),
      ],
      exec: () => ({ available: true, code: 0, output: webSln }),
    });
    expect(r.checks[0].status).toBe('pass');
  });

  it('the disclosure is scope-aware: affected says "for this change"', () => {
    expect(describeNoTestsRan(floor(webSln, 0, { scope: 'affected' }))[0]).toContain(
      'no tests ran for this change',
    );
    expect(describeNoTestsRan(floor(webSln))[0]).toContain('the test command found zero tests');
  });
});

// ── 4. every renderer and recorder ─────────────────────────────────────────

describe('no surface reads a no-tests floor as green', () => {
  const withBuild = (): CorrectnessFloorResult => floor(webSln, 0, { syntax: true });

  it('floor check (ci): summary, PR-comment markdown and annotations disclose it', () => {
    const exec: CommandExec = (c) => ({
      available: true,
      code: 0,
      output: c.args[0] === 'build' ? '' : webSln,
    });
    const outcome = runFloorForSurface({
      surface: 'ci',
      cwd: '/repo',
      exec,
      packs: [synthetic('csharp', testCmd, build)],
      resolveEnabled: () => ({ enabled: true, reason: 'test' }),
    });
    expect(outcome.blocks).toBe(false);
    expect(outcome.summary).toContain('no tests ran');
    expect(outcome.summary).not.toContain('all checks passed');
    const md = floorDisclosureMarkdown(outcome);
    expect(md).toContain('NO TESTS RAN');
    expect(githubAnnotations(outcome).some((a) => a.startsWith('::warning'))).toBe(true);
  });

  it('floor check with ONLY a no-tests check names it, never "toolchain not present"', () => {
    const outcome = runFloorForSurface({
      surface: 'ci',
      cwd: '/repo',
      exec: () => ({ available: true, code: 0, output: webSln }),
      packs: [synthetic('csharp', testCmd)],
      resolveEnabled: () => ({ enabled: true, reason: 'test' }),
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.summary).toContain('no tests ran');
    expect(outcome.summary).not.toContain('toolchain not present');
  });

  it('the loop ledger records no_tests, never pass', () => {
    expect(floorLedgerStatuses(withBuild()).tests_status).toBe('no_tests');
    expect(floorLedgerStatuses(withBuild()).typecheck_status).toBe('pass');
  });

  it('the loop Stop-gate line names it (and a vanished suite as such)', () => {
    const result = withBuild();
    const check = result.checks[1];
    expect(
      describeFloorNoTests({
        kind: 'ran',
        result,
        netNew: [],
        noTests: [{ check, transition: 'base-unobserved' }],
      }),
    ).toContain('no tests ran');
    expect(
      describeFloorNoTests({
        kind: 'ran',
        result,
        netNew: [],
        noTests: [{ check, transition: 'tests-vanished', baseStatus: 'pass' }],
      }),
    ).toContain('NONE ran now');
  });

  it('the loop entry snapshot keeps no-tests as an observation', () => {
    const dir = repo({});
    writeFloorBaseline(dir, withBuild(), null);
    expect(readFloorBaseline(dir)!.checks.map((c) => c.status)).toEqual(['pass', 'no-tests']);
  });

  it('the lanes PR-body ledger never says green or passed', () => {
    const entry = renderFloorVerification(withBuild(), undefined, 'entry').join('\n');
    expect(entry).not.toMatch(/\*\*green\*\*/);
    expect(entry).toContain('no tests ran');
    const attributed = renderFloorVerification(withBuild(), [], 'entry').join('\n');
    expect(attributed).not.toMatch(/\*\*passed\*\*/);
    expect(attributed).toContain('no tests ran');
  });

  it('a work order about a failing check is not closed by its tests disappearing', () => {
    const verdict = floorOrderDone(
      ['csharp:affected-tests'],
      [{ pack: 'csharp' as never, label: 'affected-tests', status: 'no-tests' }],
    );
    expect(verdict.open).toEqual(['csharp:affected-tests']);
  });
});
