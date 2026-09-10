/**
 * Windows spawn parity for the bounded exec (#364).
 *
 * The class: `binaryAvailable('npx')` honoured PATHEXT and found `npx.cmd`,
 * then the spawn ran the BARE name with no shell. Windows cannot exec a batch
 * script that way, so the child ENOENTed and the floor disclosed "npx is not
 * on PATH" for a binary that was. Every `bin: 'npx'` builder (the TS floor's
 * typecheck + affected-tests, the TS lint gate) was skipped on every Windows
 * machine, structurally, and dxkit's own CI never saw it because the primary
 * lane is ubuntu.
 *
 * The invariant pinned here, the one the issue asks for: for every registered
 * builder that emits a node shim (`npx` / `npm` / `node`), IF the probe says
 * available THEN the spawn does not ENOENT. Proven on any host by forcing
 * `process.platform` to win32, pointing PATH at a fixture holding `npx.cmd` /
 * `npm.cmd` / `node.exe`, and handing the exec a fake CreateProcess that
 * behaves like the real one: it runs `cmd.exe` and absolute `.exe` files, and
 * ENOENTs a bare name or a `.cmd` script. A Linux negative control pins that
 * no cmd.exe route is taken off Windows. The real Windows lane
 * (`windows-detection.yml`) runs `floor check` on a tiny TS fixture for the
 * end-to-end proof.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  makeCommandExec,
  resolveCommandBin,
  spawnPlanFor,
  quoteForCmd,
  type RawSpawn,
  type RunnableCommand,
} from '../../src/analyzers/tools/bounded-exec';
import { LANGUAGES } from '../../src/languages';

const NODE_SHIMS = new Set(['npx', 'npm', 'node']);

/** Run `fn` with `process.platform` temporarily forced to `value`. */
function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    if (orig) Object.defineProperty(process, 'platform', orig);
  }
}

/** Run `fn` with env overrides (undefined deletes), restored afterwards. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function mkdtemp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dxkit-${label}-`));
}

function touch(p: string, content = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly verbatim: boolean;
}

function enoent(file: string): never {
  throw Object.assign(new Error(`spawnSync ${file} ENOENT`), {
    code: 'ENOENT',
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
  });
}

/** A fake Windows CreateProcess: runs the command interpreter and an absolute
 *  `.exe`; ENOENTs a bare name or a batch script handed to it directly. */
function fakeWindowsSpawn(calls: SpawnCall[]): RawSpawn {
  return (file, args, options) => {
    calls.push({ file, args, verbatim: options.windowsVerbatimArguments === true });
    if (/(^|[\\/])cmd\.exe$/i.test(file)) return '';
    if (!path.isAbsolute(file) || !fs.existsSync(file) || !/\.exe$/i.test(file)) enoent(file);
    return '';
  };
}

/** A Windows PATH fixture: npm's shims are batch scripts, node is a native exe. */
function windowsPathDir(): string {
  const dir = mkdtemp('winpath');
  touch(path.join(dir, 'npx.cmd'), '@echo off\r\n');
  touch(path.join(dir, 'npm.cmd'), '@echo off\r\n');
  touch(path.join(dir, 'node.exe'), 'MZ');
  return dir;
}

/** A provisioned TS project as the builders see it on Windows: the local
 *  `.bin` shims are `.cmd` files. `scripts` decides whether the typecheck
 *  builder emits `npm run <script>` or the bare `npx --no-install tsc`. */
function tsProject(scripts?: Record<string, string>): string {
  const cwd = mkdtemp('tsproj');
  touch(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', ...(scripts ? { scripts } : {}) }),
  );
  touch(path.join(cwd, 'tsconfig.json'), '{}');
  touch(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  for (const bin of ['tsc', 'eslint', 'vitest']) {
    touch(path.join(cwd, 'node_modules', '.bin', `${bin}.cmd`), '@echo off\r\n');
  }
  return cwd;
}

interface BuilderCommand {
  readonly source: string;
  readonly cwd: string;
  readonly cmd: RunnableCommand;
}

/** Every command a REGISTERED builder emits for `cwd` whose bin is a node
 *  shim. Registry-driven, so a new pack or builder that emits `npx` joins the
 *  invariant without an edit here. */
function nodeShimCommands(cwd: string): BuilderCommand[] {
  const out: BuilderCommand[] = [];
  const push = (source: string, cmd: RunnableCommand | null | undefined) => {
    if (cmd && NODE_SHIMS.has(cmd.bin)) out.push({ source, cwd, cmd });
  };
  const changedFiles = ['src/a.ts'];
  for (const pack of LANGUAGES) {
    const ctx = { cwd, changedFiles, scope: 'affected' as const };
    push(`${pack.id}.correctness.syntaxCheck`, pack.correctness.syntaxCheck(ctx));
    push(`${pack.id}.correctness.affectedTests`, pack.correctness.affectedTests(ctx));
    push(`${pack.id}.lintGate.lintCommand`, pack.lintGate?.lintCommand({ cwd, changedFiles }));
    push(
      `${pack.id}.lintGate.fixCommand`,
      pack.lintGate?.fixCommand?.({ cwd, files: changedFiles }),
    );
  }
  return out;
}

describe('bounded exec on Windows: the probe and the spawn agree (#364)', () => {
  it('every registered node-shim builder that probes available also spawns (no ENOENT)', () => {
    const pathDir = windowsPathDir();
    const projects = [tsProject(), tsProject({ typecheck: 'tsc -p tsconfig.json' })];
    withPlatform('win32', () =>
      // PATHEXT lowercase: the fixture lives on a case-sensitive filesystem.
      withEnv({ PATH: pathDir, PATHEXT: '.com;.exe;.bat;.cmd' }, () => {
        const commands = projects.flatMap(nodeShimCommands);
        // The known TS surfaces are all present: the invariant has teeth.
        const sources = commands.map((c) => c.source);
        expect(sources).toContain('typescript.correctness.syntaxCheck');
        expect(sources).toContain('typescript.correctness.affectedTests');
        expect(sources).toContain('typescript.lintGate.lintCommand');
        expect(sources).toContain('typescript.lintGate.fixCommand');
        expect(new Set(commands.map((c) => c.cmd.bin))).toEqual(new Set(['npx', 'npm']));

        for (const { source, cwd, cmd } of commands) {
          const resolution = resolveCommandBin(cmd.bin, cwd);
          expect(resolution.path, `${source}: probe`).toMatch(/\.cmd$/);

          const calls: SpawnCall[] = [];
          const outcome = makeCommandExec(undefined, fakeWindowsSpawn(calls))(cmd, cwd);
          expect(outcome, `${source}: spawn`).toMatchObject({ available: true, code: 0 });

          // The route: cmd.exe /d /s /c "<resolved> args", argv verbatim.
          expect(calls).toHaveLength(1);
          const call = calls[0];
          expect(call.file).toMatch(/cmd\.exe$/i);
          expect(call.verbatim).toBe(true);
          expect(call.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
          const line = call.args[3];
          expect(line.startsWith('"')).toBe(true);
          expect(line.endsWith('"')).toBe(true);
          expect(line.slice(1, -1)).toBe(
            [resolution.path as string, ...cmd.args].map(quoteForCmd).join(' '),
          );
        }
      }),
    );
  });

  it('a native .exe on Windows is spawned directly, not through cmd.exe', () => {
    const pathDir = windowsPathDir();
    withPlatform('win32', () =>
      withEnv({ PATH: pathDir, PATHEXT: '.com;.exe;.bat;.cmd' }, () => {
        const calls: SpawnCall[] = [];
        const cmd = { bin: 'node', args: ['-e', 'process.exit(0)'] };
        const outcome = makeCommandExec(undefined, fakeWindowsSpawn(calls))(cmd, pathDir);
        expect(outcome).toMatchObject({ available: true, code: 0 });
        expect(calls).toHaveLength(1);
        expect(calls[0].file).toBe(path.join(pathDir, 'node.exe'));
        expect(calls[0].args).toEqual(cmd.args);
        expect(calls[0].verbatim).toBe(false);
      }),
    );
  });

  it('a spawn that still fails names the resolved file and the errno, never "not on PATH"', () => {
    const pathDir = windowsPathDir();
    withPlatform('win32', () =>
      withEnv({ PATH: pathDir, PATHEXT: '.com;.exe;.bat;.cmd' }, () => {
        const alwaysEnoent: RawSpawn = (file) => enoent(file);
        const outcome = makeCommandExec(undefined, alwaysEnoent)(
          { bin: 'npx', args: ['--no-install', 'tsc'] },
          pathDir,
        );
        expect(outcome.available).toBe(false);
        expect(outcome.output).toMatch(
          /^npx could not be executed \(ENOENT\): .*npx\.cmd via .*cmd\.exe$/i,
        );
        expect(outcome.output).not.toMatch(/not on PATH/);
      }),
    );
  });

  it('a bin absent from PATH still discloses "not on PATH" (the probe-negative path is unchanged)', () => {
    const pathDir = mkdtemp('empty');
    withPlatform('win32', () =>
      withEnv({ PATH: pathDir, PATHEXT: '.com;.exe;.bat;.cmd' }, () => {
        const calls: SpawnCall[] = [];
        const outcome = makeCommandExec(undefined, fakeWindowsSpawn(calls))(
          { bin: 'npx', args: ['--no-install', 'tsc'] },
          pathDir,
        );
        expect(outcome).toEqual({ available: false, code: -1, output: 'npx is not on PATH' });
        expect(calls).toHaveLength(0);
      }),
    );
  });
});

describe('bounded exec off Windows: negative control', () => {
  it('spawns the resolved absolute path directly with the args verbatim (no cmd.exe)', () => {
    if (process.platform === 'win32') return; // POSIX exec-bit semantics
    const pathDir = mkdtemp('posixpath');
    const shim = path.join(pathDir, 'npx');
    touch(shim, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(shim, 0o755);
    withEnv({ PATH: pathDir }, () => {
      const calls: SpawnCall[] = [];
      const record: RawSpawn = (file, args, options) => {
        calls.push({ file, args, verbatim: options.windowsVerbatimArguments === true });
        return '';
      };
      const cmd = { bin: 'npx', args: ['--no-install', 'tsc', '--noEmit'] };
      const outcome = makeCommandExec(undefined, record)(cmd, pathDir);
      expect(outcome).toMatchObject({ available: true, code: 0 });
      expect(calls).toEqual([{ file: shim, args: cmd.args, verbatim: false }]);
    });
  });

  it('a .cmd name on a non-Windows host is not routed through cmd.exe', () => {
    const plan = spawnPlanFor('/opt/tool/run.cmd', ['--x'], 'linux');
    expect(plan).toEqual({ file: '/opt/tool/run.cmd', args: ['--x'] });
  });

  it('the real exec runs the resolved node binary end to end', () => {
    const outcome = makeCommandExec()(
      { bin: 'node', args: ['-e', 'process.stdout.write("resolved-ok")'] },
      process.cwd(),
    );
    expect(outcome).toMatchObject({ available: true, code: 0, output: 'resolved-ok' });
  });
});

describe('quoteForCmd: the documented rule', () => {
  it.each([
    ['tsc', 'tsc'],
    ['--noEmit', '--noEmit'],
    ['src/**/*.ts', 'src/**/*.ts'],
    ['', '""'],
    ['C:\\Program Files\\nodejs\\npx.cmd', '"C:\\Program Files\\nodejs\\npx.cmd"'],
    ['a"b', '"a\\"b"'],
    ['x&y', '"x&y"'],
    ['(paren)', '"(paren)"'],
    ['C:\\dir\\', 'C:\\dir\\'],
    ['C:\\my dir\\', '"C:\\my dir\\\\"'],
    ['back\\\\"q', '"back\\\\\\\\\\"q"'],
  ])('%j -> %s', (input, expected) => {
    expect(quoteForCmd(input)).toBe(expected);
  });

  it('a .cmd plan on Windows assembles the /s-stripped outer quotes around the whole line', () => {
    const plan = spawnPlanFor(
      'C:\\Program Files\\nodejs\\npx.cmd',
      ['--no-install', 'tsc'],
      'windows',
    );
    expect(plan.file).toMatch(/cmd\.exe$/i);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Program Files\\nodejs\\npx.cmd" --no-install tsc"',
    ]);
  });
});
