/**
 * The model-schema drift gate — pure evaluation core.
 *
 * Answers "does this diff change a declared data model in a breaking way?"
 * from a base↔HEAD model-set comparison, with no running system. The diff
 * itself (`diffModelSets`) is the grandfather: only differences between the
 * two refs exist, so pre-existing state can never produce a finding.
 *
 * The gate's contribution over the diff is the VERDICT: which change classes
 * break (block), which deserve attention (warn), and which are merely
 * disclosed (info) — modulated by each finding's intrinsic confidence, so an
 * unknown-degraded or similarity-paired finding can warn but never block.
 * Pure over its inputs — the ref-based gather and guardrail wiring live in
 * `src/baseline/schema-drift-gate-check.ts`. Identity is the location-free
 * drift fingerprint (Rule 9), computed through the canonical helper so an
 * emitted finding shares one identity contract with the allowlist.
 */

import { computeModelSchemaDriftFingerprint } from '../tools/fingerprint';
import { diffModelSets, type DriftClass, type ModelSet, type SchemaDrift } from './model';

/** Change classes that are breaking by construction: a reader or writer of
 *  the previous contract can now fail. Block-eligible (confidence-gated). */
const BREAKING_CLASSES: ReadonlySet<DriftClass> = new Set([
  'model-removed',
  'field-removed',
  'field-type-changed',
  'field-required-added',
]);

/** Classes that deserve attention but whose impact is direction-dependent
 *  (a new required field breaks writers, not readers) — always warn. */
const WARN_CLASSES: ReadonlySet<DriftClass> = new Set(['field-added-required']);

/** One drift finding with its verdict. `info` findings are DISCLOSED (shown
 *  in reports) but never count toward blocks/warns. */
export interface SchemaDriftFinding extends SchemaDrift {
  /** Location-free drift fingerprint — the durable identity (Rule 9). */
  readonly id: string;
  readonly verdict: 'block' | 'warn' | 'info';
}

export interface SchemaGateInputs {
  readonly baseModels: ModelSet;
  readonly headModels: ModelSet;
  /** Confidence at/above which a breaking drift BLOCKS (else warns).
   *  Default 1 — only fully-determined findings on exactly-paired models can
   *  fail a build; unknown-degraded and similarity-paired ones warn. */
  readonly blockThreshold?: number;
}

/**
 * Evaluate the gate. Returns every drift with its verdict, most-severe first
 * (block, warn, info), then by model/field for stable output. Empty when the
 * diff changes no declared model.
 */
export function evaluateSchemaDriftGate(inputs: SchemaGateInputs): SchemaDriftFinding[] {
  const blockThreshold = inputs.blockThreshold ?? 1;
  const out = diffModelSets(inputs.baseModels, inputs.headModels).map((d): SchemaDriftFinding => {
    let verdict: SchemaDriftFinding['verdict'];
    if (BREAKING_CLASSES.has(d.changeClass)) {
      verdict = d.confidence >= blockThreshold ? 'block' : 'warn';
    } else if (WARN_CLASSES.has(d.changeClass)) {
      verdict = 'warn';
    } else {
      verdict = 'info';
    }
    return {
      ...d,
      id: computeModelSchemaDriftFingerprint(d.model, d.field, d.changeClass),
      verdict,
    };
  });

  const rank = (v: SchemaDriftFinding['verdict']): number =>
    v === 'block' ? 0 : v === 'warn' ? 1 : 2;
  out.sort(
    (a, z) =>
      rank(a.verdict) - rank(z.verdict) ||
      a.model.localeCompare(z.model) ||
      (a.field ?? '').localeCompare(z.field ?? ''),
  );
  return out;
}

/** Does the gate result block? True when any finding's verdict is `block`. */
export function schemaDriftGateBlocks(findings: readonly SchemaDriftFinding[]): boolean {
  return findings.some((f) => f.verdict === 'block');
}

/** One-line human description of a drift finding, shared by the console
 *  renderer, the PR comment, and the Stop-gate hand-back. */
export function describeSchemaDrift(f: SchemaDriftFinding): string {
  const subject = f.field ? `${f.model}.${f.field}` : f.model;
  const at = `${f.file}:${f.line}`;
  switch (f.changeClass) {
    case 'model-removed':
      return `${subject} — model removed (was ${f.from ?? 'declared'}) [${at}]`;
    case 'model-added':
      return `${subject} — model added [${at}]`;
    case 'field-removed':
      return `${subject} — field removed (was ${f.from ?? 'unknown type'}) [${at}]`;
    case 'field-added':
      return `${subject} — optional field added (${f.to ?? 'unknown type'}) [${at}]`;
    case 'field-added-required':
      return `${subject} — REQUIRED field added (${f.to ?? 'unknown type'}) — breaks writers [${at}]`;
    case 'field-type-changed':
      return `${subject} — type changed: ${f.from ?? 'unknown'} → ${f.to ?? 'unknown'} [${at}]`;
    case 'field-required-added':
      return `${subject} — optional → required [${at}]`;
    case 'field-optionality-relaxed':
      return `${subject} — required → optional [${at}]`;
  }
}
