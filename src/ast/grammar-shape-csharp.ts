/**
 * The C# grammar-shape row — hand-written because the `c_sharp` grammar is a
 * third family: calls are callee-field (`invocation_expression` with
 * `function`/`arguments` fields, like TS/Go) but attributes are FUSED (the
 * attribute IS the invocation, like Java annotations), and the argument
 * encodings deviate from both factories:
 *
 *   - every call argument is wrapped in an `argument` node (positional AND
 *     named; a named argument carries a `name_colon` child);
 *   - attribute arguments are `attribute_argument` wrappers (named iff a
 *     `name_equals` child);
 *   - a member callee's `name` may be a `generic_name`
 *     (`GetFromJsonAsync<User>`) whose bare name is its `identifier` child —
 *     the verbatim text would include the type arguments;
 *   - interpolated strings (`$"/x/{id}"`, `$@"…"`) keep their `$`/`$@` prefix
 *     in the node text, which must be stripped before quote-sensitive
 *     normalization (the Python-prefix pattern).
 *
 * All shapes verified against the bundled `tree-sitter-c_sharp.wasm`
 * (tree-sitter-wasms, ABI 14). C#-11 raw string literals (`"""…"""`) parse
 * as expression soup in this wasm build — those strings are unreadable and
 * the coverage docs disclose it.
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

/** Trailing identifier segment of a dotted/qualified name. */
function tail(text: string): string {
  const parts = text.split('.');
  return parts[parts.length - 1].trim();
}

const STRING_TYPES = new Set([
  'string_literal',
  'verbatim_string_literal',
  'interpolated_string_expression',
]);

/** Argument entries of a call (`argument` wrappers, named iff `name_colon`)
 *  or an attribute (`attribute_argument` wrappers, named iff `name_equals`).
 *  The entry value is the wrapper's LAST named child (the name marker
 *  precedes it in named forms). */
function argumentEntries(node: Node): Array<{ name: string | null; value: Node }> {
  const list =
    node.type === 'attribute'
      ? childOfType(node, 'attribute_argument_list')
      : node.childForFieldName('arguments');
  if (!list) return [];
  const out: Array<{ name: string | null; value: Node }> = [];
  for (const arg of list.namedChildren) {
    if (!arg || (arg.type !== 'argument' && arg.type !== 'attribute_argument')) continue;
    const marker = childOfType(arg, 'name_colon') ?? childOfType(arg, 'name_equals');
    const named = arg.namedChildren.filter((c): c is Node => c != null && c.id !== marker?.id);
    const value = named[named.length - 1];
    if (!value) continue;
    const name = marker ? (childOfType(marker, 'identifier')?.text ?? null) : null;
    out.push({ name, value });
  }
  return out;
}

export const CSHARP: GrammarShape = {
  callNodes: ['invocation_expression'],

  resolveCall(call: Node): ResolvedCall | null {
    // Fused attribute round-trip: `[HttpGet("/x")]` / marker `[HttpGet]` —
    // the attribute IS the invocation (the Java pattern). The name may be a
    // `qualified_name` ([Microsoft.AspNetCore.Mvc.HttpGet]) — tail wins.
    if (call.type === 'attribute') {
      const name = call.childForFieldName('name');
      return name ? { kind: 'bare', name: tail(name.text), receiver: '' } : null;
    }
    if (call.type !== 'invocation_expression') return null;
    const callee = call.childForFieldName('function');
    if (!callee) return null;
    if (callee.type === 'identifier') {
      return { kind: 'bare', name: callee.text, receiver: '' };
    }
    if (callee.type === 'member_access_expression') {
      const nameNode = callee.childForFieldName('name');
      const obj = callee.childForFieldName('expression');
      if (!nameNode) return null;
      // Generic member (`GetFromJsonAsync<Order>`): the bare name is the
      // generic_name's identifier child — the verbatim text carries `<…>`.
      const name =
        nameNode.type === 'generic_name'
          ? (childOfType(nameNode, 'identifier')?.text ?? nameNode.text)
          : nameNode.text;
      return { kind: 'member', name, receiver: obj?.text ?? '' };
    }
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
    if (!STRING_TYPES.has(node.type)) return null;
    // `$"/x/{id}"` / `$@"…"` / `@"…"` — strip the marker prefix so
    // quote-stripping and the URL guard see the quote first (the
    // interpolation braces then canonicalize as `{…}` → `{var}`).
    return node.text.replace(/^[$@]{1,2}(?=")/, '');
  },

  decoratorNodes: ['attribute'],

  decoratorCall(decorator: Node): Node | null {
    // Fused: the attribute node itself is the invocation (markers included).
    return decorator;
  },

  optionValue(call: Node, name: string): Node | null {
    for (const e of argumentEntries(call)) {
      if (e.name === name) return e.value;
    }
    return null;
  },

  listStrings(): string[] {
    // No wave-3 C# descriptor consumes list literals (attribute arguments
    // carrying arrays are not in the declared forms).
    return [];
  },

  functionNodes: ['method_declaration', 'local_function_statement', 'constructor_declaration'],

  calleeCall(): Node | null {
    // A C# callee is never itself a call for the declared forms (chains link
    // through the receiver expression).
    return null;
  },

  receiverNode(call: Node): Node | null {
    if (call.type !== 'invocation_expression') return null;
    const callee = call.childForFieldName('function');
    if (!callee || callee.type !== 'member_access_expression') return null;
    return callee.childForFieldName('expression');
  },

  enclosingTypeName(node: Node): string | null {
    let cur: Node | null = node.parent;
    while (cur) {
      if (cur.type === 'class_declaration' || cur.type === 'record_declaration') {
        return cur.childForFieldName('name')?.text ?? null;
      }
      cur = cur.parent;
    }
    return null;
  },
};

// ─── The C# MODEL row (same grammar, same module) ────────────────────────────

import type { GrammarModelShape } from '@vyuhlabs/dxkit-sdk';

/** Attributes attached to a C# declaration — each lives in its OWN
 *  `attribute_list` direct child (no `modifiers` wrapper, unlike Java). */
function csharpAttributes(node: Node): Node[] {
  const out: Node[] = [];
  for (const c of node.namedChildren) {
    if (!c || c.type !== 'attribute_list') continue;
    for (const a of c.namedChildren) {
      if (a && a.type === 'attribute') out.push(a);
    }
  }
  return out;
}

export const CSHARP_MODEL: GrammarModelShape = {
  classNodes: ['class_declaration', 'record_declaration'],

  className(node) {
    return node.childForFieldName('name')?.text ?? null;
  },

  heritage(node) {
    const bases = node.childForFieldName('bases');
    if (!bases) return [];
    const out: string[] = [];
    for (const b of bases.namedChildren) if (b) out.push(b.text);
    return out;
  },

  classDecorators(node) {
    return csharpAttributes(node);
  },

  fieldNodes(classNode) {
    // Records carry positional components as parameters; classes/records
    // with bodies carry property and field declarations.
    const out: Node[] = [];
    const params = classNode.childForFieldName('parameters');
    if (params) {
      for (const p of params.namedChildren) {
        if (p && p.type === 'parameter') out.push(p);
      }
    }
    const body = classNode.childForFieldName('body');
    if (body) {
      for (const m of body.namedChildren) {
        if (m && (m.type === 'property_declaration' || m.type === 'field_declaration')) {
          out.push(m);
        }
      }
    }
    return out;
  },

  fieldNames(field) {
    if (field.type === 'field_declaration') {
      const decl = childOfType(field, 'variable_declaration');
      if (!decl) return [];
      const out: string[] = [];
      for (const d of decl.namedChildren) {
        if (d && d.type === 'variable_declarator') {
          const name = d.namedChildren.find((c) => c?.type === 'identifier');
          if (name) out.push(name.text);
        }
      }
      return out;
    }
    const name = field.childForFieldName('name');
    return name ? [name.text] : [];
  },

  fieldTypeText(field) {
    if (field.type === 'field_declaration') {
      return childOfType(field, 'variable_declaration')?.childForFieldName('type')?.text ?? null;
    }
    return field.childForFieldName('type')?.text ?? null;
  },

  fieldOptionalMarker(field) {
    // Nullable reference/value types are REAL grammar-level optionality
    // (`string?` → nullable_type). A non-nullable annotation reads as
    // required — the declared-intent stance (same contract as TS/Kotlin);
    // non-NRT projects overstate requiredness, which is the documented
    // trade-off. No type at all → null.
    const type =
      field.type === 'field_declaration'
        ? childOfType(field, 'variable_declaration')?.childForFieldName('type')
        : field.childForFieldName('type');
    if (!type) return null;
    return type.type === 'nullable_type';
  },

  fieldTag() {
    return null;
  },

  fieldValueCall() {
    return null;
  },

  fieldDecorators(field) {
    return csharpAttributes(field);
  },

  partialMarker(classNode) {
    for (const c of classNode.namedChildren) {
      if (c && c.type === 'modifier' && c.text === 'partial') return true;
    }
    return false;
  },
};
