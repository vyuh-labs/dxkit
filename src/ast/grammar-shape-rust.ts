/**
 * The Rust grammar-shape row — hand-written for two structural deviations no
 * factory covers:
 *
 *   - TWO member-callee forms: `field_expression` (`client.get(...)` —
 *     fields `value`/`field`) AND `scoped_identifier` (`reqwest::get(...)`,
 *     `Router::new()` — fields `path`/`name`). Both resolve as members so a
 *     pack can trust `reqwest`/`web` receivers.
 *   - Attributes are PRECEDING SIBLINGS of the item they decorate
 *     (`attribute_item` before `function_item`/`struct_item`/
 *     `field_declaration`), not children — inverted vs every wave-1/2
 *     grammar. The decorated-handler-name fallback's next-named-sibling walk
 *     handles the association; the parent-climb prefix paths never see the
 *     item, which is harmless because the Rust pack declares no
 *     `routePrefixDecorators`.
 *
 * Attribute ARGUMENTS are token soup: `#[serde(rename = "x")]` puts bare
 * `identifier` + `string_literal` tokens in a `token_tree` (no pair nodes),
 * so `optionValue` scans identifier-then-value. All shapes verified against
 * the bundled `tree-sitter-rust.wasm` (tree-sitter-wasms, ABI 14).
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

const STRING_TYPES = new Set(['string_literal', 'raw_string_literal']);

/** The inner `attribute` of an `attribute_item`, or the node itself when it
 *  already IS the attribute (round-trips from `decoratorCall`). */
function attributeNode(node: Node): Node | null {
  if (node.type === 'attribute') return node;
  if (node.type === 'attribute_item') return childOfType(node, 'attribute');
  return null;
}

/** Positional argument nodes: call arguments are DIRECT expression children
 *  of `arguments` (no wrappers, no keyword args in Rust); attribute
 *  arguments are the named children of the `token_tree`. */
function positionalArgs(node: Node): Node[] {
  const attr = attributeNode(node);
  const list = attr
    ? attr.childForFieldName('arguments')
    : node.type === 'call_expression'
      ? node.childForFieldName('arguments')
      : null;
  if (!list) return [];
  const out: Node[] = [];
  for (const c of list.namedChildren) if (c) out.push(c);
  return out;
}

export const RUST: GrammarShape = {
  callNodes: ['call_expression'],

  resolveCall(call: Node): ResolvedCall | null {
    // Fused attribute round-trip: `#[get("/x")]` / `#[actix_web::post("/y")]`
    // — the attribute is the invocation; a scoped name contributes its tail.
    const attr = attributeNode(call);
    if (attr) {
      const scoped = childOfType(attr, 'scoped_identifier');
      if (scoped) {
        const name = scoped.childForFieldName('name');
        return name ? { kind: 'bare', name: name.text, receiver: '' } : null;
      }
      const ident = childOfType(attr, 'identifier');
      return ident ? { kind: 'bare', name: ident.text, receiver: '' } : null;
    }
    if (call.type !== 'call_expression') return null;
    const callee = call.childForFieldName('function');
    if (!callee) return null;
    if (callee.type === 'identifier') {
      return { kind: 'bare', name: callee.text, receiver: '' };
    }
    if (callee.type === 'field_expression') {
      const name = callee.childForFieldName('field');
      const obj = callee.childForFieldName('value');
      if (!name) return null;
      return { kind: 'member', name: name.text, receiver: obj?.text ?? '' };
    }
    if (callee.type === 'scoped_identifier') {
      const name = callee.childForFieldName('name');
      const path = callee.childForFieldName('path');
      if (!name) return null;
      return { kind: 'member', name: name.text, receiver: path?.text ?? '' };
    }
    return null;
  },

  firstArg(call: Node): Node | null {
    return positionalArgs(call)[0] ?? null;
  },

  positionalArgs,

  stringText(node: Node): string | null {
    if (!STRING_TYPES.has(node.type)) return null;
    // Raw strings: `r"/x"` / `br"…"` — strip the letter prefix (and any `#`
    // guards) so quote-stripping sees the quote first.
    return node.text.replace(/^[A-Za-z]{1,2}#*(?=")/, '');
  },

  decoratorNodes: ['attribute_item'],

  decoratorCall(decorator: Node): Node | null {
    // The inner `attribute` is the invocation (fused, marker forms included).
    return attributeNode(decorator);
  },

  optionValue(call: Node, name: string): Node | null {
    // Token-soup scan: `#[serde(rename = "x")]` → identifier `rename`
    // followed by the value token. Only attributes carry named options in
    // the declared Rust forms.
    const args = positionalArgs(call);
    for (let i = 0; i < args.length; i++) {
      if (args[i].type === 'identifier' && args[i].text === name) {
        return args[i + 1] ?? null;
      }
    }
    return null;
  },

  listStrings(): string[] {
    return [];
  },

  functionNodes: ['function_item'],

  calleeCall(): Node | null {
    // Rust callees are identifiers/members, never calls — chains link
    // through the receiver (`value`) side.
    return null;
  },

  receiverNode(call: Node): Node | null {
    if (call.type !== 'call_expression') return null;
    const callee = call.childForFieldName('function');
    if (!callee || callee.type !== 'field_expression') return null;
    return callee.childForFieldName('value');
  },
};

// ─── The Rust MODEL row (same grammar, same module) ──────────────────────────

import type { GrammarModelShape } from '@vyuhlabs/dxkit-sdk';

/**
 * Attribute nodes decorating an item — its preceding `attribute_item`
 * SIBLINGS, scanned backwards until a non-attribute named node. Derive
 * attributes EXPAND: `#[derive(Serialize, Deserialize)]` contributes each
 * token-tree identifier (so `decoratorName` reads `Serialize`), any other
 * attribute contributes its inner `attribute` node (name `serde`, options
 * readable via the call row's token-soup `optionValue`).
 */
function precedingAttributes(node: Node): Node[] {
  const out: Node[] = [];
  let sib: Node | null = node.previousNamedSibling;
  while (sib && sib.type === 'attribute_item') {
    const attr = childOfType(sib, 'attribute');
    if (attr) {
      const head = childOfType(attr, 'identifier');
      const args = attr.childForFieldName('arguments');
      if (head && head.text === 'derive' && args) {
        for (const t of args.namedChildren) {
          if (t && t.type === 'identifier') out.push(t);
        }
      } else {
        out.push(attr);
      }
    }
    sib = sib.previousNamedSibling;
  }
  return out;
}

export const RUST_MODEL: GrammarModelShape = {
  classNodes: ['struct_item'],

  className(node) {
    return node.childForFieldName('name')?.text ?? null;
  },

  heritage() {
    return [];
  },

  classDecorators(node) {
    return precedingAttributes(node);
  },

  fieldNodes(classNode) {
    const body = classNode.childForFieldName('body');
    if (!body || body.type !== 'field_declaration_list') return [];
    const out: Node[] = [];
    for (const f of body.namedChildren) {
      if (f && f.type === 'field_declaration') out.push(f);
    }
    return out;
  },

  fieldNames(field) {
    const name = field.childForFieldName('name');
    return name ? [name.text] : [];
  },

  fieldTypeText(field) {
    return field.childForFieldName('type')?.text ?? null;
  },

  fieldOptionalMarker(field) {
    // `Option<T>` is precise grammar-level optionality; any other declared
    // type is required (Rust types are total). No type → null.
    const type = field.childForFieldName('type');
    if (!type) return null;
    if (type.type === 'generic_type') {
      return type.childForFieldName('type')?.text === 'Option';
    }
    return false;
  },

  fieldTag() {
    return null;
  },

  fieldValueCall() {
    return null;
  },

  fieldDecorators(field) {
    return precedingAttributes(field);
  },
};
