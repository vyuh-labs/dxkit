/**
 * Tool runner utilities -- safe command execution and output parsing.
 */
import { execSync } from 'child_process';
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
