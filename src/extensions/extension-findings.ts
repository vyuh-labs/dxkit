/**
 * findings.v1 → the Rule-17 custom-check seam.
 *
 * An extension's findings enter the identity machine as the THIRD consumer
 * of the ONE custom-check seam (user checks + pack lint + extension
 * findings): each wire finding becomes a `CustomCheckFinding` whose check
 * label is `extension:<name>`, so it inherits the ENTIRE native-finding
 * machine — Rule 9 located identity (check + file + lineWindow + rule),
 * the Rule 10 producer, git-aware matching, brownfield grandfathering,
 * allowlist, and the guardrail verdict — with zero new identity wiring.
 * This is Rule 2 applied to gating: a parallel "extension findings"
 * pipeline would fork everything the seam already owns.
 *
 * OFFLINE by construction: this reads committed snapshots via
 * `snapshot.ts`, never executes anything (the runner is refresh-time
 * only), so it is safe on every gate surface including untrusted PRs. A
 * missing or invalid snapshot contributes nothing here — doctor owns that
 * disclosure; the gate must not fail a repo because an optional artifact
 * is absent.
 */

import type { CustomCheckFinding } from '../analyzers/custom-checks/types';
import type { WireFindingsDoc } from '@vyuhlabs/dxkit-sdk';
import { discoverExtensions, isProducerExtension } from './manifest';
import { readExtensionSnapshot } from './snapshot';

/** The check-label namespace extension findings mint under. */
export const EXTENSION_CHECK_PREFIX = 'extension:';

/**
 * Committed findings-extension snapshots as custom-check findings.
 * `gating: 'off'` extensions are excluded entirely; 'block' maps to a
 * blocking finding, 'warn' (the default) to non-blocking — the same
 * block/warn fold every custom check rides through the guardrail.
 */
export function gatherExtensionFindings(cwd: string): readonly CustomCheckFinding[] {
  const { extensions } = discoverExtensions(cwd);
  const out: CustomCheckFinding[] = [];
  for (const ext of extensions) {
    if (!isProducerExtension(ext)) continue;
    if (ext.manifest.contributes !== 'findings') continue;
    if (ext.manifest.gating === 'off') continue;
    const snap = readExtensionSnapshot(cwd, ext);
    if (snap.status !== 'ok') continue;
    const doc = snap.doc as WireFindingsDoc;
    const blocking = ext.manifest.gating === 'block';
    for (const f of doc.findings) {
      out.push({
        check: `${EXTENSION_CHECK_PREFIX}${ext.manifest.name}`,
        blocking,
        file: f.file,
        ...(f.line !== undefined ? { line: f.line } : {}),
        rule: f.rule,
        // Severity is display metadata on this seam (identity never hashes
        // the message — Rule 9); the wire severity rides in front so
        // renderers and humans see it without a schema change.
        message: `[${f.severity}] ${f.message}`,
      });
    }
  }
  return out;
}
