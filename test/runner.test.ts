import { describe, it, expect } from 'vitest';
import { parseJsonStream, runDetached } from '../src/analyzers/tools/runner';

describe('parseJsonStream', () => {
  it('parses concatenated single-line objects', () => {
    const out = parseJsonStream('{"a":1}\n{"b":2}\n');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses pretty-printed multi-line objects (govulncheck shape)', () => {
    const raw = `{
  "config": {
    "version": "v1.0.0"
  }
}
{
  "finding": {
    "osv": "GO-2025-1"
  }
}`;
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ config: { version: 'v1.0.0' } }, { finding: { osv: 'GO-2025-1' } }]);
  });

  it('handles strings containing braces without breaking the parser', () => {
    const raw = '{"x": "hello } world", "y": 1}\n{"z": "{nested}"}';
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ x: 'hello } world', y: 1 }, { z: '{nested}' }]);
  });

  it('handles escaped quotes in strings', () => {
    const raw = String.raw`{"q": "she said \"hi\""}`;
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ q: 'she said "hi"' }]);
  });

  it('handles deeply nested objects', () => {
    const raw = '{"a":{"b":{"c":{"d":1}}}}';
    const out = parseJsonStream(raw);
    expect(out).toEqual([{ a: { b: { c: { d: 1 } } } }]);
  });

  it('skips malformed segments and continues parsing', () => {
    const raw = '{"ok":1}\n{not-json}\n{"ok":2}';
    const out = parseJsonStream(raw);
    // The malformed segment '{not-json}' fails JSON.parse and is dropped;
    // the parser continues with the next balanced block.
    expect(out).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('returns empty array on empty input', () => {
    expect(parseJsonStream('')).toEqual([]);
    expect(parseJsonStream('   \n\n  ')).toEqual([]);
  });

  it('ignores leading/trailing non-JSON text', () => {
    const raw = 'preamble noise\n{"a":1}\ntrailing junk';
    expect(parseJsonStream(raw)).toEqual([{ a: 1 }]);
  });
});

describe('runDetached — process group lifecycle (10k.1.5c regression)', () => {
  it('returns clean exit + captured stdout on success', async () => {
    const outcome = await runDetached('printf', ['hello'], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe('hello');
    expect(outcome.timedOut).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const outcome = await runDetached('sh', ['-c', 'printf out; printf err >&2'], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe('out');
    expect(outcome.stderr).toBe('err');
  });

  it('SIGKILLs the entire process group on timeout, including grandchildren', async () => {
    // sh -c 'sleep 30 & wait' spawns sleep as a grandchild. If runDetached
    // only killed the immediate sh child (default execSync timeout
    // behaviour), the wait would block until sleep finishes 30s later.
    // With process-group SIGKILL, both sh and sleep die at once and we
    // return in ~200ms.
    const start = Date.now();
    const outcome = await runDetached('sh', ['-c', 'sleep 30 & wait'], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(outcome.timedOut).toBe(true);
    // 2-second budget covers test-runner overhead while keeping the
    // assertion strict enough to fail loudly if process-group kill
    // regresses (would block for 30s).
    expect(elapsed).toBeLessThan(2000);
  });

  it('handles spawn-time errors gracefully (no throw)', async () => {
    const outcome = await runDetached('this-command-does-not-exist-xyz', [], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    // ENOENT path → resolves with empty stdout. No throw.
    expect(outcome.stdout).toBe('');
    expect(outcome.timedOut).toBe(false);
  });

  it('passes argv through without shell interpretation', async () => {
    // No shell expansion of `$HOME`, `*`, etc. — args reach the binary
    // verbatim. Important for osv-scanner paths that may contain `$` or
    // glob characters. Use node directly (bypasses PATH-binary
    // discovery quirks that surfaced under v8 coverage instrumentation
    // when this used `printf`).
    const outcome = await runDetached(
      'node',
      ['-e', 'process.stdout.write(process.argv[1])', '$HOME and *'],
      { cwd: process.cwd(), timeoutMs: 5000 },
    );
    expect(outcome.stdout).toBe('$HOME and *');
  });
});
