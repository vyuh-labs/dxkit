/**
 * Tool runner utilities -- safe command execution and output parsing.
 */
import { execSync, spawn } from 'child_process';
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

/** Check if a command is available. */
export function commandExists(cmd: string, cwd: string): boolean {
  return run(`which ${cmd} 2>/dev/null`, cwd) !== '';
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
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      detached: true, // new process group → enables -pid kill below
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    let timedOut = false;
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
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', () => {
      // spawn-time errors (e.g. ENOENT). Treat as exit-with-no-output;
      // the caller's parser sees an empty stdout and returns its empty
      // result. Matches `run()`'s graceful-degradation convention.
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut: false });
    });
  });
}
