/**
 * The TS/JS pack's TEST ENTRY POINT: which command this repo runs its tests
 * through, derived from the repo's own evidence, and the affected-tests
 * invocation the correctness floor builds from it (#377). A sibling of
 * `typescript.ts` (Rule 6: every fact here is a TS/JS ecosystem fact) split
 * out at the module-size bar; the pack's `affectedTests` builder is its only
 * consumer.
 *
 * The class this closes: the floor used to run whichever runner binary sat
 * in `node_modules/.bin` (vitest, then jest). On a create-react-app repo the
 * authoritative entry point is `react-scripts test`, and jest is present
 * only as a hoisted transitive dependency with no root config, so a bare
 * `jest` failed for dxkit's OWN invocation reasons (no transforms, no
 * environment) and the floor read that as failing tests. A remediation
 * agent then "fixed" the floor by adding a `jest.config.js` that recreated
 * CRA's config, and the ledger could not tell that from a real test fix.
 * A runner that cannot start in the repo's shape is an infrastructure skip
 * (disclosed, with the command tried), never a code failure.
 *
 * Order of evidence, strongest first:
 *   1. an explicit `scripts.test` in package.json (the contract the repo
 *      publishes itself). A known runner named there runs in its native
 *      form with the script's own flags carried; a runner reached through an
 *      env prefix, a compound command, or positional arguments runs THROUGH
 *      the script via the repo's package manager (`npm test -- <args>`), so
 *      the script's shape is preserved; any other wrapper (mocha, node
 *      --test, bun test, a shell script) runs as the script, full suite;
 *   2. a runner DECLARED in package.json dependencies (react-scripts, vitest,
 *      jest) or a runner config file (vitest.config.*, jest.config.*, a
 *      `jest` key), when no test script is declared;
 *   3. a runner binary that is merely installed (hoisted, undeclared,
 *      unconfigured) is NOT an entry point: dxkit discloses that it cannot
 *      start the tests and names the command it would have tried;
 *   4. nothing at all: no test command, nothing to run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { detectPackageManager, runScriptArgv } from '../package-manager';

/** The runners whose affected-file selection dxkit knows how to phrase. */
export type KnownTestRunner = 'cra' | 'vitest' | 'jest';

/** The binary a known runner's presence is gated on. */
const RUNNER_BIN: Record<KnownTestRunner, string> = {
  cra: 'react-scripts',
  vitest: 'vitest',
  jest: 'jest',
};

/** How the entry point was found, for disclosure and for tests that pin
 *  the evidence order. */
export type TsTestEntryEvidence = 'test-script' | 'declared-dependency' | 'config-file';

export interface TsTestEntry {
  readonly evidence: TsTestEntryEvidence;
  /** The runner named, or null for a wrapper dxkit cannot phrase selection
   *  for (it runs as the script, full suite). */
  readonly runner: KnownTestRunner | null;
  /** `native`: `npx --no-install <runner>` with the script's flags carried.
   *  `script`: through the repo's `test` script via its package manager. */
  readonly via: 'native' | 'script';
  /** The script's own tokens after the runner name (native mode carries
   *  them; script mode leaves them inside the script). */
  readonly extras: readonly string[];
  /** The raw test script, when one decided the entry point. */
  readonly script?: string;
}

export type TsTestEntryResolution =
  | { readonly kind: 'entry'; readonly entry: TsTestEntry }
  | {
      readonly kind: 'cannot-start';
      readonly reason: string;
      /** The command dxkit would have run, for the disclosure. */
      readonly tried: { readonly bin: string; readonly args: readonly string[] };
    }
  | { readonly kind: 'none' };

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  jest?: unknown;
}

function readPackageJson(cwd: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function hasLocalBin(cwd: string, bin: string): boolean {
  const dir = path.join(cwd, 'node_modules', '.bin');
  return fs.existsSync(path.join(dir, bin)) || fs.existsSync(path.join(dir, `${bin}.cmd`));
}

function hasDependencyTree(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, 'node_modules'));
}

const VITEST_CONFIGS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map((e) => `vitest.config.${e}`);
const JEST_CONFIGS = ['js', 'ts', 'mjs', 'cjs', 'json'].map((e) => `jest.config.${e}`);

/** npm's scaffold placeholder: a declared script that declares nothing. */
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
/** A script with any of these is a shell pipeline dxkit runs as the
 *  script, never re-derives as a bare binary. */
const SHELL_OPERATORS = /(\|\||&&|[|;<>`]|\$\()/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Command words that run no test runner at all. */
const NO_RUNNER_WORDS = new Set(['echo', 'exit', 'true', 'false', ':']);
/** Interactive / watch flags the floor must never inherit from a script. */
const INTERACTIVE_FLAGS = new Set(['--watch', '--watchAll', '--ui', '--open']);

/** The boundaries between the commands of a shell pipeline. */
const COMMAND_SEPARATORS = /&&|\|\||;|\|/;

interface ParsedTestScript {
  readonly runner: KnownTestRunner | null;
  readonly extras: readonly string[];
  /** The runner is reached through an env prefix or `cross-env`, so a bare
   *  binary would drop the environment the script sets. */
  readonly prefixed: boolean;
  /** Shell operators or quoting: only the shell can run this faithfully. */
  readonly compound: boolean;
  /** A bare positional argument (a path filter, a subcommand) the script
   *  passes its runner; a flag's value (`--config x`) is not one. */
  readonly positional: boolean;
  /** Every command in the script is inert (`echo`, `exit`): no runner runs. */
  readonly noRunner: boolean;
}

function parseTestScript(script: string): ParsedTestScript {
  const compound = SHELL_OPERATORS.test(script) || /["']/.test(script);
  // A package manager appends forwarded arguments to the END of the script,
  // so in a pipeline only the LAST command can receive a selection; that is
  // the command whose runner counts.
  const segments = script.split(COMMAND_SEPARATORS).map(commandTokens);
  const { tokens, prefixed } = segments[segments.length - 1];
  // "Runs no runner" is a verdict on the WHOLE script: `jest && echo done`
  // runs jest, so only a script whose every command is inert qualifies.
  const noRunner = segments.every((s) => NO_RUNNER_WORDS.has(s.tokens[0] ?? ''));
  const word = tokens[0] ?? '';
  const rest = tokens.slice(1);
  let runner: KnownTestRunner | null = null;
  let extras: readonly string[] = rest;
  if (word === 'react-scripts' && rest[0] === 'test') {
    runner = 'cra';
    extras = rest.slice(1);
  } else if (word === 'vitest') {
    runner = 'vitest';
  } else if (word === 'jest') {
    runner = 'jest';
  }
  const positional = extras.some(
    (t, k) => !t.startsWith('-') && !(k > 0 && /^--?[^=]+$/.test(extras[k - 1])),
  );
  return { runner, extras, prefixed, compound, positional, noRunner };
}

/** One pipeline segment's tokens from its command word on, with the env
 *  prefix (`NAME=value`, `cross-env`) and an `npx` launcher stripped. */
function commandTokens(segment: string): { tokens: string[]; prefixed: boolean } {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  let prefixed = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ENV_ASSIGNMENT.test(t) || t === 'cross-env') {
      prefixed = true;
      i++;
      continue;
    }
    if (t === 'npx' || (t === '--no-install' && i > 0 && tokens[i - 1] === 'npx')) {
      i++;
      continue;
    }
    break;
  }
  return { tokens: tokens.slice(i), prefixed };
}

/**
 * Resolve the repo's test entry point from its own evidence (see the module
 * doc for the order). Pure and read-only: package.json, config filenames,
 * the `node_modules/.bin` shims. Never spawns.
 */
export function resolveTsTestEntryPoint(cwd: string): TsTestEntryResolution {
  const pkg = readPackageJson(cwd);
  const script = typeof pkg?.scripts?.test === 'string' ? pkg.scripts.test.trim() : '';
  if (script !== '' && script !== NPM_PLACEHOLDER) return fromTestScript(cwd, script);

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const declared: KnownTestRunner | null =
    'react-scripts' in deps ? 'cra' : 'vitest' in deps ? 'vitest' : 'jest' in deps ? 'jest' : null;
  if (declared !== null) return gated(cwd, declared, 'declared-dependency', 'package.json');
  const configured: KnownTestRunner | null = VITEST_CONFIGS.some((f) =>
    fs.existsSync(path.join(cwd, f)),
  )
    ? 'vitest'
    : JEST_CONFIGS.some((f) => fs.existsSync(path.join(cwd, f))) || pkg?.jest !== undefined
      ? 'jest'
      : null;
  if (configured !== null) return gated(cwd, configured, 'config-file', 'its config');

  // An installed but undeclared, unconfigured runner (the hoisted transitive
  // jest under react-scripts) is not an entry point: running it bare is the
  // exact invocation gap that read as failing tests.
  for (const runner of ['vitest', 'jest'] as const) {
    if (hasLocalBin(cwd, runner)) {
      return {
        kind: 'cannot-start',
        reason:
          `${runner} is installed only transitively (not declared in package.json, no ` +
          `${runner} config, no test script), so the repo's test entry point is unknown; ` +
          `declare a \`test\` script in package.json`,
        tried: { bin: 'npx', args: ['--no-install', runner] },
      };
    }
  }
  return { kind: 'none' };
}

function fromTestScript(cwd: string, script: string): TsTestEntryResolution {
  const parsed = parseTestScript(script);
  if (parsed.noRunner) {
    return {
      kind: 'cannot-start',
      reason: `the test script runs no test runner (\`${script}\`); declare one in package.json`,
      tried: { bin: 'npm', args: ['test'] },
    };
  }
  if (parsed.runner === null) {
    // A wrapper dxkit cannot phrase selection for: the script IS the entry
    // point, gated on the dependency tree the same way a typecheck script is.
    if (!hasDependencyTree(cwd)) {
      return {
        kind: 'cannot-start',
        reason: `the test script (\`${script}\`) needs the dependency tree and node_modules is missing; install dependencies`,
        tried: { bin: 'npm', args: ['test'] },
      };
    }
    return {
      kind: 'entry',
      entry: { evidence: 'test-script', runner: null, via: 'script', extras: [], script },
    };
  }
  const bin = RUNNER_BIN[parsed.runner];
  if (!hasLocalBin(cwd, bin)) {
    return {
      kind: 'cannot-start',
      reason: `the test script names ${bin} (\`${script}\`) but node_modules/.bin/${bin} is missing; install dependencies`,
      tried: { bin: 'npx', args: ['--no-install', bin] },
    };
  }
  const via = parsed.prefixed || parsed.compound || parsed.positional ? 'script' : 'native';
  return {
    kind: 'entry',
    entry: {
      evidence: 'test-script',
      runner: parsed.runner,
      via,
      extras: via === 'native' ? parsed.extras.filter((t) => !INTERACTIVE_FLAGS.has(t)) : [],
      script,
    },
  };
}

/** A declared or configured runner, gated on its binary being installed. */
function gated(
  cwd: string,
  runner: KnownTestRunner,
  evidence: TsTestEntryEvidence,
  where: string,
): TsTestEntryResolution {
  const bin = RUNNER_BIN[runner];
  if (!hasLocalBin(cwd, bin)) {
    return {
      kind: 'cannot-start',
      reason: `${bin} is declared by ${where} but node_modules/.bin/${bin} is missing; install dependencies`,
      tried: { bin: 'npx', args: ['--no-install', bin] },
    };
  }
  return { kind: 'entry', entry: { evidence, runner, via: 'native', extras: [] } };
}

/** CRA's default outside CI is watch mode; both flags pass through to jest. */
const CRA_NON_INTERACTIVE = ['--watchAll=false', '--ci'];

/**
 * The native argv (after `npx`) that makes a known runner run the affected
 * subset (or the full suite) non-interactively, with the script's own flags
 * carried. `--passWithNoTests` keeps "no related test" a PASS: a source
 * change with no covering test is a coverage concern (the finding gate's
 * job), not a liveness failure. jest's `--findRelatedTests` consumes every
 * following positional as its file list, so the script's flags go before
 * the selection and the changed files stay last; vitest's `related`
 * subcommand must lead, so the flags follow it and precede the file list.
 */
function nativeArgs(
  runner: KnownTestRunner,
  extras: readonly string[],
  affected: readonly string[] | null,
): string[] {
  const related = affected !== null ? ['--findRelatedTests', ...affected] : [];
  switch (runner) {
    case 'cra':
      return [
        '--no-install',
        'react-scripts',
        'test',
        ...extras,
        ...CRA_NON_INTERACTIVE,
        '--passWithNoTests',
        ...related,
      ];
    case 'jest':
      return ['--no-install', 'jest', ...extras, '--passWithNoTests', ...related];
    case 'vitest':
      return affected !== null
        ? [
            '--no-install',
            'vitest',
            'related',
            '--run',
            '--passWithNoTests',
            ...extras,
            ...affected,
          ]
        : ['--no-install', 'vitest', 'run', '--passWithNoTests', ...extras];
  }
}

/**
 * The arguments appended to the repo's `test` script when a known runner
 * is reached THROUGH the script (an env prefix, a compound command,
 * positional arguments): the same selection, forwarded by the package
 * manager. A vitest script may already carry a subcommand (`vitest run`),
 * so through a script the floor runs the full suite non-interactively
 * instead of `related`.
 */
function scriptArgs(runner: KnownTestRunner, affected: readonly string[] | null): string[] {
  const related = affected !== null ? ['--findRelatedTests', ...affected] : [];
  switch (runner) {
    case 'cra':
      return [...CRA_NON_INTERACTIVE, '--passWithNoTests', ...related];
    case 'jest':
      return ['--passWithNoTests', ...related];
    case 'vitest':
      return ['--run', '--passWithNoTests'];
  }
}

/** The command the floor runs, or the disclosed reason it cannot. */
export type TsAffectedTestsInvocation =
  | { readonly bin: string; readonly args: readonly string[]; readonly cannotStart?: undefined }
  | { readonly bin: string; readonly args: readonly string[]; readonly cannotStart: string };

/**
 * Build the affected-tests invocation for the resolved entry point.
 * `affected` is the changed TS/JS file list on the fast surface, or null
 * for the full suite. Returns null when the repo has no test command at all
 * (nothing to run); a runner that cannot start comes back with `cannotStart`
 * set and the command tried in `bin` / `args`, so the runner discloses it
 * instead of spawning.
 */
export function tsAffectedTestsInvocation(
  cwd: string,
  affected: readonly string[] | null,
): TsAffectedTestsInvocation | null {
  const resolved = resolveTsTestEntryPoint(cwd);
  if (resolved.kind === 'none') return null;
  if (resolved.kind === 'cannot-start') {
    return { bin: resolved.tried.bin, args: resolved.tried.args, cannotStart: resolved.reason };
  }
  const { entry } = resolved;
  if (entry.via === 'native' && entry.runner !== null) {
    return { bin: 'npx', args: nativeArgs(entry.runner, entry.extras, affected) };
  }
  const extra = entry.runner !== null ? scriptArgs(entry.runner, affected) : [];
  const [bin, ...args] = runScriptArgv(detectPackageManager(cwd), 'test', extra);
  return { bin, args };
}
