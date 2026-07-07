/**
 * `vyuh-dxkit metrics` CLI (#33 Layer 1) — the thin renderer over the ledger.
 * Pins: it reads `.dxkit/loop/ledger.jsonl`, `--json` emits the schema-tagged
 * report, `--since` accepts an ISO date, an empty ledger is a friendly no-op,
 * and an unresolvable `--since` degrades to all-history (never throws).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMetrics } from '../src/metrics-cli';

const tmps: string[] = [];
function mkRepo(lines: object[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-metrics-'));
  tmps.push(d);
  if (lines.length > 0) {
    fs.mkdirSync(path.join(d, '.dxkit', 'loop'), { recursive: true });
    fs.writeFileSync(
      path.join(d, '.dxkit', 'loop', 'ledger.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
  }
  return d;
}
function ev(p: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    timestamp: '2026-06-22T10:00:00Z',
    event: 'Stop',
    session_id: 's',
    cwd: '/x',
    branch: 'feat',
    commit: 'abc',
    guardrail_status: 'pass',
    net_new_findings: 0,
    baseline_findings: 0,
    files_changed: 0,
    allowed: true,
    stop_hook_active: false,
    tests_status: 'skipped',
    lint_status: 'not_configured',
    typecheck_status: 'not_configured',
    duration_ms: 1,
    ...p,
  };
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function capture(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...a) => void chunks.push(a.map(String).join(' ')));
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((s: string | Uint8Array) => (chunks.push(String(s)), true));
  return fn()
    .then(() => chunks.join(''))
    .finally(() => {
      log.mockRestore();
      out.mockRestore();
    });
}

describe('runMetrics', () => {
  it('emits the schema-tagged report as JSON', async () => {
    const d = mkRepo([
      ev({
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 2,
        categories: { secret: 2 },
      }),
    ]);
    const out = await capture(() => runMetrics(d, { json: true }));
    const r = JSON.parse(out);
    expect(r.schema).toBe('metrics.v1');
    expect(r.interceptions).toBe(2);
    expect(r.blockedByCategory).toEqual([{ category: 'secret', count: 2 }]);
  });

  it('is a friendly no-op on an empty ledger', async () => {
    const d = mkRepo([]);
    const out = await capture(() => runMetrics(d, {}));
    expect(out).toMatch(/no loop-gate activity/i);
  });

  it('filters by an ISO --since date', async () => {
    const d = mkRepo([
      ev({
        timestamp: '2026-06-15T09:00:00Z',
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 5,
      }),
      ev({
        timestamp: '2026-06-25T09:00:00Z',
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 2,
      }),
    ]);
    const out = await capture(() => runMetrics(d, { since: '2026-06-20', json: true }));
    const r = JSON.parse(out);
    expect(r.events).toBe(1);
    expect(r.interceptions).toBe(2);
    expect(r.since).toMatch(/2026-06-20/);
  });

  it('degrades to all-history when --since is unresolvable (never throws)', async () => {
    const d = mkRepo([
      ev({
        allowed: false,
        guardrail_status: 'fail',
        net_new_findings: 1,
        categories: { code: 1 },
      }),
    ]);
    const out = await capture(() => runMetrics(d, { since: 'not-a-ref-or-date', json: true }));
    const r = JSON.parse(out);
    expect(r.since).toBeNull(); // unresolved → no label
    expect(r.events).toBe(1); // ...and no filter applied
  });
});
