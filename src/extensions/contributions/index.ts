/**
 * CONTRIBUTION_KINDS — the registry of what an extension can contribute.
 *
 * One entry per contribution kind (contract | inventory | findings |
 * export). Each entry owns its versioned wire readers and its snapshot
 * path convention; the consumer wiring (where a parsed document lands —
 * the flow join, the inventory store, the baseline producer, the export
 * dispatcher) attaches per kind as those lanes build out. Everything that
 * needs to enumerate or dispatch on kinds reads THIS registry: manifest
 * validation, the runner's output handling, `extensions dev` validation,
 * `extensions init` menus, docs tables. A fifth kind is one entry here —
 * no consumer edits (the playbook test injects a synthetic kind and
 * proves it).
 *
 * Versioning (the Rule 9 migration arc on the wire): each kind carries a
 * reader per SHIPPED schema version, and a shipped reader is never
 * deleted. A reader validates its version's shape and up-converts to the
 * CURRENT in-memory document, so consumers see one shape while committed
 * snapshots of any shipped version keep loading forever. v1 readers
 * up-convert by identity.
 */

import type { ContributionKind, WireDoc } from '@vyuhlabs/dxkit-sdk';
import {
  castContractV1,
  castExportV1,
  castFindingsV1,
  castInventoryV1,
  validateContractV1,
  validateExportV1,
  validateFindingsV1,
  validateInventoryV1,
} from './validate';

/** Reader for ONE shipped wire-schema version of a kind. */
export interface WireVersionReader {
  /** The exact `schema` id this reader accepts (e.g. 'contract.v1'). */
  readonly schemaId: string;
  /** Field-precise validation; empty array = valid. */
  validate(raw: unknown): string[];
  /**
   * Convert a VALIDATED document of this version to the kind's current
   * in-memory shape. Called only after `validate` returned no errors.
   */
  upConvert(raw: unknown): WireDoc;
}

/** Registry entry for one contribution kind. */
export interface ContributionKindDef {
  readonly kind: ContributionKind;
  /** The schema id extensions are told to emit today. */
  readonly currentSchemaId: string;
  /**
   * Every shipped version's reader, newest first. Append-only: removing a
   * reader strands committed snapshots (the contract test pins coverage
   * of `currentSchemaId`).
   */
  readonly versions: readonly WireVersionReader[];
  /** Conventional committed-snapshot path for an extension of this kind. */
  snapshotPathFor(extensionName: string): string;
}

const contractKind: ContributionKindDef = {
  kind: 'contract',
  currentSchemaId: 'contract.v1',
  versions: [{ schemaId: 'contract.v1', validate: validateContractV1, upConvert: castContractV1 }],
  snapshotPathFor: (name) => `.dxkit/contrib/${name}.json`,
};

const inventoryKind: ContributionKindDef = {
  kind: 'inventory',
  currentSchemaId: 'inventory.v1',
  versions: [
    { schemaId: 'inventory.v1', validate: validateInventoryV1, upConvert: castInventoryV1 },
  ],
  snapshotPathFor: (name) => `.dxkit/contrib/${name}.json`,
};

const findingsKind: ContributionKindDef = {
  kind: 'findings',
  currentSchemaId: 'findings.v1',
  versions: [{ schemaId: 'findings.v1', validate: validateFindingsV1, upConvert: castFindingsV1 }],
  snapshotPathFor: (name) => `.dxkit/contrib/${name}.json`,
};

const exportKind: ContributionKindDef = {
  kind: 'export',
  currentSchemaId: 'export.v1',
  versions: [{ schemaId: 'export.v1', validate: validateExportV1, upConvert: castExportV1 }],
  // Export receipts are run OUTCOMES, not repo contract state — they land
  // under reports, not the committed contrib snapshots.
  snapshotPathFor: (name) => `.dxkit/reports/export-${name}.json`,
};

export const CONTRIBUTION_KINDS: readonly ContributionKindDef[] = [
  contractKind,
  inventoryKind,
  findingsKind,
  exportKind,
];

export function contributionKindFor(
  kind: string,
  registry: readonly ContributionKindDef[] = CONTRIBUTION_KINDS,
): ContributionKindDef | undefined {
  return registry.find((d) => d.kind === kind);
}

export type ParseWireResult =
  | { readonly ok: true; readonly schemaId: string; readonly doc: WireDoc }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The ONE entry point from raw extension output to a canonical document.
 * Dispatches through the registry (kind → version reader by the document's
 * own `schema` id), validates field-precisely, and up-converts. Unknown
 * kind / unknown schema id are loud errors that NAME the known set — the
 * error message is the documentation (DX doctrine).
 */
export function parseWireDoc(
  kind: string,
  raw: unknown,
  registry: readonly ContributionKindDef[] = CONTRIBUTION_KINDS,
): ParseWireResult {
  const def = contributionKindFor(kind, registry);
  if (!def) {
    const known = registry.map((d) => `'${d.kind}'`).join(' | ');
    return { ok: false, errors: [`unknown contribution kind '${kind}' — known kinds: ${known}`] };
  }
  const schemaId =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['schema']
      : undefined;
  const reader = def.versions.find((v) => v.schemaId === schemaId);
  if (!reader) {
    const shipped = def.versions.map((v) => `'${v.schemaId}'`).join(' | ');
    return {
      ok: false,
      errors: [
        `document's schema is ${JSON.stringify(schemaId)} but a '${def.kind}' extension must emit ${shipped} (current: '${def.currentSchemaId}')`,
      ],
    };
  }
  const errors = reader.validate(raw);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, schemaId: reader.schemaId, doc: reader.upConvert(raw) };
}

/**
 * Text-level sibling of {@link parseWireDoc} for the runner and dev loop:
 * malformed JSON is a validation failure with the parser's own message,
 * never a throw (fail-open discipline — a broken emit is a disclosed skip
 * at the gate, a loud error in `extensions dev`).
 */
export function parseWireDocText(
  kind: string,
  text: string,
  registry: readonly ContributionKindDef[] = CONTRIBUTION_KINDS,
): ParseWireResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [`output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  return parseWireDoc(kind, raw, registry);
}
