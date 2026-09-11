/**
 * Bounded command execution — the ONE spawn + wall-clock-timeout + fail-open
 * primitive shared by every "run a repo command and fold its exit into a
 * pass/fail signal" surface (the correctness floor AND the custom-check gate
 * runner). Extracted so those two do not each carry their own copy of the
 * fail-open-on-missing-binary / fail-open-on-timeout dance (CLAUDE.md Rule 2 —
 * one concept, one code path).
 *
 * Policy, in one place. The through-line: dxkit only reports what it actually
 * OBSERVED. Every arm where observation failed is fail-OPEN, because a claim
 * dxkit cannot ground is worse than no claim at all.
 *   - a missing binary is fail-OPEN (`available: false`) — the toolchain isn't
 *     installed here, so the check is skipped, never failed. A hook must not
 *     block a developer who hasn't installed a linter locally; CI is the backstop.
 *   - a timeout is fail-OPEN (`timedOut: true`) — a SLOW command is not a BROKEN
 *     one; the run didn't finish, so it says nothing.
 *   - an output overflow is fail-OPEN (`overflowed: true`) — the output is a
 *     fragment, so any count derived from it would be fiction.
 *   - a non-zero exit from a command that RAN is a real signal — `code` carries it.
 *   - `output` is the COMPLETE stream. Renderers truncate for display; parsers
 *     get everything. This module never hands out a fragment it hasn't flagged.
 *
 * Execution is injected into the runners (they accept a `CommandExec`), so tests
 * exercise the runner policy without a real toolchain; this module supplies the
 * real PATH-resolving + `execFileSync` implementation.
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { hostOf } from '../../execution/environment';
import { resolveOnPath } from './runner';

/** The minimum a runnable command needs: a binary + its args. Both the
 *  correctness floor's `CorrectnessCommand` and the custom-check runner's
 *  command shape structurally satisfy this. */
export interface RunnableCommand {
  readonly bin: string;
  readonly args: readonly string[];
  /**
   * Text piped to the child's stdin (the extension runner's config
   * payload). Absent → stdin is ignored, exactly as before this field
   * existed; the correctness floor and custom-check callers never set it.
   */
  readonly stdin?: string;
}

/**
 * ONE resolution of a command's `bin` to the file the spawn will run (Rule
 * 2.30: the probe and the spawn read the same answer, never two rules). A bare
 * name is resolved on PATH (`tsc`, `cargo`, `npx`, `eslint`) honoring
 * `%PATHEXT%` on Windows; a path-like `bin` (a pack that resolved an absolute
 * interpreter, a project venv's `python`, a `findTool` path, `./gradlew`) is
 * accepted when the file exists and is executable. Without the latter, a
 * resolved-path bin would be wrongly treated as missing and the check skipped
 * (fail-open on a tool that IS present), so this keeps the fail-open gate
 * honest.
 *
 * `path: null` carries WHY, for disclosure (never a silent skip, Rule 20),
 * distinguishing the actionable case: the file exists but is not executable,
 * which has a one-line repo-side remedy.
 *
 * The class this closes (#364): the probe found `npx.cmd` through the PATHEXT
 * walk and reported it available, then the spawn ran the BARE name with no
 * shell. Windows cannot exec a `.cmd` that way, so the child ENOENTed and the
 * runner disclosed "npx is not on PATH" for a binary that was. Every
 * `bin: 'npx'` builder (the TS floor's typecheck and affected-tests, the TS
 * lint gate) was skipped on every Windows machine, structurally. The spawn now
 * runs the RESOLVED path this function returns.
 */
export type BinResolution =
  | { readonly path: string; readonly reason?: undefined }
  | { readonly path: null; readonly reason: string };

function isPathLike(bin: string): boolean {
  return bin.includes('/') || bin.includes(path.sep);
}

export function resolveCommandBin(bin: string, cwd?: string): BinResolution {
  if (isPathLike(bin)) {
    // A relative bin (`./gradlew`) is relative to the COMMAND's cwd, not
    // dxkit's process cwd: the two differ under the Stop-gate and any
    // multi-repo caller.
    const resolved = cwd ? path.resolve(cwd, bin) : bin;
    let isFile = false;
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) return { path: null, reason: `${bin} not found` };
    // Present but not RUNNABLE is not available: a committed wrapper script
    // without the executable bit (`git add gradlew` from Windows) spawns
    // EACCES in ~0ms, which used to read as "compile failed" with empty
    // output: an environment problem reported as broken code.
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
    } catch {
      return {
        path: null,
        reason: `${bin} exists but is not executable — restore the executable bit (chmod +x ${bin}; committed to git: git update-index --chmod=+x ${bin})`,
      };
    }
    return { path: resolved };
  }
  const found = resolveOnPath(bin);
  return found === null ? { path: null, reason: `${bin} is not on PATH` } : { path: found };
}

/** Is a command's `bin` runnable? The boolean projection of `resolveCommandBin`. */
export function binaryAvailable(bin: string, cwd?: string): boolean {
  return resolveCommandBin(bin, cwd).path !== null;
}

/** WHY a bin is unavailable, for disclosure: the reason projection of
 *  `resolveCommandBin`. For a bin that DOES resolve it names the file. */
export function explainUnavailable(bin: string, cwd?: string): string {
  const r = resolveCommandBin(bin, cwd);
  return r.path === null ? r.reason : `${bin} resolves to ${r.path}`;
}

/**
 * What the OS is asked to run for a resolved binary: the file plus its argv.
 *
 * On every host but Windows, and for a native executable on Windows
 * (`node.exe`, `git.exe`, `dotnet.exe`), the resolved path is spawned
 * directly with the args verbatim: no shell, so no quoting hazards.
 *
 * A `.cmd` / `.bat` file (npm's `npx.cmd` / `npm.cmd` shims, every
 * `node_modules/.bin/*.cmd`) is a batch script, and CreateProcess cannot run
 * one: it needs the command interpreter. dxkit runs it as
 * `cmd.exe /d /s /c "<line>"`, the same form Node's own `shell: true` builds
 * (`/d` skips AutoRun, `/s` strips exactly the outer quotes of `<line>`), and
 * passes the argv VERBATIM (`windowsVerbatimArguments`) so Node does not
 * re-quote the assembled line into something cmd.exe cannot parse. This is
 * the ONE place that form lives; every runner sharing this primitive (the
 * correctness floor, the custom-check gate, the install executor, the
 * dep-bump lane) inherits it.
 */
export interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  /** True only on the cmd.exe route: the assembled line must reach cmd.exe untouched. */
  readonly windowsVerbatimArguments?: boolean;
}

const CMD_SCRIPT = /\.(cmd|bat)$/i;

/**
 * Quote one argument for a `cmd.exe /c` line that hands it on to a batch
 * shim. The rule, in full:
 *   - an argument with no whitespace, no `"` and no cmd metacharacter
 *     (`& | < > ^ ( ) % !`) is passed as-is: flags, paths, globs, rule ids;
 *   - anything else is wrapped in double quotes, inside which cmd.exe leaves
 *     `& | < > ^ ( )` alone, with an embedded `"` escaped as `\"` and the
 *     backslashes before it doubled (the CommandLineToArgvW convention the
 *     re-spawned node process parses). `%` / `!` cannot be escaped through a
 *     batch file, so a `%NAME%`-shaped argument is a documented limit, not a
 *     silent corruption: it is quoted, and stays literal unless NAME is set.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

export function spawnPlanFor(
  resolved: string,
  args: readonly string[],
  host = hostOf(),
): SpawnPlan {
  if (host === 'windows' && CMD_SCRIPT.test(resolved)) {
    const line = [resolved, ...args].map(quoteForCmd).join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: resolved, args };
}

/** `execFileSync`'s options, with the `windowsVerbatimArguments` flag Node
 *  documents for it but `@types/node` omits from the sync signature. */
export type RawSpawnOptions = ExecFileSyncOptionsWithStringEncoding & {
  readonly windowsVerbatimArguments?: boolean;
};

/** The raw spawn under the exec, injectable so the Windows route is provable
 *  on any host (a test hands in a fake CreateProcess); production is Node's
 *  `execFileSync`. */
export type RawSpawn = (file: string, args: string[], options: RawSpawnOptions) => string;

/** Outcome of running one command:
 *  - `available:false`  → the binary isn't on PATH (fail-open skip);
 *  - `timedOut:true`    → the command exceeded its wall-clock budget (fail-open);
 *  - `overflowed:true`  → the child outran the capture buffer, so `output` is a
 *    FRAGMENT (fail-open — see below);
 *  - otherwise `code` is the exit status and `output` is the command's COMPLETE
 *    combined output.
 *
 * `output` is always the WHOLE stream, never a tail. Truncation is a DISPLAY
 * concern and belongs to whoever renders a block message (`tail()` below); a
 * capture primitive that silently truncates hands its consumers a fragment they
 * cannot distinguish from the real thing. That shipped: the custom-check gate
 * regex-parsed the last 4 KB of a 2.6 MB eslint run and reported 20 of 18,615
 * findings, and because the baseline and the guardrail share this path the
 * window slid between runs and minted false net-new findings.
 */
export interface CommandOutcome {
  readonly available: boolean;
  readonly timedOut?: boolean;
  readonly overflowed?: boolean;
  readonly code: number;
  readonly output: string;
}

export type CommandExec = (cmd: RunnableCommand, cwd: string) => CommandOutcome;

/** Capture ceiling. Reaching it is `overflowed` (fail-open), never a silent cut:
 *  a fragment dxkit cannot measure is a fragment dxkit must not draw conclusions
 *  from. */
const MAX_CAPTURE = 64 * 1024 * 1024;

const OUTPUT_TAIL = 4000; // display cap — applied by RENDERERS, never at capture

/**
 * Build a command exec bounded by an optional per-command wall-clock timeout.
 * On timeout the child is killed and the outcome is `timedOut` (fail-open),
 * distinct from a non-zero exit (a real failure, fail-closed). `timeoutMs`
 * undefined/0 → no timeout (CI, where the full suite is expected to run).
 */
export function makeCommandExec(timeoutMs?: number, spawn: RawSpawn = execFileSync): CommandExec {
  return (cmd, cwd) => {
    // ONE resolution, reused by the spawn: the file the probe found is the
    // file that runs, so "available" and "spawnable" cannot disagree (#364).
    const resolution = resolveCommandBin(cmd.bin, cwd);
    if (resolution.path === null) {
      return { available: false, code: -1, output: resolution.reason };
    }
    const plan = spawnPlanFor(resolution.path, cmd.args);
    try {
      const out = spawn(plan.file, [...plan.args], {
        cwd,
        encoding: 'utf-8',
        stdio: [cmd.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
        maxBuffer: MAX_CAPTURE,
        ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGTERM' } : {}),
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      return { available: true, code: 0, output: out };
    } catch (e) {
      const err = e as {
        status?: number;
        code?: string;
        signal?: string;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const combined = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      // execFileSync sets `code: 'ETIMEDOUT'` (and signal = killSignal) when it
      // fired the timeout kill. Treat that as a fail-OPEN skip, not a failure —
      // the run didn't finish, so it says nothing about the check.
      if (err.code === 'ETIMEDOUT') {
        return { available: true, timedOut: true, code: -1, output: combined };
      }
      // ENOBUFS: the child outran MAX_CAPTURE, so `combined` is a FRAGMENT cut at
      // an arbitrary byte. Fail-OPEN, exactly like a timeout — dxkit did not read
      // the output, so it has nothing to say about it. Note `err.status` is null
      // here, so the fallthrough below would otherwise code this as exit 1: an
      // infrastructure limit reported as a real command failure, which is the
      // class of bug this module's own policy exists to prevent.
      if (err.code === 'ENOBUFS') {
        return { available: true, overflowed: true, code: -1, output: combined };
      }
      // A spawn-level errno (EACCES / ENOENT / EPERM / ENOTDIR — status is not
      // a number, no signal, and the child produced no output) means the
      // command never RAN. That is infrastructure, not broken code: fail-OPEN
      // as unavailable, with the errno named so the skip is disclosed. Without
      // this, a non-executable ./gradlew "failed the compile" in 0.2s with
      // empty output on a real onboarding gate. The disclosure names the
      // RESOLVED file (and the interpreter it went through), never "not on
      // PATH": the probe found it, so that would blame the wrong thing.
      if (
        typeof err.status !== 'number' &&
        !err.signal &&
        typeof err.code === 'string' &&
        combined === ''
      ) {
        const via = plan.file === resolution.path ? '' : ` via ${plan.file}`;
        return {
          available: false,
          code: -1,
          output: `${cmd.bin} could not be executed (${err.code}): ${resolution.path}${via}`,
        };
      }
      // A non-numeric status otherwise (non-timeout signal) is treated as a
      // failure with code 1 — the binary existed (binaryAvailable passed), the
      // run started, and it broke.
      return {
        available: true,
        code: typeof err.status === 'number' ? err.status : 1,
        output: combined,
      };
    }
  };
}

/** Default exec: resolve on PATH, run unbounded, capture combined output tail. */
export const defaultCommandExec: CommandExec = makeCommandExec();

/** Trim + tail-truncate captured output so a block message stays readable. */
export function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
}
