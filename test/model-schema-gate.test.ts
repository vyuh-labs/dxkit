/**
 * The model-schema drift gate — pure evaluation core: verdict assignment per
 * change class, confidence gating (unknown never blocks), threshold
 * behavior, ordering, and identity stability across relocation.
 */

import { describe, it, expect } from 'vitest';
import {
  describeSchemaDrift,
  evaluateSchemaDriftGate,
  schemaDriftGateBlocks,
} from '../src/analyzers/model-schema/gate';
import type { ModelEntity, ModelSet } from '../src/analyzers/model-schema/model';

function entity(name: string, file: string, fields: ModelEntity['fields']): ModelEntity {
  return { name, via: 'base-class', file, line: 1, fields };
}
function set(...models: ModelEntity[]): ModelSet {
  return { models, dynamicModels: [] };
}

const BASE = set(
  entity('User', 'm.ts', [
    { name: 'id', type: 'int', required: true },
    { name: 'email', type: 'string', required: false },
    { name: 'blob', type: null, required: null },
  ]),
);

describe('evaluateSchemaDriftGate — verdicts', () => {
  it('breaking classes block at full confidence; additive classes warn/info', () => {
    const head = set(
      entity('User', 'm.ts', [
        { name: 'id', type: 'string', required: true }, // type-changed → block
        // email removed → block
        { name: 'blob', type: null, required: null },
        { name: 'nick', type: 'string', required: false }, // added optional → info
        { name: 'org', type: 'string', required: true }, // added required → warn
      ]),
    );
    const findings = evaluateSchemaDriftGate({ baseModels: BASE, headModels: head });
    const byClass = new Map(findings.map((f) => [f.changeClass, f]));
    expect(byClass.get('field-type-changed')?.verdict).toBe('block');
    expect(byClass.get('field-removed')?.verdict).toBe('block');
    expect(byClass.get('field-added-required')?.verdict).toBe('warn');
    expect(byClass.get('field-added')?.verdict).toBe('info');
    expect(schemaDriftGateBlocks(findings)).toBe(true);
    // Ordering: blocks first, then warns, then info.
    const ranks = findings.map((f) => f.verdict);
    expect(ranks).toEqual(
      [...ranks].sort((a, b) => 'block warn info'.indexOf(a) - 'block warn info'.indexOf(b)),
    );
  });

  it('an unknown-degraded breaking finding WARNS, never blocks', () => {
    const head = set(
      entity('User', 'm.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: false },
        { name: 'blob', type: 'bytes', required: null }, // unknown → known transition
      ]),
    );
    const findings = evaluateSchemaDriftGate({ baseModels: BASE, headModels: head });
    expect(findings).toHaveLength(1);
    expect(findings[0].changeClass).toBe('field-type-changed');
    expect(findings[0].verdict).toBe('warn');
    expect(schemaDriftGateBlocks(findings)).toBe(false);
  });

  it('blockThreshold demotes similarity-paired findings to warn', () => {
    // Two same-named models force similarity pairing (confidence < 1) after
    // a cross-file shuffle with an edit.
    const base = set(
      entity('User', 'a.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: true },
        { name: 'age', type: 'int', required: true },
      ]),
      entity('User', 'b.ts', [
        { name: 'sku', type: 'string', required: true },
        { name: 'qty', type: 'int', required: true },
        { name: 'lot', type: 'string', required: true },
      ]),
    );
    const head = set(
      entity('User', 'x.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: true },
        // age removed — on a similarity pair (conf 2/3 < 1) → warn, not block
      ]),
      entity('User', 'y.ts', [
        { name: 'sku', type: 'string', required: true },
        { name: 'qty', type: 'int', required: true },
        { name: 'lot', type: 'string', required: true },
      ]),
    );
    const findings = evaluateSchemaDriftGate({ baseModels: base, headModels: head });
    const removed = findings.find((f) => f.changeClass === 'field-removed');
    expect(removed).toBeDefined();
    expect(removed!.confidence).toBeLessThan(1);
    expect(removed!.verdict).toBe('warn');
  });

  it('a pure file move produces zero findings; identity is location-free', () => {
    const moved = set(entity('User', 'relocated/deep/m.ts', [...BASE.models[0].fields]));
    expect(evaluateSchemaDriftGate({ baseModels: BASE, headModels: moved })).toEqual([]);

    // Same drift discovered at two different locations mints ONE identity.
    const dropA = evaluateSchemaDriftGate({
      baseModels: BASE,
      headModels: set(entity('User', 'm.ts', [BASE.models[0].fields[0], BASE.models[0].fields[2]])),
    });
    const dropB = evaluateSchemaDriftGate({
      baseModels: set(entity('User', 'other/place.py', [...BASE.models[0].fields])),
      headModels: set(
        entity('User', 'other/place.py', [BASE.models[0].fields[0], BASE.models[0].fields[2]]),
      ),
    });
    expect(dropA[0].id).toBe(dropB[0].id);
  });
});

describe('describeSchemaDrift', () => {
  it('renders a one-liner for every change class', () => {
    const head = set(
      entity('User', 'm.ts', [
        { name: 'id', type: 'string', required: true },
        { name: 'email', type: 'string', required: true },
        { name: 'blob', type: null, required: false },
        { name: 'org', type: 'string', required: true },
      ]),
      entity('Audit', 'a.ts', []),
    );
    const findings = evaluateSchemaDriftGate({ baseModels: BASE, headModels: head });
    for (const f of findings) {
      const line = describeSchemaDrift(f);
      expect(line).toContain(f.model);
      expect(line.length).toBeGreaterThan(10);
    }
  });
});
