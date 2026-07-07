/**
 * `vyuh-dxkit receipt` — the PR signals block (#26). These tests exercise the
 * REUSE path: with a fresh verdict pre-seeded into the cache under the repo's
 * own resolved policy, `receipt` replays it without running a gather, and emits
 * ready-to-paste markdown. (The run-fresh path is the guardrail check's own
 * covered path plus the verdict-cache write, tested separately.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runReceipt } from '../src/receipt-cli';
import { writeVerdict } from '../src/baseline/verdict-cache';
import { loadPolicyFromCwd } from '../src/baseline/policy';

const tmps: string[] = [];
function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-receipt-'));
  tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  fs.writeFileSync(path.join(d, 'app.js'), 'const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: d });
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Seed the verdict cache under the repo's OWN resolved policy so `receipt`
 *  finds it fresh. */
function seed(cwd: string, markdown: string, blocks = false): void {
  writeVerdict(cwd, loadPolicyFromCwd(cwd), {
    blocks,
    warns: false,
    blockingCount: blocks ? 1 : 0,
    warningCount: 0,
    markdown,
    ranAt: '2026-07-06T00:00:00.000Z',
  });
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  // markdown output goes via process.stdout.write; --json via console.log.
  const wSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  const lSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(' '));
  });
  return fn()
    .then(() => chunks.join(''))
    .finally(() => {
      wSpy.mockRestore();
      lSpy.mockRestore();
    });
}

describe('receipt — reuse path', () => {
  it('replays the cached verdict markdown, plus a provenance comment', async () => {
    const d = mkRepo();
    seed(d, '## Guardrail: PASSED\n\nNo changes from baseline.');
    const out = await captureStdout(() => runReceipt(d));
    expect(out).toContain('## Guardrail: PASSED');
    expect(out).toContain('reused cached verdict');
  });

  it('--json emits the structured receipt with cached=true', async () => {
    const d = mkRepo();
    seed(d, '## Guardrail: PASSED');
    const out = await captureStdout(() => runReceipt(d, { json: true }));
    const parsed = JSON.parse(out) as { schema: string; verdict: string; cached: boolean };
    expect(parsed.schema).toBe('receipt.v1');
    expect(parsed.verdict).toBe('PASSED');
    expect(parsed.cached).toBe(true);
  });

  it('reflects a BLOCKED verdict from the cache', async () => {
    const d = mkRepo();
    seed(d, '## Guardrail: BLOCKED', true);
    const out = await captureStdout(() => runReceipt(d, { json: true }));
    expect(JSON.parse(out).verdict).toBe('BLOCKED');
  });

  it('notes when --since score movement is unavailable (unreachable ref)', async () => {
    const d = mkRepo();
    seed(d, '## Guardrail: PASSED');
    // A ref that does not exist → computeScoreMovement returns null → the
    // receipt discloses the omission rather than silently dropping it.
    const out = await captureStdout(() => runReceipt(d, { since: 'origin/does-not-exist' }));
    expect(out).toContain('Health score movement');
    expect(out).toContain('unavailable');
  });
});
