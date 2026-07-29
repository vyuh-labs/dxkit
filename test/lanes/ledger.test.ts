import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendLaneEvent,
  readLaneEvents,
  computeDelivered,
  laneLedgerPath,
  LANE_LEDGER_SCHEMA_VERSION,
  type LaneEvent,
} from '../../src/lanes/ledger';

/**
 * The delivered count is the sellable ROI number, so its integrity rules are
 * pinned hard: one file per standing-PR identity (no cross-lane merge
 * conflicts), fail-open reads (a corrupt line or a newer-schema event is
 * skipped, never a crash and never a misreading), and the reducer's
 * per-lane/per-kind arithmetic. The merged-means-delivered property itself
 * is structural (the entry rides the PR diff — pinned in the lane tests);
 * here we pin everything the reducer claims about what it read.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-lanes-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function event(partial: Partial<LaneEvent> & { lane: string }): LaneEvent {
  return {
    schema_version: LANE_LEDGER_SCHEMA_VERSION,
    timestamp: '2026-07-01T00:00:00.000Z',
    outcome: 'landed',
    ...partial,
  } as LaneEvent;
}

describe('ledger files', () => {
  it('one file per standing-PR identity — lanes and tasks never share', () => {
    expect(laneLedgerPath('dep-bump')).toBe('.dxkit/lanes/dep-bump.jsonl');
    expect(laneLedgerPath('remediate', 'fix-vulns')).toBe('.dxkit/lanes/remediate-fix-vulns.jsonl');

    appendLaneEvent(repo, event({ lane: 'dep-bump' }));
    appendLaneEvent(repo, event({ lane: 'remediate', task: 'fix-vulns' }));
    expect(
      readFileSync(join(repo, '.dxkit/lanes/dep-bump.jsonl'), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
    expect(readLaneEvents(repo)).toHaveLength(2);
  });

  it('append returns the repo-relative path the caller commits', () => {
    const rel = appendLaneEvent(repo, event({ lane: 'remediate', task: 'fix-lint' }));
    expect(rel).toBe('.dxkit/lanes/remediate-fix-lint.jsonl');
  });

  it('reads fail-open: corrupt lines and newer-schema events are skipped', () => {
    const rel = appendLaneEvent(repo, event({ lane: 'dep-bump' }));
    appendFileSync(join(repo, rel), 'not json at all\n', 'utf8');
    appendFileSync(
      join(repo, rel),
      JSON.stringify({ ...event({ lane: 'dep-bump' }), schema_version: 99 }) + '\n',
      'utf8',
    );
    expect(readLaneEvents(repo)).toHaveLength(1);
  });

  it('an absent lanes directory reads as empty, never a crash', () => {
    expect(readLaneEvents(repo)).toEqual([]);
  });
});

describe('computeDelivered', () => {
  it('sums per lane: landed, partial, findings closed by kind, spend', () => {
    const events: LaneEvent[] = [
      event({ lane: 'dep-bump', findingsClosed: [{ kind: 'dep-vuln', count: 7 }] }),
      event({
        lane: 'dep-bump',
        timestamp: '2026-07-08T00:00:00.000Z',
        findingsClosed: [{ kind: 'dep-vuln', count: 3 }],
      }),
      event({
        lane: 'remediate',
        task: 'fix-vulns',
        timestamp: '2026-07-09T00:00:00.000Z',
        costUsd: 2.5,
        driver: 'claude-code',
      }),
      event({
        lane: 'remediate',
        task: 'fix-lint',
        timestamp: '2026-07-10T00:00:00.000Z',
        costUsd: 0.4,
        partial: true,
      }),
    ];
    const d = computeDelivered(events);
    expect(d.events).toBe(4);
    expect(d.lanes).toEqual([
      {
        lane: 'dep-bump',
        landed: 2,
        partial: 0,
        findingsClosed: { 'dep-vuln': 10 },
      },
      {
        lane: 'remediate',
        landed: 2,
        partial: 1,
        findingsClosed: {},
        costUsd: 2.9,
      },
    ]);
    expect(d.totalCostUsd).toBe(2.9);
    expect(d.span).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-10T00:00:00.000Z',
    });
  });

  it('windows on sinceMs, and omits cost fields when no lane reports spend', () => {
    const events: LaneEvent[] = [
      event({ lane: 'dep-bump', timestamp: '2026-07-01T00:00:00.000Z' }),
      event({ lane: 'dep-bump', timestamp: '2026-07-20T00:00:00.000Z' }),
    ];
    const d = computeDelivered(events, { sinceMs: Date.parse('2026-07-10') });
    expect(d.events).toBe(1);
    expect(d.lanes[0].costUsd).toBeUndefined();
    expect(d.totalCostUsd).toBeUndefined();
  });

  it('an empty ledger reduces to zero events and no lanes', () => {
    expect(computeDelivered([])).toEqual({ events: 0, span: {}, lanes: [] });
  });
});

describe('the merged-means-delivered write points', () => {
  it('the dep-bump lane includes the ledger file in its landed paths', () => {
    // Pinned at the source level: the lane's land call must carry the ledger
    // path alongside the manifest+lockfile so the event rides the SAME PR.
    const src = readFileSync(join(__dirname, '../../src/deps-bump/run.ts'), 'utf8');
    expect(src).toContain('appendLaneEvent');
    expect(src).toMatch(/paths: \[\.\.\.bumpArtifactPaths\(pm\), ledgerRel\]/);
  });

  it('the remediate landing commits the ledger before the push', () => {
    const src = readFileSync(join(__dirname, '../../src/remediate/land.ts'), 'utf8');
    const commitAt = src.indexOf("exec('git', ['add', opts.ledgerPath])");
    expect(commitAt).toBeGreaterThan(-1);
    // the push CALL (not the import line) comes after the ledger commit
    expect(commitAt).toBeLessThan(src.lastIndexOf('internalGitPushArgs('));
  });
});
