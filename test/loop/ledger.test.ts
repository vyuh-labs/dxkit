import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendLedgerEvent,
  buildLedgerEvent,
  clearLedger,
  readLedger,
  summarizeLedger,
  LEDGER_FILE,
  type LedgerEvent,
} from '../../src/loop/ledger';

/**
 * The ledger is the audit trail for "what did the loop do?" Tests pin
 * the append/read round-trip, corrupt-line tolerance, and the
 * per-session repair-after-block detection that headlines the
 * Loop-Safety study.
 */
function ev(over: Partial<LedgerEvent>): LedgerEvent {
  return buildLedgerEvent('/tmp/x', {
    session_id: 's1',
    cwd: '/tmp/x',
    branch: 'main',
    commit: 'abc',
    guardrail_status: 'pass',
    net_new_findings: 0,
    baseline_findings: 10,
    files_changed: 0,
    allowed: true,
    stop_hook_active: false,
    tests_status: 'not_configured',
    lint_status: 'not_configured',
    typecheck_status: 'not_configured',
    duration_ms: 1,
    ...over,
  });
}

describe('loop ledger', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ledger-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends and reads events round-trip, creating the dir', () => {
    expect(readLedger(dir)).toEqual([]);
    appendLedgerEvent(dir, ev({ allowed: true }));
    appendLedgerEvent(dir, ev({ allowed: false, guardrail_status: 'fail', net_new_findings: 2 }));
    const events = readLedger(dir);
    expect(events).toHaveLength(2);
    expect(events[1].net_new_findings).toBe(2);
    expect(fs.existsSync(path.join(dir, LEDGER_FILE))).toBe(true);
  });

  it('tolerates a corrupt line without losing the rest', () => {
    appendLedgerEvent(dir, ev({}));
    fs.appendFileSync(path.join(dir, LEDGER_FILE), 'not json\n');
    appendLedgerEvent(dir, ev({ net_new_findings: 5, allowed: false, guardrail_status: 'fail' }));
    const events = readLedger(dir);
    expect(events).toHaveLength(2);
  });

  it('clear removes the ledger', () => {
    appendLedgerEvent(dir, ev({}));
    expect(clearLedger(dir)).toBe(true);
    expect(readLedger(dir)).toEqual([]);
    expect(clearLedger(dir)).toBe(false); // nothing left to clear
  });

  it('counts a repair only when a clean stop follows a block in the same session', () => {
    const events = [
      ev({ session_id: 's1', allowed: false, guardrail_status: 'fail', net_new_findings: 1 }),
      ev({ session_id: 's1', allowed: true, guardrail_status: 'pass', stop_hook_active: true }),
    ];
    const s = summarizeLedger(events);
    expect(s.blocked).toBe(1);
    expect(s.netNewBlocked).toBe(1);
    expect(s.repairedAfterBlock).toBe(1);
    expect(s.unrepairedSessions).toBe(0);
  });

  it('counts an unrepaired session when a block is never followed by a clean stop', () => {
    const events = [
      ev({ session_id: 's2', allowed: false, guardrail_status: 'fail', net_new_findings: 3 }),
      ev({ session_id: 's2', allowed: false, guardrail_status: 'fail', net_new_findings: 3 }),
    ];
    const s = summarizeLedger(events);
    expect(s.repairedAfterBlock).toBe(0);
    expect(s.unrepairedSessions).toBe(1);
  });

  it('a clean stop BEFORE any block is not a repair', () => {
    const events = [
      ev({ session_id: 's3', allowed: true, guardrail_status: 'pass' }),
      ev({ session_id: 's3', allowed: false, guardrail_status: 'fail', net_new_findings: 1 }),
    ];
    const s = summarizeLedger(events);
    expect(s.repairedAfterBlock).toBe(0);
    expect(s.unrepairedSessions).toBe(1);
  });
});
