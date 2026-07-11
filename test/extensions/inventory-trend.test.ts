/**
 * inventory.v1 counts → the report-history trend (#11b lane 4c).
 *
 * The committed snapshot is the store (git history = the per-entity trend
 * substrate); what rides report-history is the cheap aggregate: entity
 * counts by kind, additive on the entry, invisible for repos without
 * inventory extensions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherInventoryCounts } from '../../src/extensions/inventory';
import { parseHistory, type ReportHistoryEntry } from '../../src/reports/history';
import { renderHistoryMarkdown, renderTrendText } from '../../src/reports/render';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-inv-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeInventoryExtension(name: string, entities: unknown[]): void {
  const dir = path.join(tmp, '.dxkit/extensions', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      contributes: 'inventory',
      run: { command: 'python3' },
      refresh: 'on-merge',
      output: `.dxkit/contrib/${name}.json`,
    }),
  );
  const out = path.join(tmp, '.dxkit/contrib', `${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ schema: 'inventory.v1', entities }));
}

describe('gatherInventoryCounts', () => {
  it('counts entities by kind per extension; undefined when none', async () => {
    expect(gatherInventoryCounts(tmp)).toBeUndefined();
    writeInventoryExtension('ui-inventory', [
      { kind: 'screen', name: 'A' },
      { kind: 'screen', name: 'B' },
      { kind: 'permission', name: 'admin.read' },
    ]);
    expect(gatherInventoryCounts(tmp)).toEqual({
      'ui-inventory': { screen: 2, permission: 1 },
    });
  });
});

const SCORES = {
  overall: 80,
  security: 80,
  quality: 80,
  tests: 80,
  documentation: 80,
  maintainability: 80,
  developerExperience: 80,
};

function entry(sha: string, inventory?: ReportHistoryEntry['inventory']): ReportHistoryEntry {
  return {
    sha,
    date: '2026-07-11T00:00:00Z',
    dxkitVersion: '3.5.0',
    scores: SCORES,
    ...(inventory ? { inventory } : {}),
  };
}

describe('history entry + rendering', () => {
  it('parseHistory round-trips the inventory field', async () => {
    const jsonl = [
      JSON.stringify(entry('a'.repeat(40))),
      JSON.stringify(entry('b'.repeat(40), { 'ui-inventory': { screen: 3 } })),
    ].join('\n');
    const parsed = parseHistory(jsonl);
    expect(parsed[0].inventory).toBeUndefined();
    expect(parsed[1].inventory).toEqual({ 'ui-inventory': { screen: 3 } });
  });

  it('renders counts with deltas vs the previous inventory-bearing entry', async () => {
    const entries = [
      entry('a'.repeat(40), { 'ui-inventory': { screen: 210, permission: 890 } }),
      entry('b'.repeat(40), { 'ui-inventory': { screen: 214, permission: 888 } }),
    ];
    const md = renderHistoryMarkdown(entries);
    expect(md).toContain('| ui-inventory | screen | 214 | +4 |');
    expect(md).toContain('| ui-inventory | permission | 888 | -2 |');
    const text = renderTrendText(entries);
    expect(text.join('\n')).toContain(
      'inventory ui-inventory: permission 888 (-2) · screen 214 (+4)',
    );
  });

  it('repos without inventory render nothing extra (zero bloat)', async () => {
    const entries = [entry('a'.repeat(40)), entry('b'.repeat(40))];
    expect(renderHistoryMarkdown(entries)).not.toContain('Inventory');
    expect(renderTrendText(entries).join('\n')).not.toContain('inventory');
  });
});
