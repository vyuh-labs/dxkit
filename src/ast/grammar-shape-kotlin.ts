/**
 * The Kotlin grammar-shape row — fully hand-written because the bundled
 * kotlin wasm (tree-sitter-wasms@0.1.13, ABI 14) defines ZERO grammar
 * fields: `childForFieldName` always returns null, so every read navigates
 * by child NODE TYPE and position. Verified against the wasm artifact; if
 * the bundled kotlin grammar is ever bumped to a build WITH fields, these
 * position-based reads keep working but should be revisited.
 *
 * The shapes this row encapsulates (all verified):
 *   - a call is `call_expression [callee, call_suffix]`; the callee child is
 *     `simple_identifier` (bare), `navigation_expression` (member:
 *     `[receiver, navigation_suffix > simple_identifier]`), or another
 *     `call_expression` — the TRAILING-LAMBDA outer node (`get("/x") { }`),
 *     which resolves to null while the walk still visits the inner call;
 *   - arguments live in `call_suffix > value_arguments > value_argument*`;
 *     a NAMED argument has two named children (`[simple_identifier, expr]`),
 *     a positional one has one;
 *   - `constructor_invocation [user_type, value_arguments]` appears in
 *     ANNOTATIONS (`@GetMapping("/x")`) and heritage — it is NOT a
 *     `call_expression`, so the call readers accept it too (the decorator
 *     round-trip);
 *   - an annotation wraps `user_type` (marker `@Serializable`) or
 *     `constructor_invocation` (called), optionally behind a
 *     `use_site_target` (`@field:Column`).
 */

import type { Node } from './parse';
import type { GrammarShape, ResolvedCall } from '@vyuhlabs/dxkit-sdk';

/** First named child of a given type, else null. */
function childOfType(node: Node, type: string): Node | null {
  for (const c of node.namedChildren) {
    if (c && c.type === type) return c;
  }
  return null;
}

/** Trailing identifier segment of a dotted reference (`HttpMethod.Get` → `Get`). */
function tail(text: string): string {
  const parts = text.split('.');
  return parts[parts.length - 1].trim();
}

/** The `value_arguments` node of a call_expression / constructor_invocation. */
function valueArguments(node: Node): Node | null {
  if (node.type === 'constructor_invocation') return childOfType(node, 'value_arguments');
  if (node.type !== 'call_expression') return null;
  const suffix = childOfType(node, 'call_suffix');
  return suffix ? childOfType(suffix, 'value_arguments') : null;
}

/** All `value_argument` entries of a call, split into positional/named form.
 *  A named argument (`name = expr`) carries two named children. */
function argumentEntries(node: Node): Array<{ name: string | null; value: Node }> {
  const va = valueArguments(node);
  if (!va) return [];
  const out: Array<{ name: string | null; value: Node }> = [];
  for (const arg of va.namedChildren) {
    if (!arg || arg.type !== 'value_argument') continue;
    const named = arg.namedChildren.filter((c): c is Node => c != null);
    if (named.length >= 2 && named[0].type === 'simple_identifier') {
      out.push({ name: named[0].text, value: named[1] });
    } else if (named.length >= 1) {
      out.push({ name: null, value: named[0] });
    }
  }
  return out;
}

/** The callee child of a call_expression (its first named child). */
function calleeChild(call: Node): Node | null {
  if (call.type !== 'call_expression') return null;
  return call.namedChildren.find((c): c is Node => c != null) ?? null;
}

export const KOTLIN: GrammarShape = {
  callNodes: ['call_expression'],

  resolveCall(call: Node): ResolvedCall | null {
    if (call.type === 'constructor_invocation') {
      // Annotation round-trip: `@GetMapping("/x")` — bare, name = type tail.
      const ut = childOfType(call, 'user_type');
      return ut ? { kind: 'bare', name: tail(ut.text), receiver: '' } : null;
    }
    if (call.type === 'user_type') {
      // Marker-annotation round-trip: `@GET` — a call with no arguments.
      return { kind: 'bare', name: tail(call.text), receiver: '' };
    }
    const callee = calleeChild(call);
    if (!callee) return null;
    if (callee.type === 'simple_identifier') {
      return { kind: 'bare', name: callee.text, receiver: '' };
    }
    if (callee.type === 'navigation_expression') {
      const named = callee.namedChildren.filter((c): c is Node => c != null);
      const receiver = named[0];
      const suffix = named.find((c) => c.type === 'navigation_suffix');
      const name = suffix ? childOfType(suffix, 'simple_identifier') : null;
      if (!name) return null;
      return { kind: 'member', name: name.text, receiver: receiver?.text ?? '' };
    }
    // Trailing-lambda outer node (callee is itself a call): no callee form of
    // its own — the walk visits the inner call, which resolves normally.
    return null;
  },

  firstArg(call: Node): Node | null {
    for (const e of argumentEntries(call)) {
      if (e.name === null) return e.value;
    }
    return null;
  },

  positionalArgs(call: Node): Node[] {
    return argumentEntries(call)
      .filter((e) => e.name === null)
      .map((e) => e.value);
  },

  stringText(node: Node): string | null {
    return node.type === 'string_literal' ? node.text : null;
  },

  decoratorNodes: ['annotation'],

  decoratorCall(decorator: Node): Node | null {
    // Called form: the inner constructor_invocation. Marker form: the inner
    // user_type (returned so split-pair markers still resolve). Returning the
    // INNER node also sidesteps use-site-target text (`@field:Column`) — its
    // text carries no `@`/use-site prefix.
    return childOfType(decorator, 'constructor_invocation') ?? childOfType(decorator, 'user_type');
  },

  optionValue(call: Node, name: string): Node | null {
    for (const e of argumentEntries(call)) {
      if (e.name === name) return e.value;
    }
    return null;
  },

  listStrings(node: Node): string[] {
    if (node.type !== 'collection_literal') return [];
    const out: string[] = [];
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'string_literal') out.push(c.text);
      // Enum refs (`RequestMethod.GET`) contribute their tail (G3 contract).
      else if (c.type === 'navigation_expression' || c.type === 'simple_identifier') {
        out.push(tail(c.text));
      }
    }
    return out;
  },

  functionNodes: ['function_declaration'],

  calleeCall(call: Node): Node | null {
    const callee = calleeChild(call);
    return callee && callee.type === 'call_expression' ? callee : null;
  },

  receiverNode(call: Node): Node | null {
    const callee = calleeChild(call);
    if (!callee || callee.type !== 'navigation_expression') return null;
    return callee.namedChildren.find((c): c is Node => c != null) ?? null;
  },

  hasTrailingLambda(call: Node): boolean {
    // Same-node form: a call_suffix carrying an annotated_lambda.
    const suffix = childOfType(call, 'call_suffix');
    if (
      suffix &&
      (childOfType(suffix, 'annotated_lambda') || childOfType(suffix, 'lambda_literal'))
    ) {
      return true;
    }
    // Outer-node form (the verified Ktor shape): `get("/x") { }` parses as an
    // OUTER call whose callee is this call and whose call_suffix holds the
    // lambda — the matched inner call must look one level up.
    const parent = call.parent;
    if (parent && parent.type === 'call_expression') {
      const parentCallee = calleeChild(parent);
      if (parentCallee && parentCallee.id === call.id) {
        const ps = childOfType(parent, 'call_suffix');
        if (ps && (childOfType(ps, 'annotated_lambda') || childOfType(ps, 'lambda_literal'))) {
          return true;
        }
      }
    }
    return false;
  },
};

// ─── The Kotlin MODEL row (same zero-field grammar, same module) ────────────

import type { GrammarModelShape } from '@vyuhlabs/dxkit-sdk';

/** Annotations attached to a Kotlin declaration — under a `modifiers`
 *  (classes, body properties) or `parameter_modifiers` (constructor params)
 *  child. Returns the INNER node (`user_type` for markers,
 *  `constructor_invocation` for called forms) so a use-site target
 *  (`@field:Column`) never reaches `decoratorName`'s lexical read. */
function kotlinAnnotationInners(node: Node): Node[] {
  const out: Node[] = [];
  for (const c of node.namedChildren) {
    if (!c || (c.type !== 'modifiers' && c.type !== 'parameter_modifiers')) continue;
    for (const ann of c.namedChildren) {
      if (!ann || ann.type !== 'annotation') continue;
      const inner = childOfType(ann, 'constructor_invocation') ?? childOfType(ann, 'user_type');
      if (inner) out.push(inner);
    }
  }
  return out;
}

/** The declared-type child of a parameter / variable declaration:
 *  `nullable_type` (`String?`) or `user_type` (`String`, `List<Tag>`). */
function kotlinTypeChild(node: Node): Node | null {
  return childOfType(node, 'nullable_type') ?? childOfType(node, 'user_type');
}

export const KOTLIN_MODEL: GrammarModelShape = {
  classNodes: ['class_declaration', 'object_declaration'],

  className(node) {
    return childOfType(node, 'type_identifier')?.text ?? null;
  },

  heritage(node) {
    // `class User : BaseEntity(), Serializable` — each delegation_specifier
    // wraps a user_type (interface) or constructor_invocation (superclass
    // call; its user_type text matches markers without the `()`).
    const out: string[] = [];
    for (const c of node.namedChildren) {
      if (!c || c.type !== 'delegation_specifier') continue;
      const ctor = childOfType(c, 'constructor_invocation');
      const ut = ctor ? childOfType(ctor, 'user_type') : childOfType(c, 'user_type');
      out.push((ut ?? c).text);
    }
    return out;
  },

  classDecorators(node) {
    return kotlinAnnotationInners(node);
  },

  fieldNodes(classNode) {
    // Kotlin models keep fields in TWO places: primary-constructor
    // parameters that bind a property (val/var — a plain parameter has no
    // binding_pattern_kind), and class-body property declarations.
    const out: Node[] = [];
    const ctor = childOfType(classNode, 'primary_constructor');
    if (ctor) {
      for (const p of ctor.namedChildren) {
        if (p && p.type === 'class_parameter' && childOfType(p, 'binding_pattern_kind')) {
          out.push(p);
        }
      }
    }
    const body = childOfType(classNode, 'class_body');
    if (body) {
      for (const p of body.namedChildren) {
        if (p && p.type === 'property_declaration') out.push(p);
      }
    }
    return out;
  },

  fieldNames(field) {
    if (field.type === 'class_parameter') {
      const name = childOfType(field, 'simple_identifier');
      return name ? [name.text] : [];
    }
    const decl = childOfType(field, 'variable_declaration');
    const name = decl ? childOfType(decl, 'simple_identifier') : null;
    return name ? [name.text] : [];
  },

  fieldTypeText(field) {
    if (field.type === 'class_parameter') return kotlinTypeChild(field)?.text ?? null;
    const decl = childOfType(field, 'variable_declaration');
    return decl ? (kotlinTypeChild(decl)?.text ?? null) : null;
  },

  fieldOptionalMarker(field) {
    // Kotlin gives REAL grammar-level optionality: `String?` is a
    // nullable_type. No declared type (inferred `val id = integer("id")`)
    // → null, the honest unknown.
    const holder =
      field.type === 'class_parameter' ? field : childOfType(field, 'variable_declaration');
    if (!holder) return null;
    if (childOfType(holder, 'nullable_type')) return true;
    return childOfType(holder, 'user_type') !== null ? false : null;
  },

  fieldTag() {
    return null;
  },

  fieldValueCall(field) {
    return childOfType(field, 'call_expression');
  },

  fieldDecorators(field) {
    return kotlinAnnotationInners(field);
  },
};
