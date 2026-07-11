/**
 * Committed-snapshot reading — the OFFLINE half of the extension contract.
 *
 * Gates, reports, and untrusted runs never execute an extension; they read
 * the committed snapshot its last refresh wrote (the `served.json`
 * architecture generalized). The snapshot file IS the wire document (plus
 * the runner's additive `generatedAt` stamp), so it round-trips through the
 * same registry parse path as a live emission — one validation code path.
 *
 * Staleness is DISCLOSED, never fatal: an old snapshot degrades a
 * consumer's confidence wording, not its availability (the flow-freshness
 * discipline). A missing or invalid snapshot is likewise a disclosed state
 * the consumer folds into its own honesty channel.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WireDoc } from '@vyuhlabs/dxkit-sdk';
import { parseWireDocText } from './contributions';
import type { ProducerExtension } from './manifest';

export type ExtensionSnapshot =
  | {
      readonly status: 'ok';
      readonly doc: WireDoc;
      readonly schemaId: string;
      /** ISO timestamp the runner stamped, when present. */
      readonly generatedAt?: string;
      /** Whole days since generatedAt (0 for today); undefined when unstamped. */
      readonly ageDays?: number;
    }
  | { readonly status: 'missing'; readonly outputPath: string }
  | { readonly status: 'invalid'; readonly errors: readonly string[] };

export function readExtensionSnapshot(
  cwd: string,
  ext: ProducerExtension,
  now: () => Date = () => new Date(),
): ExtensionSnapshot {
  const abs = path.join(cwd, ext.manifest.output);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf-8');
  } catch {
    return { status: 'missing', outputPath: ext.manifest.output };
  }
  const parsed = parseWireDocText(ext.manifest.contributes, text);
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };

  let generatedAt: string | undefined;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    generatedAt = typeof raw['generatedAt'] === 'string' ? raw['generatedAt'] : undefined;
  } catch {
    /* unreachable — parseWireDocText already parsed */
  }
  let ageDays: number | undefined;
  if (generatedAt) {
    const t = Date.parse(generatedAt);
    if (!Number.isNaN(t)) {
      ageDays = Math.max(0, Math.floor((now().getTime() - t) / 86_400_000));
    }
  }
  return { status: 'ok', doc: parsed.doc, schemaId: parsed.schemaId, generatedAt, ageDays };
}
