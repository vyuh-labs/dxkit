/**
 * Schema-FILE model extraction — the engine half of
 * `ModelSchemaSupport.schemaFileTables` (Rails `db/schema.rb`), split from
 * `extract.ts` as one cohesive sub-concern: the source of these models is a
 * DECLARED FILE's table calls, not a class the per-file walk recognizes.
 * Consumed by the gather's assembly step (`gather.ts`), which also demotes
 * the pack's class markers while such a file exists.
 */

import type { ModelSchemaSupport } from '../../languages/types';
import { walk, type Node } from '../../ast/parse';
import type { GrammarShape } from '../../ast/grammar-shape';
import { normalizeField } from './normalize';
import type { ModelEntity, ModelField } from './model';

function line(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * Extract the table-declared models of a SCHEMA FILE (Rails `db/schema.rb`)
 * — the engine half of `ModelSchemaSupport.schemaFileTables`. One entity per
 * `tableCallees` call (name = the first string argument — the table name,
 * the wire contract); each MEMBER call in its body with a string first
 * argument contributes a field (name = the argument, type = the member
 * method's name, folded through the descriptor's aliases). An ABSENT
 * optionality keyword reads as the framework default (nullable ⇒ optional —
 * a schema-file fact); an explicit `null: false` is authoritative. PURE
 * over its inputs.
 */
export function extractSchemaFileTables(
  root: Node,
  spec: NonNullable<ModelSchemaSupport['schemaFileTables']>,
  descriptor: ModelSchemaSupport,
  callShape: GrammarShape,
  file: string,
): ModelEntity[] {
  const out: ModelEntity[] = [];
  const tableNames = new Set(spec.tableCallees);

  walk(root, (node) => {
    if (!callShape.callNodes.includes(node.type)) return undefined;
    const callee = callShape.resolveCall(node);
    if (!callee || !tableNames.has(callee.name)) return undefined;
    const first = callShape.firstArg(node);
    const rawName = first ? callShape.stringText(first) : null;
    if (rawName == null) return undefined;
    const name = rawName.replace(/['"`]/g, '');
    if (name.length === 0) return undefined;

    const fields: ModelField[] = [];
    const seen = new Set<string>();
    walk(node, (col) => {
      if (col.id === node.id || !callShape.callNodes.includes(col.type)) return undefined;
      const colCallee = callShape.resolveCall(col);
      if (!colCallee || colCallee.kind !== 'member') return undefined;
      const colFirst = callShape.firstArg(col);
      const colRaw = colFirst ? callShape.stringText(colFirst) : null;
      if (colRaw == null) return undefined;
      const colName = colRaw.replace(/['"`]/g, '');
      if (colName.length === 0 || seen.has(colName)) return undefined;

      let descriptorOptional: boolean | null = null;
      let descriptorDefaultOptional: boolean | null = true; // framework default: nullable
      if (spec.optionalityKeyword !== undefined) {
        const v = callShape.optionValue(col, spec.optionalityKeyword);
        if (v && /^(true|false)$/i.test(v.text)) {
          descriptorOptional = /^true$/i.test(v.text);
          descriptorDefaultOptional = null;
        }
      }
      const normalized = normalizeField({
        rawType: colCallee.name,
        markerOptional: null,
        descriptorOptional,
        descriptorDefaultOptional,
        typeAliases: descriptor.typeAliases,
        typeWrappers: descriptor.transparentTypeWrappers,
      });
      seen.add(colName);
      fields.push({ name: colName, ...normalized });
      return undefined;
    });

    out.push({ name, via: 'schema-file', file, line: line(node), fields });
    return false; // the body was just walked — don't descend again
  });

  return out;
}
