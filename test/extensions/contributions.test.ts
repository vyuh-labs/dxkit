/**
 * Wire validators + CONTRIBUTION_KINDS registry (extension SDK #11b).
 *
 * Three layers, mirroring the repo's registry discipline:
 *  - validator precision: errors are field-precise and name the schema id
 *    (the DX doctrine — the error message is the documentation);
 *  - registry contract: every ContributionKind has exactly one entry, the
 *    current schema id is covered by a reader, ids are unique;
 *  - playbook: a synthetic kind injected into the registry parses through
 *    the SAME dispatch — proof that adding a kind is one entry, no
 *    consumer edits (mirror of recipe-playbook / producer-playbook).
 */

import { describe, expect, it } from 'vitest';
import { WIRE_SCHEMA_IDS } from '@vyuhlabs/dxkit-sdk';
import type { ContributionKind } from '@vyuhlabs/dxkit-sdk';
import {
  CONTRIBUTION_KINDS,
  contributionKindFor,
  parseWireDoc,
  parseWireDocText,
  type ContributionKindDef,
} from '../../src/extensions/contributions';
import {
  validateContractV1,
  validateInventoryV1,
  validateFindingsV1,
} from '../../src/extensions/contributions/validate';

const ALL_KINDS: ContributionKind[] = ['contract', 'inventory', 'findings', 'export'];

describe('CONTRIBUTION_KINDS registry contract', () => {
  it('covers every contribution kind exactly once', () => {
    const kinds = CONTRIBUTION_KINDS.map((d) => d.kind).sort();
    expect(kinds).toEqual([...ALL_KINDS].sort());
  });

  it('every entry reads its own current schema id', () => {
    for (const def of CONTRIBUTION_KINDS) {
      const reader = def.versions.find((v) => v.schemaId === def.currentSchemaId);
      expect(reader, `${def.kind} must have a reader for ${def.currentSchemaId}`).toBeDefined();
    }
  });

  it('every current schema id is a shipped WIRE_SCHEMA_IDS entry', () => {
    for (const def of CONTRIBUTION_KINDS) {
      expect(WIRE_SCHEMA_IDS).toContain(def.currentSchemaId);
    }
  });

  it('snapshot path conventions are extension-name-scoped', () => {
    for (const def of CONTRIBUTION_KINDS) {
      const p = def.snapshotPathFor('ui-inventory');
      expect(p).toContain('ui-inventory');
      expect(p.endsWith('.json')).toBe(true);
      expect(p.startsWith('.dxkit/')).toBe(true);
    }
  });
});

describe('parseWireDoc dispatch', () => {
  it('accepts a minimal valid document per kind', () => {
    const docs: Record<ContributionKind, unknown> = {
      contract: { schema: 'contract.v1', consumed: [{ method: 'GET', url: '/api/things' }] },
      inventory: {
        schema: 'inventory.v1',
        entities: [{ kind: 'screen', name: 'Checkout', fields: [{ name: 'total' }] }],
      },
      findings: {
        schema: 'findings.v1',
        findings: [
          { rule: 'no-x', message: 'found x', severity: 'high', file: 'src/a.py', line: 3 },
        ],
      },
      export: { schema: 'export.v1', delivered: true, detail: '3 rows to influx' },
    };
    for (const kind of ALL_KINDS) {
      const r = parseWireDoc(kind, docs[kind]);
      expect(r.ok, `${kind} should parse: ${JSON.stringify(r)}`).toBe(true);
      if (r.ok) expect(r.schemaId).toBe(contributionKindFor(kind)?.currentSchemaId);
    }
  });

  it('unknown kind names the known set', () => {
    const r = parseWireDoc('telemetry', { schema: 'telemetry.v1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("'contract' | 'inventory' | 'findings' | 'export'");
  });

  it('unknown schema id names the shipped ids and the current one', () => {
    const r = parseWireDoc('contract', { schema: 'contract.v9' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("'contract.v1'");
      expect(r.errors[0]).toContain("current: 'contract.v1'");
    }
  });

  it('malformed JSON text is a disclosed validation failure, not a throw', () => {
    const r = parseWireDocText('contract', '{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not valid JSON/);
  });
});

describe('validator field precision (errors are the docs)', () => {
  it('contract.v1: names the exact array index and field', () => {
    const r = parseWireDoc('contract', {
      schema: 'contract.v1',
      consumed: [
        { method: 'GET', url: '/ok' },
        { method: 7, url: '' },
      ],
      served: [{ method: 'GET', path: '/x', line: 0 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContainEqual(expect.stringContaining('consumed[1].method'));
      expect(r.errors).toContainEqual(expect.stringContaining('consumed[1].url'));
      expect(r.errors).toContainEqual(expect.stringContaining('served[0].line'));
      for (const e of r.errors) expect(e.startsWith('contract.v1: ')).toBe(true);
    }
  });

  it('inventory.v1: nested field paths are precise', () => {
    const r = parseWireDoc('inventory', {
      schema: 'inventory.v1',
      entities: [
        { kind: 'screen', name: 'A', fields: [{ name: 'ok' }, { type: 'str' }] },
        { name: 'missing-kind' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContainEqual(expect.stringContaining('entities[0].fields[1].name'));
      expect(r.errors).toContainEqual(expect.stringContaining('entities[1].kind'));
    }
  });

  it('findings.v1: severity vocabulary is enforced with the allowed set in the message', () => {
    const r = parseWireDoc('findings', {
      schema: 'findings.v1',
      findings: [{ rule: 'r', message: 'm', severity: 'urgent', file: 'a.ts' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain('findings[0].severity');
      expect(r.errors[0]).toContain("'critical' | 'high' | 'medium' | 'low'");
    }
  });

  it('export.v1: missing delivered is loud', () => {
    const r = parseWireDoc('export', { schema: 'export.v1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('delivered');
  });

  it('unknown extra fields are tolerated (forward compatibility)', () => {
    const r = parseWireDoc('contract', {
      schema: 'contract.v1',
      consumed: [{ method: 'GET', url: '/x', futureField: { anything: true } }],
      vendorBlock: [1, 2, 3],
    });
    expect(r.ok).toBe(true);
  });

  it('error volume is bounded (a huge malformed emit is a screenful, not a wall)', () => {
    const entities = Array.from({ length: 500 }, () => ({}));
    const r = parseWireDoc('inventory', { schema: 'inventory.v1', entities });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeLessThanOrEqual(25);
  });
});

describe('wire file locators are validated repo-relative POSIX (S-15)', () => {
  const bad = [
    ['/etc/passwd', 'absolute'],
    ['..\u002fescape.ts', 'traversal'],
    ['C:\\repo\\x.ts', 'drive-prefixed'],
    ['src//x.ts', 'empty segment'],
  ] as const;
  it('findings.v1 rejects non-canonical file locators (they feed identity — Rule 9)', () => {
    for (const [file] of bad) {
      const errors = validateFindingsV1({
        schema: 'findings.v1',
        findings: [{ rule: 'r', message: 'm', file, severity: 'high' }],
      });
      expect(errors.length, `should reject ${JSON.stringify(file)}`).toBeGreaterThan(0);
    }
    expect(
      validateFindingsV1({
        schema: 'findings.v1',
        findings: [{ rule: 'r', message: 'm', file: 'src/app.ts', severity: 'high' }],
      }),
    ).toEqual([]);
  });
  it('contract.v1 + inventory.v1 reject them on their optional file fields too', () => {
    expect(
      validateContractV1({
        schema: 'contract.v1',
        consumed: [{ method: 'GET', url: '/x', file: '/abs/path.ts' }],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateInventoryV1({
        schema: 'inventory.v1',
        entities: [{ kind: 'screen', name: 'A', file: '../outside.ts' }],
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('synthetic-kind playbook (the registry stays the dispatch)', () => {
  it('an injected kind parses through the same entry point untouched', () => {
    const synthetic: ContributionKindDef = {
      kind: 'telemetry' as ContributionKind, // a kind core does not know
      currentSchemaId: 'telemetry.v1',
      versions: [
        {
          schemaId: 'telemetry.v1',
          validate: (raw) =>
            typeof (raw as Record<string, unknown>)?.['signal'] === 'string'
              ? []
              : ['telemetry.v1: signal is missing (required, non-empty string)'],
          // Playbook-only shape; a real kind up-converts to its canonical doc.
          upConvert: (raw) => raw as never,
        },
      ],
      snapshotPathFor: (name) => `.dxkit/contrib/${name}.json`,
    };
    const registry = [...CONTRIBUTION_KINDS, synthetic];

    const good = parseWireDoc('telemetry', { schema: 'telemetry.v1', signal: 'ok' }, registry);
    expect(good.ok).toBe(true);

    const bad = parseWireDoc('telemetry', { schema: 'telemetry.v1' }, registry);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain('signal');

    // And the unknown-kind error now names the synthetic kind too — the
    // "known kinds" list is registry-derived, not hardcoded.
    const unknown = parseWireDoc('nope', {}, registry);
    if (!unknown.ok) expect(unknown.errors[0]).toContain("'telemetry'");
  });
});
