/**
 * Model-schema extraction — the AST pass that turns source into a repo's
 * declared data models (the substrate the drift gate diffs).
 *
 * Cross-cutting consumer of the same seams as flow extraction, hardcoding
 * none of them: the canonical AST layer (`src/ast/parse.ts`) for parsing;
 * the per-grammar MODEL shape (`src/ast/grammar-model-shape.ts`) for HOW to
 * read a class/field/heritage/tag; the per-grammar CALL shape
 * (`src/ast/grammar-shape.ts`) for decorator/constructor reads; and each
 * pack's `modelSchema` descriptor (Rule 6) for WHICH constructs are models.
 * No grammar node name and no framework literal lives in this file — a new
 * language adds model extraction with ZERO extractor edits.
 *
 * Recognition is marker-based (precision-first, the flow lesson): heritage,
 * decorator, or struct-tag markers from the descriptor. A recognized model
 * with no statically readable fields is disclosed via `dynamicModels` AND
 * kept in `models` (so a later readable version diffs as field additions,
 * never a phantom model-added). A field whose type cannot be read is kept
 * with `type: null` — the diff's unknown rules make sure a `null` never
 * blocks anything.
 */

import { getLanguage } from '../../languages';
import type { ModelSchemaSupport } from '../../languages/types';
import { parseFile, walk, type Node } from '../../ast/parse';
import { grammarShape, type GrammarShape } from '../../ast/grammar-shape';
import { modelShapeForGrammar, type GrammarModelShape } from '../../ast/grammar-model-shape';
import { normalizeField, tagWireName } from './normalize';
import type { DynamicModelSite, ModelEntity, ModelField, ModelSet } from './model';

function line(node: Node): number {
  return node.startPosition.row + 1;
}

/** Trailing identifier segment of a dotted path (`models.Model` → `Model`). */
function tailSegment(text: string): string {
  const parts = text.split('.');
  return parts[parts.length - 1];
}

/** Does a heritage expression match a declared base marker? Both the full
 *  text and the trailing segment count (`'Model'` matches `models.Model`). */
function heritageMatches(heritage: string, bases: readonly string[]): boolean {
  return bases.some((b) => heritage === b || tailSegment(heritage) === b);
}

/** The name a decorator invokes: `@Entity()` → `Entity`, `@dataclass` →
 *  `dataclass`, `@orm.Table(...)` → `Table`. Lexical over the decorator's
 *  text — total, never throws. */
function decoratorName(decorator: Node): string {
  const text = decorator.text.replace(/^@/, '');
  return tailSegment(text.split('(')[0].trim());
}

type FieldCalleeSpec = NonNullable<ModelSchemaSupport['fieldCallees']>[number];

/** Resolve a field-initializer constructor against the descriptor's
 *  `fieldCallees`: the matched spec plus the raw type token and explicit
 *  optionality it carries. */
function resolveFieldCallee(
  call: Node,
  callShape: GrammarShape,
  specs: readonly FieldCalleeSpec[],
): {
  rawType: string | null;
  descriptorOptional: boolean | null;
  descriptorDefaultOptional: boolean | null;
} | null {
  const resolved = callShape.resolveCall(call);
  if (!resolved) return null;
  const spec = specs.find((s) => s.names.some((n) => n === resolved.name));
  if (!spec) return null;

  let rawType: string | null;
  if (spec.typeFrom === 'firstArg') {
    // Column(String, …) / db.Column(db.Integer(80)) — the first positional
    // argument's head token, dotted-path-tailed and call-parens-stripped.
    const first = callShape.firstArg(call);
    rawType = first ? tailSegment(first.text.split('(')[0].trim()) : null;
  } else {
    rawType = resolved.name;
  }

  // An EXPLICIT keyword (`null=True`, `nullable=False`) is authoritative.
  // An ABSENT keyword yields only the framework DEFAULT, which ranks below
  // a folded annotation — SQLAlchemy 2.0 derives nullability from
  // `Mapped[Optional[X]]` when no kwarg is given (real-repo-validated).
  let descriptorOptional: boolean | null = null;
  let descriptorDefaultOptional: boolean | null = null;
  if (spec.optionalityKeyword) {
    const value = callShape.optionValue(call, spec.optionalityKeyword);
    const truthy = value ? /^(true|True)$/.test(value.text) : null;
    const optionalWhenTrue = (spec.optionalityPolarity ?? 'nullable') === 'nullable';
    if (truthy === null) descriptorDefaultOptional = optionalWhenTrue ? false : true;
    else descriptorOptional = optionalWhenTrue ? truthy : !truthy;
  }

  return { rawType, descriptorOptional, descriptorDefaultOptional };
}

type FieldDecoratorSpec = NonNullable<ModelSchemaSupport['fieldDecoratorSpecs']>[number];

/** The keyword value carried by a decorator node — read off the node itself
 *  (JVM shapes: the annotation/constructor_invocation IS the invocation) or
 *  its inner call (TS-style `@Column({...})` wrapping). */
function decoratorOption(dec: Node, keyword: string, callShape: GrammarShape): Node | null {
  const direct = callShape.optionValue(dec, keyword);
  if (direct) return direct;
  const inner = callShape.decoratorCall(dec);
  return inner && inner.id !== dec.id ? callShape.optionValue(inner, keyword) : null;
}

/** Resolve a field's ANNOTATIONS against the descriptor's
 *  `fieldDecoratorSpecs` (JPA `@Column(nullable = false, name = "wire")`):
 *  explicit optionality and a wire-name override. Only EXPLICIT keyword
 *  values contribute — an absent keyword keeps the grammar/lexical answer. */
function resolveFieldDecorators(
  field: Node,
  modelShape: GrammarModelShape,
  callShape: GrammarShape,
  specs: readonly FieldDecoratorSpec[],
): { optional: boolean | null; wireName: string | null } {
  let optional: boolean | null = null;
  let wireName: string | null = null;
  for (const dec of modelShape.fieldDecorators(field)) {
    const spec = specs.find((s) => s.names.includes(decoratorName(dec)));
    if (!spec) continue;
    if (spec.optionalityKeyword && optional === null) {
      const value = decoratorOption(dec, spec.optionalityKeyword, callShape);
      if (value && /^(true|false|True|False)$/.test(value.text)) {
        const truthy = /^(true|True)$/.test(value.text);
        optional = (spec.optionalityPolarity ?? 'nullable') === 'nullable' ? truthy : !truthy;
      }
    }
    if (spec.wireNameKeyword && wireName === null) {
      const value = decoratorOption(dec, spec.wireNameKeyword, callShape);
      const raw = value ? callShape.stringText(value) : null;
      if (raw != null) wireName = raw.replace(/['"`]/g, '');
    }
  }
  return { optional, wireName };
}

/** How a class node is marked as a model, or null when it is not one. */
function recognizeModel(
  node: Node,
  descriptor: ModelSchemaSupport,
  modelShape: GrammarModelShape,
  callShape: GrammarShape | null,
): { via: ModelEntity['via']; weak: boolean } | null {
  if (descriptor.modelBaseClasses?.length) {
    const heritage = modelShape.heritage(node);
    if (heritage.some((h) => heritageMatches(h, descriptor.modelBaseClasses!))) {
      return { via: 'base-class', weak: false };
    }
  }
  if (descriptor.modelDecorators?.length && callShape) {
    const names = modelShape.classDecorators(node).map((d) => decoratorName(d));
    if (names.some((n) => descriptor.modelDecorators!.includes(n))) {
      return { via: 'decorator', weak: false };
    }
  }
  if (descriptor.structTagKeys?.length) {
    for (const field of modelShape.fieldNodes(node)) {
      const tag = modelShape.fieldTag(field);
      if (tag && descriptor.structTagKeys.some((k) => tagWireName(tag, k) !== null)) {
        return { via: 'struct-tag', weak: false };
      }
    }
  }
  // WEAK heritage last: a too-generic name (`Base`) marks a model only when
  // field extraction corroborates it (≥1 fieldCallees hit) — the caller
  // enforces that, discarding uncorroborated weak matches.
  if (descriptor.weakModelBaseClasses?.length) {
    const heritage = modelShape.heritage(node);
    if (heritage.some((h) => heritageMatches(h, descriptor.weakModelBaseClasses!))) {
      return { via: 'base-class', weak: true };
    }
  }
  return null;
}

function extractFields(
  classNode: Node,
  descriptor: ModelSchemaSupport,
  modelShape: GrammarModelShape,
  callShape: GrammarShape | null,
): { fields: ModelField[]; sawFieldCallee: boolean } {
  const out: ModelField[] = [];
  const tagKeys = descriptor.structTagKeys ?? [];
  const calleeSpecs = descriptor.fieldCallees ?? [];
  let sawFieldCallee = false;

  for (const field of modelShape.fieldNodes(classNode)) {
    const declaredNames = modelShape.fieldNames(field);
    if (declaredNames.length === 0) continue; // unnamed/embedded

    let rawType = modelShape.fieldTypeText(field);
    const markerOptional = modelShape.fieldOptionalMarker(field);
    let descriptorOptional: boolean | null = null;
    let descriptorDefaultOptional: boolean | null = null;

    // Field-constructor form (`models.CharField(null=True)`) — supplies the
    // type token and explicit optionality when the annotation does not.
    if (calleeSpecs.length > 0 && callShape) {
      const call = modelShape.fieldValueCall(field);
      const resolved = call ? resolveFieldCallee(call, callShape, calleeSpecs) : null;
      if (resolved) {
        sawFieldCallee = true;
        if (rawType === null) rawType = resolved.rawType;
        descriptorOptional = resolved.descriptorOptional;
        descriptorDefaultOptional = resolved.descriptorDefaultOptional;
      }
    }

    // Field-ANNOTATION form (JPA `@Column(nullable = false, name = "wire")`)
    // — explicit optionality and wire naming; absent keywords change nothing.
    let decoratorWireName: string | null = null;
    const decoratorSpecs = descriptor.fieldDecoratorSpecs ?? [];
    if (decoratorSpecs.length > 0 && callShape) {
      const resolved = resolveFieldDecorators(field, modelShape, callShape, decoratorSpecs);
      if (resolved.optional !== null && descriptorOptional === null) {
        descriptorOptional = resolved.optional;
      }
      decoratorWireName = resolved.wireName;
    }

    // Struct-tag wire naming + omitempty (Go): the tag's name replaces the
    // declared one; a tag-excluded field keeps its declared name.
    for (const declared of declaredNames) {
      let name = decoratorWireName ?? declared;
      let tagOptional: boolean | null = null;
      const tag = modelShape.fieldTag(field);
      if (tag) {
        for (const key of tagKeys) {
          const wire = tagWireName(tag, key);
          if (wire) {
            name = wire.name;
            if (wire.optional) tagOptional = true;
            break;
          }
        }
      }

      const normalized = normalizeField({
        rawType,
        markerOptional,
        descriptorOptional: tagOptional ?? descriptorOptional,
        descriptorDefaultOptional,
        typeAliases: descriptor.typeAliases,
        typeWrappers: descriptor.transparentTypeWrappers,
        defaultFieldOptionality: descriptor.defaultFieldOptionality,
      });
      out.push({ name, ...normalized });
    }
  }
  return { fields: out, sawFieldCallee };
}

/**
 * Extract every marked model from a parsed tree — PURE over its inputs.
 * `callShape` may be null (a grammar with a model row but no call row);
 * decorator and field-constructor recognition degrade gracefully.
 */
export function extractModelsFromTree(
  root: Node,
  descriptor: ModelSchemaSupport,
  modelShape: GrammarModelShape,
  callShape: GrammarShape | null,
  file: string,
): ModelSet {
  const models: ModelEntity[] = [];
  const dynamicModels: DynamicModelSite[] = [];
  const classTypes = new Set(modelShape.classNodes);

  walk(root, (node) => {
    if (!classTypes.has(node.type)) return undefined;
    const name = modelShape.className(node);
    if (name === null) return undefined;
    const recognized = recognizeModel(node, descriptor, modelShape, callShape);
    if (recognized === null) return undefined;

    const { fields, sawFieldCallee } = extractFields(node, descriptor, modelShape, callShape);
    // A weak heritage match (a too-generic base name) needs corroboration:
    // no ORM field constructor in the body → not a model, skip silently.
    if (recognized.weak && !sawFieldCallee) return undefined;
    const entity: ModelEntity = { name, via: recognized.via, file, line: line(node), fields };
    models.push(entity);
    if (fields.length === 0) {
      dynamicModels.push({ name, file, line: line(node) });
    }
    return undefined;
  });

  return { models, dynamicModels };
}

/** Empty result for files that cannot contribute (no grammar/descriptor/
 *  shape) — distinct from `null` (unparseable file, skip silently). */
const EMPTY: ModelSet = { models: [], dynamicModels: [] };

/**
 * Extract one file's models: parse via the canonical AST layer, resolve the
 * pack descriptor by the file's language and the shapes by its grammar.
 * Returns null when the file cannot be parsed — callers skip, never error.
 */
export async function extractFileModels(
  filePath: string,
  relPath?: string,
): Promise<ModelSet | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  const descriptor = getLanguage(parsed.languageId)?.modelSchema;
  const modelShape = modelShapeForGrammar(parsed.grammar);
  if (!descriptor || !modelShape) return EMPTY;
  const callShape = grammarShape(parsed.grammar);
  return extractModelsFromTree(
    parsed.tree.rootNode,
    descriptor,
    modelShape,
    callShape,
    relPath ?? filePath,
  );
}
