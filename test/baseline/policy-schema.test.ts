import { describe, it, expect } from 'vitest';
import { buildPolicySchema } from '../../src/baseline/policy-schema';
import { POLICY_PARAMS, POLICY_GUIDE_URL, paramMetaFor } from '../../src/baseline/policy-metadata';
import { renderPolicyScaffold, applicableStanzas } from '../../src/baseline/policy-template';
import { parsePolicyText } from '../../src/baseline/policy-text';

/**
 * The schema is the editor's half of the teaching surface: these tests pin
 * that it derives from the SAME metadata table as the scaffold (hover text ==
 * file comment, enum == comment's value list — the one-table discipline), and
 * that the scaffold the generator writes actually conforms to it. No ajv:
 * conformance here is the structural walk that matters (every taught path
 * exists; every enum'd value is legal), not a third validation engine.
 */

interface SchemaNode {
  readonly description?: unknown;
  readonly enum?: unknown;
  readonly title?: unknown;
  readonly properties?: Record<string, SchemaNode>;
}

const schema = buildPolicySchema('4.3.0-test') as SchemaNode;

/** Resolve a dotted policy path to its schema node (descending `properties`). */
function schemaNodeFor(path: string): SchemaNode | undefined {
  let node: SchemaNode | undefined = schema;
  for (const seg of path.split('.')) {
    node = node?.properties?.[seg];
  }
  return node;
}

describe('schema derives from the one metadata table', () => {
  for (const param of POLICY_PARAMS) {
    it(`'${param.path}' exists in the schema with the table's description + guide link`, () => {
      const node = schemaNodeFor(param.path);
      expect(node, `schema node for ${param.path}`).toBeDefined();
      expect(String(node!.description)).toContain(param.summary);
      expect(String(node!.description)).toContain(`${POLICY_GUIDE_URL}#${param.anchor}`);
    });
  }

  for (const param of POLICY_PARAMS.filter((p) => p.enumValues)) {
    it(`'${param.path}' enum matches the table exactly`, () => {
      const node = schemaNodeFor(param.path);
      expect(node!.enum).toEqual([...param.enumValues!]);
    });
  }

  it('stays forward-compatible: additionalProperties is never false anywhere', () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const rec = node as Record<string, unknown>;
      if ('additionalProperties' in rec) expect(rec.additionalProperties).not.toBe(false);
      for (const v of Object.values(rec)) walk(v);
    };
    walk(schema);
  });

  it('stamps the dxkit version in the title', () => {
    expect(String(schema.title)).toContain('4.3.0-test');
  });
});

describe('the generated scaffold conforms to the generated schema', () => {
  const ctx = { packIds: ['typescript'], lintCapable: true } as const;
  const text = renderPolicyScaffold({
    active: {},
    ctx,
    version: '4.3.0-test',
    activateAllStanzas: true,
  });
  const parsed = parsePolicyText(text) as Record<string, unknown>;

  it('every activated stanza key is a schema-known property', () => {
    for (const stanza of applicableStanzas({}, ctx)) {
      expect(schema.properties?.[stanza.key], `schema property '${stanza.key}'`).toBeDefined();
    }
  });

  it('every enum-constrained value the scaffold activates is legal per the table', () => {
    const walk = (value: unknown, prefix: string): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        const meta = paramMetaFor(path);
        if (meta?.enumValues && typeof v === 'string') {
          expect(meta.enumValues, `value at ${path}`).toContain(v);
        }
        walk(v, path);
      }
    };
    walk(parsed, '');
  });
});
