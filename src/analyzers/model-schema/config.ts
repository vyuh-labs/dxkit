/**
 * Model-schema configuration read from `.dxkit/policy.json:schema` — the
 * single reader AND single writer of that section (Rule 2, the flow-config
 * discipline). Every schema surface — the `schema` CLI, the guardrail drift
 * gate, doctor's probe — resolves its config here.
 *
 * All fields are optional in the file; a missing / malformed policy yields
 * the defaults (fail-open), never a throw. The default MODE is `off`: a repo
 * that never configured the gate spawns nothing (the capability is opt-in;
 * `configure` plans `warn`, the user promotes to `block`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { mergeIntoPolicyFile } from '../../baseline/policy-write';

/** How the guardrail treats net-new schema drift.
 *   - `block`: honor the per-finding verdict — a fully-determined breaking
 *     change fails the build; an unknown-degraded one warns.
 *   - `warn`: every drift warns, never fails a build (soft launch).
 *   - `off` (default): the gate does not run at all. */
export type SchemaGateMode = 'block' | 'warn' | 'off';

export interface SchemaConfig {
  /** OpenAPI / JSON Schema files whose declared models union with source
   *  extraction — the language-independent bridge (mirror of `flow.specs`). */
  readonly specs: string[];
  /** Guardrail posture for net-new schema drift. */
  readonly mode: SchemaGateMode;
  /** Confidence at/above which a breaking drift BLOCKS (else warns).
   *  Default 1 — only fully-determined findings can fail a build; anything
   *  degraded by an unknown or a similarity-matched relocation warns. */
  readonly blockThreshold: number;
}

const DEFAULTS: SchemaConfig = {
  specs: [],
  mode: 'off',
  blockThreshold: 1,
};

/** Current schema version of the committed `.dxkit/policy.json:schema`
 *  block. Stamped on write so a future restructure is detectable/migratable
 *  (a versionless block reads as v1 — every field optional-with-default).
 *  The three keys (specs/mode/blockThreshold) are the FROZEN v1 contract,
 *  pinned by `test/model-schema-contract-freeze.test.ts`. */
export const SCHEMA_CONFIG_SCHEMA_VERSION = 1;

interface RawSchema {
  specs?: unknown;
  mode?: unknown;
  blockThreshold?: unknown;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function isMode(v: unknown): v is SchemaGateMode {
  return v === 'block' || v === 'warn' || v === 'off';
}

function rawSection(cwd: string): RawSchema | undefined {
  try {
    const text = fs.readFileSync(path.join(cwd, '.dxkit', 'policy.json'), 'utf8');
    return (JSON.parse(text) as { schema?: RawSchema })?.schema;
  } catch {
    return undefined;
  }
}

/** Read the `schema` section of `.dxkit/policy.json`. Fail-open — a
 *  read/parse error or an absent block returns the defaults (gate off). */
export function readSchemaConfig(cwd: string): SchemaConfig {
  const raw = rawSection(cwd) ?? {};
  return {
    specs: stringList(raw.specs),
    mode: isMode(raw.mode) ? raw.mode : DEFAULTS.mode,
    blockThreshold:
      typeof raw.blockThreshold === 'number' && raw.blockThreshold > 0
        ? raw.blockThreshold
        : DEFAULTS.blockThreshold,
  };
}

/**
 * The `schema.mode` EXPLICITLY set in policy, or `undefined` when unset —
 * distinguishing "the user chose a posture" from "no posture yet", so a
 * configure/init re-run PRESERVES an evolved choice instead of resetting it
 * (the init-resets-user-choice bug class flow closed).
 */
export function existingSchemaMode(cwd: string): SchemaGateMode | undefined {
  const raw = rawSection(cwd);
  return raw && isMode(raw.mode) ? raw.mode : undefined;
}

/**
 * Write into `.dxkit/policy.json:schema` through the ONE policy merge-writer
 * — sibling sections survive, a malformed file is never clobbered, an
 * unchanged merge writes nothing. The single writer of this section,
 * paired with the reader above.
 */
export function writeSchemaPolicy(
  cwd: string,
  patch: Partial<Pick<SchemaConfig, 'mode' | 'specs' | 'blockThreshold'>>,
): boolean {
  return mergeIntoPolicyFile(cwd, {
    schema: { ...patch, schemaVersion: SCHEMA_CONFIG_SCHEMA_VERSION },
  }).changed;
}
