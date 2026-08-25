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

/**
 * The reverse direction for the remediate block (4.4.5): every KNOB the
 * schema teaches has a row in the one metadata table, so `policy set`'s
 * knob index and the guide cannot silently miss a knob the editor shows.
 * The class this closes: taskBudgets / maxSpendPerRun / maxDispatchBudget /
 * resume shipped in the schema with hand-written descriptions and no
 * metadata row, invisible to the knob index and the guide.
 *
 * A leaf is a property node with no `properties` of its own; a container
 * whose shape is free-form (`additionalProperties` as a schema, e.g. the
 * per-task budget map) is a leaf too: the knob is the map, not its rows.
 */
function schemaLeafPaths(node: SchemaNode | undefined, prefix: string): string[] {
  if (!node?.properties) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(node.properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(...schemaLeafPaths(child, path));
  }
  return out;
}

function remediateKnobsMissingFrom(
  schemaRoot: SchemaNode,
  params: readonly { readonly path: string }[],
): string[] {
  const known = new Set(params.map((p) => p.path));
  return schemaLeafPaths(schemaRoot.properties?.remediate, 'remediate').filter(
    (p) => !known.has(p),
  );
}

describe('every remediate knob in the schema has a metadata row (knob index + guide parity)', () => {
  it('no schema leaf under remediate is missing from POLICY_PARAMS', () => {
    expect(remediateKnobsMissingFrom(schema, POLICY_PARAMS)).toEqual([]);
  });

  it('the parity check bites: an injected schema-only knob is reported', () => {
    const injected: SchemaNode = {
      properties: {
        remediate: {
          properties: {
            ...schema.properties?.remediate?.properties,
            syntheticKnob: { description: 'a knob with no metadata row' },
          },
        },
      },
    };
    expect(remediateKnobsMissingFrom(injected, POLICY_PARAMS)).toEqual(['remediate.syntheticKnob']);
  });
});
