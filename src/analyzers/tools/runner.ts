/**
 * Tool runner utilities -- safe command execution and output parsing.
 */
import { execFileSync, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Parse a stream of concatenated JSON objects (e.g. govulncheck's
 * pretty-printed `-json` output, where each top-level object spans many
 * lines and isn't single-line ndjson). Walks the input character by
 * character, tracking brace depth while ignoring braces inside string
 * literals and respecting backslash escapes. Each balanced `{...}` block
 * gets handed to `JSON.parse`; parse failures are dropped silently so
 * non-JSON noise (banner lines, trailing whitespace) doesn't poison the
 * stream.
 */
export function parseJsonStream(raw: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          /* skip non-JSON segments */
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Run a command and return stdout. Returns empty string on failure. */
export function run(cmd: string, cwd: string, timeoutMs = 30000): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      // Node's default `maxBuffer` is 1MB. Tools that produce large
      // outputs on enterprise codebases (jscpd's 25MB report on
      // the .NET WinForms benchmark, semgrep on a huge ruleset, gitleaks on a leaky
      // repo, npm audit on deep dep trees) silently truncated past
      // that cap pre-fix — execSync threw `ENOBUFS`, the catch below
      // returned empty string, and the calling gather function
      // reported the tool as "unavailable" with reason "no output."
      // 64MB handles the enterprise-scale observation (25MB) plus
      // ~2x headroom without inviting runaway-tool memory explosion.
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err: unknown) {
    // Some tools (npm audit) write valid output to stdout even on non-zero exit
    const e = err as { stdout?: string };
    if (e.stdout && typeof e.stdout === 'string') {
      return e.stdout.trim();
    }
    return '';
  }
}

/**
 * Like `run`, but the caller sees the EXIT CODE alongside stdout. For tools
 * whose non-zero exits are ambiguous: osv-scanner exits 1 both meaning
 * "vulnerabilities found" (output complete) and >1 when the scan itself
 * errored (network/API degradation) — possibly after emitting PARTIAL JSON.
 * `run()` returns that partial stdout indistinguishably from success, which
 * let a degraded scan write a 1-of-14-findings baseline that then false-
 * blocked the next check 13 times (VERIFY-40 F-7). `code` is null when the
 * process never yielded one (spawn failure / timeout).
 */
export function runWithExit(
  cmd: string,
  cwd: string,
  timeoutMs = 30000,
): { code: number | null; stdout: string } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    return { code: 0, stdout };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number | null };
    return {
      code: typeof e.status === 'number' ? e.status : null,
      stdout: typeof e.stdout === 'string' ? e.stdout.trim() : '',
    };
  }
}

/**
 * Run a binary directly (NO shell) and return stdout, or '' on failure.
 *
 * Synchronous sibling of `runDetached` for single-binary tools that must
 * stay on a synchronous call path (e.g. the memoized `gatherGitleaksResult`).
 * Because there's no shell, there are no cross-platform quoting hazards:
 * pass the resolved binary path plus an args array and Node hands them to
 * the OS verbatim. This is the portable replacement for building a shell
 * string with single-quotes + `2>/dev/null` — both of which are POSIX-only
 * and break under Windows' cmd.exe (single-quotes don't quote; the
 * redirect writes a stray `nul` file instead of discarding stderr).
 */
export function runFileSync(file: string, args: string[], cwd: string, timeoutMs = 30000): string {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err: unknown) {
    // Mirror `run()`'s graceful degradation: some tools write valid
    // output to stdout even on non-zero exit.
    const e = err as { stdout?: string };
    if (e.stdout && typeof e.stdout === 'string') return e.stdout.trim();
    return '';
  }
}

/** Run a command and return the exit code. */
export function runExitCode(cmd: string, cwd: string, timeoutMs = 60000): number {
  try {
    execSync(cmd, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return 0;
  } catch (err: unknown) {
    const e = err as { status?: number };
    return e.status ?? 1;
  }
}

/** Run a command and parse stdout as JSON. Returns null on failure. */
export function runJSON<T>(cmd: string, cwd: string, timeoutMs = 60000): T | null {
  const output = run(cmd, cwd, timeoutMs);
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

/** Count lines in command output. */
export function countLines(cmd: string, cwd: string): number {
  const output = run(cmd, cwd);
  if (!output) return 0;
  return output.split('\n').filter((l) => l.trim()).length;
}

/**
 * Candidate filename extensions to try for a bare binary name when
 * resolving it against PATH.
 *
 * On POSIX the binary name is used verbatim (`['']`). On Windows an
 * executable is named `git.exe` / `npm.cmd` / `dotnet.exe`, and the
 * shell finds it by appending each entry of `%PATHEXT%`. We replicate
 * that here so a pure-Node PATH walk matches the same files the OS
 * would. If the caller already passed an extension (`foo.exe`), we
 * don't append more.
 */
function pathExtensions(binary: string): string[] {
  if (process.platform !== 'win32') return [''];
  if (path.extname(binary)) return [''];
  const pathext = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const exts = pathext
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  // Try the bare name first (some tools ship extension-less shims),
  // then each PATHEXT candidate.
  return ['', ...exts];
}

/** True when `p` exists, is a regular file, and (on POSIX) is executable. */
function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // Windows has no executable bit; presence + PATHEXT match is enough.
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-platform "where is this binary on PATH?" resolver. Returns the
 * absolute path of the first match, or null.
 *
 * Pure-Node: walks `process.env.PATH` entries and checks each candidate
 * with `fs`, honoring `%PATHEXT%` on Windows. This replaces the prior
 * `which <binary> 2>/dev/null` shell probe, which silently
 * false-negatived EVERY tool on Windows — cmd.exe has no `which` (it's
 * `where`), and `2>/dev/null` is a POSIX redirect that writes a stray
 * `nul` file rather than discarding stderr. The shell probe is also
 * unnecessary: PATH resolution is a filesystem walk that Node can do
 * directly, with no subprocess to spawn.
 */
export function resolveOnPath(binary: string): string | null {
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  return resolveInDirs(binary, dirs);
}

/** Resolve `binary` against an explicit list of directories, honoring
 *  `%PATHEXT%` on Windows. Returns the first matching absolute path, or
 *  null. Used for system probe dirs and user-configured tool paths so
 *  they match `git.exe` / `tool.cmd` on Windows the same way a PATH
 *  walk does. */
export function resolveInDirs(binary: string, dirs: string[]): string | null {
  const exts = pathExtensions(binary);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Check if a command is available on PATH (cross-platform). */
export function commandExists(cmd: string, _cwd?: string): boolean {
  return resolveOnPath(cmd) !== null;
}

/** Check if a file exists relative to cwd. */
export function fileExists(cwd: string, ...paths: string[]): boolean {
  return paths.some((p) => fs.existsSync(path.join(cwd, p)));
}

/**
 * Outcome of a `runDetached` invocation.
 *  - `code` is the child's exit status, `null` if the timeout fired.
 *  - `timedOut` is true when the process group was killed by our timer.
 *  - `stdout`/`stderr` are the captured output up to the kill / exit.
 */
export interface DetachedRunOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run a command in its OWN process group and SIGKILL the whole group on
 * timeout. Solves the orphan-grandchild leak that `execSync(..., {timeout})`
 * has: when execSync's timer fires, it sends SIGTERM to the immediate child,
 * but if that child has already spawned grandchildren (e.g. `osv-scanner fix`
 * → `npm install` → its own subprocesses), the grandchildren stay alive,
 * orphaned to PID 1. They keep eating CPU/memory until they finish or the
 * shell exits.
 *
 * Discovered during 2.4.5 pre-ship regression on dxkit-on-dxkit (10k.1.5c):
 * each `dxkit vulnerabilities` run on a slow target was leaving 1-3 orphan
 * `osv-scanner fix` processes behind, surviving past the dxkit invocation
 * and slowing subsequent steps. Pre-fix, repeated runs accumulated leaks.
 *
 * Mechanism:
 *   - `spawn(cmd, args, { detached: true })` puts the child in its own
 *     process group (its PGID = its PID).
 *   - On timeout, `process.kill(-child.pid, 'SIGKILL')` — the negative PID
 *     means "send to every process in the group", taking grandchildren too.
 *   - We never call `child.unref()` so the parent keeps reference to the
 *     child; the parent shell waits for completion as expected.
 *
 * Returns captured stdout/stderr regardless of how the run ended (timeout
 * still hands back whatever the tool wrote before being killed). Callers
 * that need to distinguish "timeout vs clean exit" check `outcome.timedOut`.
 *
 * Use this whenever a tool may spawn its own subprocesses AND the timeout
 * is short enough that it could fire mid-grandchild. For pure single-binary
 * tools (gitleaks, semgrep), `run()` / `execSync` is fine — no grandchildren
 * means no leak risk.
 */
export async function runDetached(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<DetachedRunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Single-resolve guard. The Promise resolves on exit / error /
    // safety-deadline; whichever fires first wins and the rest are
    // no-ops. Pre-fix the Promise relied solely on `exit` / `error`
    // events — under resource pressure (a JS-heavy customer frontend convergence audit:
    // jscpd + semgrep + graphify all concurrently spawning
    // grandchildren) one of those events occasionally never fired,
    // and the Promise stayed pending forever. Node's event loop then
    // emptied (no more pending operations), beforeExit fired with
    // code=0, and the parent observed a silent rc=0 with no work
    // completed — D134. The settle() wrapper ensures the Promise
    // ALWAYS resolves and the dispatcher above can never hang.
    const settle = (outcome: DetachedRunOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      detached: true, // new process group → enables -pid kill below
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Register error listener BEFORE any other setup so we never miss
    // a synchronous spawn-time emission ('error' fires on ENOENT,
    // EAGAIN under fd/proc exhaustion, EACCES). EventEmitter throws
    // an unhandled-exception if 'error' fires with no listener — the
    // pre-fix late registration could miss the emission window under
    // pressure.
    child.once('error', () => {
      // spawn-time errors (e.g. ENOENT, EAGAIN). Treat as
      // exit-with-no-output; the caller's parser sees an empty stdout
      // and returns its empty result. Matches `run()`'s
      // graceful-degradation convention.
      clearTimeout(timer);
      clearTimeout(safetyTimer);
      settle({ stdout, stderr, code: null, timedOut: false });
    });

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) {
          // Negative PID = "send to every process in the group". Takes
          // grandchildren atomically. SIGKILL chosen over SIGTERM so npm
          // install / mvn / similar JVM tools that ignore SIGTERM during
          // initialization still die. Guarded by try/catch because the
          // child may have exited between our setTimeout fire and the
          // kill call (race we can't avoid; harmless if the group is
          // gone).
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        /* process group already gone — fine */
      }
    }, opts.timeoutMs);

    // Safety deadline: even if every event source fails (a kernel
    // bug, a libuv corner case, an exotic WSL2 scheduling state),
    // resolve the Promise after timeoutMs + 30s grace. The dispatcher
    // up the stack uses Promise.allSettled which collapses any
    // outcome cleanly, so an extra resolve is harmless; what we
    // never want is an unbounded pending Promise. Pre-fix this was
    // the silent-failure shape D134: the orchestrator's spawnSync
    // health child observed rc=0 with no report written because the
    // capabilities Promise.all hung on a runDetached that never
    // settled — Node exited cleanly when the event loop emptied.
    const safetyTimer = setTimeout(() => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        /* process group already gone */
      }
      settle({
        stdout,
        stderr,
        code: null,
        timedOut: true,
      });
    }, opts.timeoutMs + 30_000);

    child.once('exit', (code) => {
      clearTimeout(timer);
      clearTimeout(safetyTimer);
      settle({ stdout, stderr, code, timedOut });
    });
  });
}
