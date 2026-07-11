/**
 * Spec-declared models — consume an OpenAPI document's `components.schemas`
 * (3.x) / `definitions` (2.0), or a bare JSON Schema file, as declared data
 * models. The language-independent bridge (mirror of flow's
 * `spec-source.ts`): any repo in any language that carries a spec is
 * gateable with zero pack extraction, and it is the documented answer for
 * unmarked DTOs that marker-based code recognition cannot see.
 *
 * Output is the same `ModelEntity` shape the AST extractor produces
 * (`via: 'spec'`), so the join and diff are indifferent to where a model
 * came from. Type tokens are the spec's own lexical vocabulary (`string`,
 * `integer`, a `$ref` target's name, `X[]` for arrays) — comparison stays
 * within the spec's language, per the normalizer's lexical doctrine.
 *
 * JSON documents today (YAML is the same fast-follow decision flow has).
 * Pure over its inputs; the file read is the only I/O. Fail-open: an
 * unreadable or non-schema file yields `[]`, never a throw.
 */

import { readFileSync } from 'fs';
import type { ModelEntity, ModelField } from './model';

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The lexical type token of one property schema: `$ref` tail > `type`
 *  (arrays as `items[]`), else null (an untyped/complex property is an
 *  honest unknown — the diff's null rules apply to spec models too). */
function propertyType(prop: unknown): string | null {
  if (!isObject(prop)) return null;
  const ref = prop.$ref;
  if (typeof ref === 'string') {
    const tail = ref.split('/').pop();
    return tail && tail.length > 0 ? tail : null;
  }
  const type = prop.type;
  if (type === 'array') {
    const inner = propertyType(prop.items);
    return inner ? `${inner}[]` : 'array';
  }
  return typeof type === 'string' ? type : null;
}

/** One named schema object → a ModelEntity, or null when it declares no
 *  object shape we can field-diff (enums, primitives, allOf compositions —
 *  documented spec-bridge limits, not errors). */
function schemaToModel(name: string, schema: unknown, file: string): ModelEntity | null {
  if (!isObject(schema)) return null;
  const properties = schema.properties;
  if (!isObject(properties)) return null;
  const requiredList = Array.isArray(schema.required)
    ? new Set(schema.required.filter((r): r is string => typeof r === 'string'))
    : new Set<string>();

  const fields: ModelField[] = Object.entries(properties).map(([propName, prop]) => ({
    name: propName,
    type: propertyType(prop),
    required: requiredList.has(propName),
  }));
  return { name, via: 'spec', file, line: 0, fields };
}

/**
 * Models from a parsed document. Recognized containers, in order:
 * OpenAPI 3.x `components.schemas`, Swagger 2.0 `definitions`, JSON Schema
 * `$defs` / `definitions`, and finally a single root-level schema (a bare
 * JSON Schema file with `title` + `properties`).
 */
export function modelsFromSpec(doc: unknown, file: string): ModelEntity[] {
  if (!isObject(doc)) return [];
  const containers: unknown[] = [
    isObject(doc.components) ? doc.components.schemas : undefined,
    doc.definitions,
    doc.$defs,
  ];
  const out: ModelEntity[] = [];
  for (const container of containers) {
    if (!isObject(container)) continue;
    for (const [name, schema] of Object.entries(container)) {
      const model = schemaToModel(name, schema, file);
      if (model) out.push(model);
    }
  }
  if (out.length === 0 && typeof doc.title === 'string') {
    const root = schemaToModel(doc.title, doc, file);
    if (root) out.push(root);
  }
  return out;
}

/** Read + parse a JSON spec into models. `[]` (never throws) when the file
 *  is unreadable or not a recognizable schema document. */
export function loadSpecModels(filePath: string): ModelEntity[] {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  return modelsFromSpec(doc, filePath);
}
