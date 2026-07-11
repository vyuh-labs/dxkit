/**
 * inventory.v1 → the reports trend (entity COUNTS only).
 *
 * The committed inventory snapshot is the store — git history already
 * preserves every past state and any two refs diff for free. What rides
 * the reports pillar is the cheap aggregate: per-extension entity counts
 * by kind, folded into the on-merge report-history entry so
 * `report history` / `metrics` chart them over time exactly as dimension
 * scores (the customer's "screens over time" graph, natively). Full
 * per-entity time-series deliberately stays out — that shape belongs to
 * the org-level product when it lands, not to a per-repo history line.
 *
 * Offline by construction (snapshot reads via the one parse path); absent
 * or invalid snapshots contribute nothing here — doctor owns disclosure.
 */

import type { WireInventoryDoc } from '@vyuhlabs/dxkit-sdk';
import { discoverExtensions, isProducerExtension } from './manifest';
import { readExtensionSnapshot } from './snapshot';

/** `{ 'ui-inventory': { screen: 214, permission: 890 } }` — extension name →
 *  entity kind → count. Undefined when no inventory extension has a readable
 *  snapshot, so history entries stay clean for repos without extensions. */
export type InventoryCounts = Record<string, Record<string, number>>;

export function gatherInventoryCounts(cwd: string): InventoryCounts | undefined {
  const { extensions } = discoverExtensions(cwd);
  const out: InventoryCounts = {};
  let any = false;
  for (const ext of extensions) {
    if (!isProducerExtension(ext)) continue;
    if (ext.manifest.contributes !== 'inventory') continue;
    const snap = readExtensionSnapshot(cwd, ext);
    if (snap.status !== 'ok') continue;
    const doc = snap.doc as WireInventoryDoc;
    const counts: Record<string, number> = {};
    for (const e of doc.entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    out[ext.manifest.name] = counts;
    any = true;
  }
  return any ? out : undefined;
}
