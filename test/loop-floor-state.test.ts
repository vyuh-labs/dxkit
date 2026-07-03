/**
 * Tests for the correctness-floor entry-snapshot ledger (src/loop/floor-state.ts).
 * Verifies the net-new diff: a green base blocks every failure; a red base
 * grandfathers only the checks it was already failing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeFloorBaseline,
  readFloorBaseline,
  clearFloorBaseline,
  netNewFloorFailures,
  checkKey,
  FLOOR_BASELINE_FILE,
} from '../src/loop/floor-state';
import type {
  CorrectnessCheckResult,
  CorrectnessFloorResult,
} from '../src/analyzers/correctness/run';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-floor-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function check(
  pack: string,
  label: string,
  status: CorrectnessCheckResult['status'],
): CorrectnessCheckResult {
  return { pack: pack as CorrectnessCheckResult['pack'], label, bin: 'x', status };
}

function floor(checks: CorrectnessCheckResult[]): CorrectnessFloorResult {
  return {
    ran: checks.some((c) => c.status === 'pass' || c.status === 'fail'),
    checks,
    blocks: checks.some((c) => c.status === 'fail'),
  };
}

describe('floor-state entry snapshot', () => {
  it('round-trips a snapshot, recording only pass/fail (skips omitted)', () => {
    writeFloorBaseline(
      tmp,
      floor([
        check('typescript', 'typecheck', 'pass'),
        check('typescript', 'affected-tests', 'fail'),
        check('go', 'build', 'skipped-unavailable'),
      ]),
      'abc123',
    );
    const b = readFloorBaseline(tmp);
    expect(b?.capturedAtCommit).toBe('abc123');
    expect(b?.checks).toEqual([
      { pack: 'typescript', label: 'typecheck', status: 'pass' },
      { pack: 'typescript', label: 'affected-tests', status: 'fail' },
    ]);
  });

  it('writes to .dxkit/loop/floor-baseline.json', () => {
    writeFloorBaseline(tmp, floor([check('typescript', 'typecheck', 'pass')]), null);
    expect(fs.existsSync(path.join(tmp, '.dxkit', 'loop', FLOOR_BASELINE_FILE))).toBe(true);
  });

  it('green base: every current failure is net-new', () => {
    writeFloorBaseline(
      tmp,
      floor([
        check('typescript', 'typecheck', 'pass'),
        check('typescript', 'affected-tests', 'pass'),
      ]),
      null,
    );
    const b = readFloorBaseline(tmp);
    const netNew = netNewFloorFailures(floor([check('typescript', 'typecheck', 'fail')]), b);
    expect(netNew.map((c) => c.label)).toEqual(['typecheck']);
  });

  it('red base: a pre-existing failing check is grandfathered', () => {
    writeFloorBaseline(tmp, floor([check('typescript', 'affected-tests', 'fail')]), null);
    const b = readFloorBaseline(tmp);
    // Same check still failing → pre-existing, not net-new.
    const netNew = netNewFloorFailures(floor([check('typescript', 'affected-tests', 'fail')]), b);
    expect(netNew).toHaveLength(0);
  });

  it('red base: a DIFFERENT check failing is still net-new', () => {
    writeFloorBaseline(tmp, floor([check('typescript', 'affected-tests', 'fail')]), null);
    const b = readFloorBaseline(tmp);
    const netNew = netNewFloorFailures(
      floor([
        check('typescript', 'affected-tests', 'fail'), // pre-existing
        check('typescript', 'typecheck', 'fail'), // net-new
      ]),
      b,
    );
    expect(netNew.map((c) => checkKey(c.pack, c.label))).toEqual(['typescript:typecheck']);
  });

  it('absent baseline is treated as a green base (all failures net-new)', () => {
    const netNew = netNewFloorFailures(
      floor([check('typescript', 'typecheck', 'fail')]),
      readFloorBaseline(tmp), // null — never captured
    );
    expect(netNew).toHaveLength(1);
  });

  it('malformed baseline reads as null (→ green base)', () => {
    const dir = path.join(tmp, '.dxkit', 'loop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FLOOR_BASELINE_FILE), 'not json');
    expect(readFloorBaseline(tmp)).toBeNull();
  });

  it('clearFloorBaseline removes the snapshot', () => {
    writeFloorBaseline(tmp, floor([check('typescript', 'typecheck', 'pass')]), null);
    clearFloorBaseline(tmp);
    expect(readFloorBaseline(tmp)).toBeNull();
  });
});
