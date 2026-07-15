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

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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

/**
 * What determines what the findings EXTENSIONS on this repo can see
 * (CLAUDE.md Rule 19), as recall inputs on the shared `custom-check` kind.
 *
 * The input is each extension's MANIFEST — its declared engine, output path,
 * and gating — deliberately NOT its snapshot content. The snapshot IS the
 * finding set being diffed, so hashing it would make every real net-new
 * finding move its own recall input, label itself "drift", and switch the gate
 * off exactly when it should fire. What legitimately changes recall is the
 * extension being reconfigured or upgraded, which is what the manifest records.
 *
 * The residue this does NOT catch: a snapshot refreshed by a NEWER engine under
 * an unchanged manifest (Snyk bumping its rules between two refreshes) still
 * reads as the developer's fault. Closing it needs the engine version stamped
 * INTO the wire doc, which is an SDK schema change (`findings.v1` is frozen —
 * Rule 18), so it is a deliberate follow-up, not an oversight.
 */
export function extensionRecallInputs(cwd: string): Record<string, string> {
  const { extensions } = discoverExtensions(cwd);
  const out: Record<string, string> = {};
  for (const ext of extensions) {
    if (!isProducerExtension(ext)) continue;
    if (ext.manifest.contributes !== 'findings') continue;
    if (ext.manifest.gating === 'off') continue;
    try {
      const raw = fs.readFileSync(path.join(cwd, ext.dir, 'extension.json'), 'utf-8');
      out[`${EXTENSION_CHECK_PREFIX}${ext.manifest.name}/manifest`] = createHash('sha1')
        .update(raw)
        .digest('hex')
        .slice(0, 16);
    } catch {
      /* an unreadable manifest contributes no input — the gate must not fail
         a repo over an optional artifact (same fail-open posture as the
         findings gather above). */
    }
  }
  return out;
}
