/**
 * Grammar MODEL shapes — the per-grammar syntax-access layer for data-model
 * declarations, sibling of `grammar-shape.ts` (which covers call/decorator/
 * string syntax for the flow extractor).
 *
 * Different grammars express "a named type with fields" differently:
 * TypeScript has `class_declaration` / `public_field_definition` (with the
 * export-statement decorator quirk), Python has `class_definition` with
 * `assignment` statements in the body (and `decorated_definition` wrapping),
 * Go has `type_spec` + `struct_type` + `field_declaration` (with tags and
 * multi-name declarations). Those are facts about the GRAMMAR ARTIFACT — not
 * about a pack's frameworks (which live in `LanguageSupport.modelSchema`) and
 * not about drift semantics (which live in `src/analyzers/model-schema/`).
 *
 * The division of labor mirrors flow's:
 *   - `src/languages/<id>.ts:modelSchema`      — WHICH constructs are models
 *     (framework facts: base classes, decorators, tag keys — per pack);
 *   - THIS module                               — HOW to read a class / field /
 *     type annotation / heritage / tag from this grammar (syntax, per grammar);
 *   - `src/analyzers/model-schema/extract.ts`   — WHAT they mean (semantics,
 *     grammar-agnostic, edited for no one language).
 *
 * Every function is total over arbitrary nodes (returns null / empty rather
 * than throwing) so the extractor stays fail-open. Rows are added with their
 * language wave, each verified against the bundled wasm artifact — an
 * unverified row is worse than a missing one.
 */

import type { Node } from './parse';
import { KOTLIN_MODEL } from './grammar-shape-kotlin';

// GrammarModelShape moved to @vyuhlabs/dxkit-sdk (Rule 18, sibling of
// GrammarShape). The per-grammar rows + dispatch below stay internal.
import type { GrammarModelShape } from '@vyuhlabs/dxkit-sdk';

export type { GrammarModelShape };

/** Children of `node` occupying grammar field `field`, cursor-collected
 *  (works for repeated fields, which `childForFieldName` truncates). */
function childrenForField(node: Node, field: string): Node[] {
  const out: Node[] = [];
  const cursor = node.walk();
  if (cursor.gotoFirstChild()) {
    do {
      const n = cursor.currentNode;
      if (n && n.isNamed && cursor.currentFieldName === field) out.push(n);
    } while (cursor.gotoNextSibling());
  }
  return out;
}

function namedChildrenOfType(node: Node, type: string): Node[] {
  const out: Node[] = [];
  for (const c of node.namedChildren) if (c && c.type === type) out.push(c);
  return out;
}

// ─── Shape rows ──────────────────────────────────────────────────────────────

/** TS / TSX / JS share one shape. JS classes have no type annotations or
 *  `?` markers — those reads return null/false there, which is correct:
 *  a JS model's facts come from decorators and the normalizer's unknowns. */
const JS_FAMILY: GrammarModelShape = {
  classNodes: ['class_declaration'],

  className(node) {
    return node.childForFieldName('name')?.text ?? null;
  },

  heritage(node) {
    // class_heritage is a plain named child (not a field): it wraps
    // extends_clause (field `value`) and optionally implements_clause.
    const out: string[] = [];
    for (const h of namedChildrenOfType(node, 'class_heritage')) {
      for (const ext of namedChildrenOfType(h, 'extends_clause')) {
        const v = ext.childForFieldName('value');
        if (v) out.push(v.text);
      }
    }
    return out;
  },

  classDecorators(node) {
    // Decorators of `export class` hoist onto the export_statement. Collected
    // by node TYPE (not grammar field) — TS attaches them as `decorator`
    // fields, plain JS as bare children; type-matching covers both.
    const own = namedChildrenOfType(node, 'decorator');
    const parent = node.parent;
    if (parent && parent.type === 'export_statement') {
      return [...namedChildrenOfType(parent, 'decorator'), ...own];
    }
    return own;
  },

  fieldNodes(classNode) {
    // TS names the node public_field_definition; plain JS names it
    // field_definition (verified against both wasms).
    const body = classNode.childForFieldName('body');
    if (!body) return [];
    return [
      ...namedChildrenOfType(body, 'public_field_definition'),
      ...namedChildrenOfType(body, 'field_definition'),
    ];
  },

  fieldNames(field) {
    // TS field: `name`; JS field_definition: `property`.
    const name = field.childForFieldName('name') ?? field.childForFieldName('property');
    return name ? [name.text] : [];
  },

  fieldTypeText(field) {
    // type_annotation's text includes the leading ':'; the named child is the
    // type itself.
    const ann = field.childForFieldName('type');
    const inner = ann?.namedChildren.find((c) => c !== null);
    return inner?.text ?? null;
  },

  fieldOptionalMarker(field) {
    // Three-valued (the honesty contract): a `?` token → optional; a type
    // annotation WITHOUT `?` → required (TS semantics); no annotation at all
    // (plain JS, or an inferred field) → null — the grammar genuinely cannot
    // tell, and a fabricated `required` would let the diff block on it.
    for (const c of field.children) {
      if (c && !c.isNamed && c.type === '?') return true;
    }
    return field.childForFieldName('type') !== null ? false : null;
  },

  fieldTag() {
    return null;
  },

  fieldValueCall(field) {
    const value = field.childForFieldName('value');
    return value && value.type === 'call_expression' ? value : null;
  },

  fieldDecorators(field) {
    return namedChildrenOfType(field, 'decorator');
  },
};

const PYTHON: GrammarModelShape = {
  classNodes: ['class_definition'],

  className(node) {
    return node.childForFieldName('name')?.text ?? null;
  },

  heritage(node) {
    // superclasses is an argument_list; skip keyword arguments (metaclass=…).
    const sup = node.childForFieldName('superclasses');
    if (!sup) return [];
    const out: string[] = [];
    for (const c of sup.namedChildren) {
      if (c && c.type !== 'keyword_argument') out.push(c.text);
    }
    return out;
  },

  classDecorators(node) {
    // @decorated classes are wrapped: decorated_definition > decorator*,
    // [definition] class_definition.
    const parent = node.parent;
    if (parent && parent.type === 'decorated_definition') {
      return namedChildrenOfType(parent, 'decorator');
    }
    return [];
  },

  fieldNodes(classNode) {
    // Class-level fields are `assignment` nodes directly under the body block
    // (inside expression_statement wrappers). Method bodies are nested deeper
    // and never direct children, so they are naturally excluded.
    const body = classNode.childForFieldName('body');
    if (!body) return [];
    const out: Node[] = [];
    for (const stmt of namedChildrenOfType(body, 'expression_statement')) {
      for (const a of namedChildrenOfType(stmt, 'assignment')) out.push(a);
    }
    return out;
  },

  fieldNames(field) {
    const left = field.childForFieldName('left');
    return left && left.type === 'identifier' ? [left.text] : [];
  },

  fieldTypeText(field) {
    return field.childForFieldName('type')?.text ?? null;
  },

  fieldOptionalMarker() {
    // Python has no grammar-level marker; `Optional[…]` / `| None` are
    // lexical forms the normalizer folds, `null=True` is a framework fact.
    return null;
  },

  fieldTag() {
    return null;
  },

  fieldValueCall(field) {
    const right = field.childForFieldName('right');
    return right && right.type === 'call' ? right : null;
  },

  fieldDecorators() {
    return [];
  },
};

const GO: GrammarModelShape = {
  classNodes: ['type_spec'],

  className(node) {
    // Only struct-typed specs declare fields; aliases and non-struct types
    // are not model-bearing.
    if (node.childForFieldName('type')?.type !== 'struct_type') return null;
    return node.childForFieldName('name')?.text ?? null;
  },

  heritage() {
    return [];
  },

  classDecorators() {
    return [];
  },

  fieldNodes(classNode) {
    const struct = classNode.childForFieldName('type');
    if (!struct || struct.type !== 'struct_type') return [];
    const list = namedChildrenOfType(struct, 'field_declaration_list')[0];
    if (!list) return [];
    return namedChildrenOfType(list, 'field_declaration');
  },

  fieldNames(field) {
    // `X, Y int` declares several names in one field_declaration; an
    // embedded field has none and is skipped by the caller.
    return childrenForField(field, 'name').map((n) => n.text);
  },

  fieldTypeText(field) {
    return field.childForFieldName('type')?.text ?? null;
  },

  fieldOptionalMarker(field) {
    return field.childForFieldName('type')?.type === 'pointer_type';
  },

  fieldTag(field) {
    return field.childForFieldName('tag')?.text ?? null;
  },

  fieldValueCall() {
    return null;
  },

  fieldDecorators() {
    return [];
  },
};

/** Annotations attached to a Java declaration — they sit inside a `modifiers`
 *  child (never as siblings), in with-arguments and marker forms. */
function javaAnnotations(node: Node): Node[] {
  const out: Node[] = [];
  for (const c of node.namedChildren) {
    if (!c || c.type !== 'modifiers') continue;
    out.push(
      ...namedChildrenOfType(c, 'annotation'),
      ...namedChildrenOfType(c, 'marker_annotation'),
    );
  }
  return out;
}

/** Java (verified vs the bundled wasm): `class_declaration` +
 *  `record_declaration` (a record's components are its `parameters`), fields
 *  as `field_declaration` with REPEATED `declarator` children (`int a, b;` —
 *  the Go multi-name pattern), annotations under a `modifiers` child. Java
 *  has NO grammar-level optionality marker — `@Column(nullable = …)` is a
 *  framework fact (`fieldDecoratorSpecs`), so the marker read is null. */
const JAVA: GrammarModelShape = {
  classNodes: ['class_declaration', 'record_declaration'],

  className(node) {
    return node.childForFieldName('name')?.text ?? null;
  },

  heritage(node) {
    const out: string[] = [];
    const sup = node.childForFieldName('superclass');
    if (sup) for (const c of sup.namedChildren) if (c) out.push(c.text);
    const ifaces = node.childForFieldName('interfaces');
    if (ifaces) {
      for (const list of namedChildrenOfType(ifaces, 'type_list')) {
        for (const t of list.namedChildren) if (t) out.push(t.text);
      }
    }
    return out;
  },

  classDecorators(node) {
    return javaAnnotations(node);
  },

  fieldNodes(classNode) {
    // Records carry their components as parameters; classes as body fields.
    if (classNode.type === 'record_declaration') {
      const params = classNode.childForFieldName('parameters');
      return params ? namedChildrenOfType(params, 'formal_parameter') : [];
    }
    const body = classNode.childForFieldName('body');
    return body ? namedChildrenOfType(body, 'field_declaration') : [];
  },

  fieldNames(field) {
    if (field.type === 'formal_parameter') {
      const name = field.childForFieldName('name');
      return name ? [name.text] : [];
    }
    // `private int a, b;` → repeated `declarator` children, one name each.
    return childrenForField(field, 'declarator')
      .map((d) => d.childForFieldName('name')?.text)
      .filter((t): t is string => t !== undefined);
  },

  fieldTypeText(field) {
    return field.childForFieldName('type')?.text ?? null;
  },

  fieldOptionalMarker() {
    return null;
  },

  fieldTag() {
    return null;
  },

  fieldValueCall(field) {
    const decl = childrenForField(field, 'declarator')[0];
    const value = decl?.childForFieldName('value');
    return value && value.type === 'method_invocation' ? value : null;
  },

  fieldDecorators(field) {
    return javaAnnotations(field);
  },
};

const MODEL_SHAPES: Readonly<Record<string, GrammarModelShape>> = {
  typescript: JS_FAMILY,
  tsx: JS_FAMILY,
  javascript: JS_FAMILY,
  python: PYTHON,
  go: GO,
  java: JAVA,
  kotlin: KOTLIN_MODEL,
};

/** The model shape for a logical grammar name, or null when no row exists —
 *  callers treat null as "this grammar's files cannot contribute models" and
 *  skip, never throw. */
export function modelShapeForGrammar(grammar: string): GrammarModelShape | null {
  return MODEL_SHAPES[grammar] ?? null;
}

/** Grammar names with a model-shape row (pack-contract completeness test). */
export function modelShapedGrammars(): string[] {
  return Object.keys(MODEL_SHAPES);
}
