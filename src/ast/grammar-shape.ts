/**
 * Grammar shapes — the per-GRAMMAR syntax-access layer that lets ONE flow
 * extractor walk any tree-sitter grammar.
 *
 * Different grammars name the same constructs differently: TypeScript emits
 * `call_expression` / `member_expression` (fields `object`/`property`), Python
 * emits `call` / `attribute` (fields `object`/`attribute`), Go emits
 * `call_expression` / `selector_expression` (fields `operand`/`field`). Those
 * names are facts about the GRAMMAR ARTIFACT — not about a language pack's
 * frameworks (which live in `LanguageSupport.httpFlow`, Rule 6) and not about
 * flow semantics (which live in `src/analyzers/flow/extract.ts`). So they live
 * here, in the AST layer, beside the logical-grammar-name → wasm mapping
 * (`parse.ts`) — the same engine-swap boundary.
 *
 * The division of labor:
 *   - `src/languages/<id>.ts:httpFlow`  — WHICH constructs are HTTP (framework
 *     facts, declarative, per pack);
 *   - THIS module                        — HOW to read a call / member / string /
 *     decorator / keyword-argument from this grammar's tree (syntax facts, per
 *     grammar);
 *   - `src/analyzers/flow/extract.ts`    — WHAT they mean for flow (semantics,
 *     grammar-agnostic, edited for no one language).
 *
 * Adding flow support for a new language therefore touches no extractor code:
 * declare `treeSitterGrammars` + `httpFlow` on the pack, and add a row here if
 * the grammar is new (most rows come from the shared callee-field factory
 * below). `test/languages-contract.test.ts` loud-fails a pack whose declared
 * grammar has no shape row.
 */

import { walk, type Node } from './parse';
import { KOTLIN } from './grammar-shape-kotlin';
import { CSHARP } from './grammar-shape-csharp';
import { RUST } from './grammar-shape-rust';

// ResolvedCall + GrammarShape moved to @vyuhlabs/dxkit-sdk (the frozen
// extension surface, CLAUDE.md Rule 18) — grammar-shape ACCESS types are
// contract for rung-4 plugins; the factory + per-grammar rows below stay
// internal. Re-exported so every existing consumer keeps this import path.
import type { GrammarShape, ResolvedCall } from '@vyuhlabs/dxkit-sdk';

export type { GrammarShape, ResolvedCall };

/** Inputs to the shared factory for callee-field grammars — those whose call
 *  node carries a `function` field holding an identifier or a member node
 *  (the TS/JS family, Python, Go). Fused-callee grammars (Java's
 *  `method_invocation` puts `object`/`name` on the call itself) get their own
 *  factory when their wave lands. */
interface CalleeFieldGrammar {
  readonly callNodes: readonly string[];
  readonly identifierNodes: readonly string[];
  readonly memberNode: string;
  readonly memberObjectField: string;
  readonly memberPropertyField: string;
  /** Node types whose text is a string literal. */
  readonly stringNodes: readonly string[];
  /** Strip a letter prefix before the opening quote (Python `f"…"`, `rb'…'`). */
  readonly stringPrefixes?: boolean;
  readonly decoratorNodes?: readonly string[];
  readonly functionNodes: readonly string[];
  /** Keyword-argument node + its fields, when the grammar has keyword args. */
  readonly keywordArg?: { node: string; nameField: string; valueField: string };
  /** Object-literal option bags (`fetch(url, { method: 'POST' })`), when the
   *  grammar expresses options that way. */
  readonly optionsObject?: { node: string; pairNode: string; keyField: string; valueField: string };
  /** Node type of a list/array literal (`methods=["GET"]`). */
  readonly listNode?: string;
}

/** Strip quotes/backticks off a literal's verbatim text (for key comparison). */
function bareKey(text: string): string {
  return text.replace(/['"`]/g, '');
}

function calleeFieldShape(g: CalleeFieldGrammar): GrammarShape {
  const stringTypes = new Set(g.stringNodes);
  const identifierTypes = new Set(g.identifierNodes);
  const callTypes = new Set(g.callNodes);

  const stringText = (node: Node): string | null => {
    if (!stringTypes.has(node.type)) return null;
    const text = node.text;
    // Python-style prefixed literals: `f"/x/{id}"`, `r'...'`, `rb'...'` — drop
    // the prefix so quote-stripping (and the URL guard) see the quote first.
    return g.stringPrefixes ? text.replace(/^[A-Za-z]{1,3}(?=['"])/, '') : text;
  };

  const namedArgs = (call: Node): Node[] => {
    const args = call.childForFieldName('arguments');
    if (!args) return [];
    const out: Node[] = [];
    for (const c of args.namedChildren) if (c) out.push(c);
    return out;
  };

  return {
    callNodes: g.callNodes,

    resolveCall(call: Node): ResolvedCall | null {
      const callee = call.childForFieldName('function');
      if (!callee) return null;
      if (identifierTypes.has(callee.type)) {
        return { kind: 'bare', name: callee.text, receiver: '' };
      }
      if (callee.type === g.memberNode) {
        const prop = callee.childForFieldName(g.memberPropertyField);
        const obj = callee.childForFieldName(g.memberObjectField);
        return { kind: 'member', name: prop?.text ?? '', receiver: obj?.text ?? '' };
      }
      return null;
    },

    firstArg(call: Node): Node | null {
      for (const arg of namedArgs(call)) {
        if (g.keywordArg && arg.type === g.keywordArg.node) continue; // positional only
        return arg;
      }
      return null;
    },

    positionalArgs(call: Node): Node[] {
      return namedArgs(call).filter((arg) => !(g.keywordArg && arg.type === g.keywordArg.node));
    },

    stringText,

    decoratorNodes: g.decoratorNodes ?? [],

    decoratorCall(decorator: Node): Node | null {
      for (const child of decorator.namedChildren) {
        if (child && callTypes.has(child.type)) return child;
      }
      return null;
    },

    optionValue(call: Node, name: string): Node | null {
      // Keyword-argument form: `route('/x', methods=[...])`.
      if (g.keywordArg) {
        for (const arg of namedArgs(call)) {
          if (arg.type !== g.keywordArg.node) continue;
          const key = arg.childForFieldName(g.keywordArg.nameField);
          if (key && key.text === name) return arg.childForFieldName(g.keywordArg.valueField);
        }
      }
      // Options-bag form: `fetch(url, { method: 'POST' })` — any object-literal
      // argument, searched depth-first (an option can sit under a spread/nesting).
      if (g.optionsObject) {
        const oo = g.optionsObject;
        for (const arg of namedArgs(call)) {
          if (arg.type !== oo.node) continue;
          let found: Node | null = null;
          walk(arg, (n) => {
            if (found) return false;
            if (n.type === oo.pairNode) {
              const key = n.childForFieldName(oo.keyField);
              if (key && bareKey(key.text) === name) {
                found = n.childForFieldName(oo.valueField);
              }
            }
            return undefined;
          });
          if (found) return found;
        }
      }
      return null;
    },

    listStrings(node: Node): string[] {
      if (g.listNode === undefined || node.type !== g.listNode) return [];
      const out: string[] = [];
      for (const c of node.namedChildren) {
        if (!c) continue;
        const text = stringText(c);
        if (text !== null) out.push(text);
      }
      return out;
    },

    functionNodes: g.functionNodes,

    calleeCall(call: Node): Node | null {
      const callee = call.childForFieldName('function');
      return callee && callTypes.has(callee.type) ? callee : null;
    },

    receiverNode(call: Node): Node | null {
      const callee = call.childForFieldName('function');
      if (!callee || callee.type !== g.memberNode) return null;
      return callee.childForFieldName(g.memberObjectField);
    },
  };
}

/** Trailing identifier segment of a dotted reference (`RequestMethod.GET` →
 *  `GET`) — the G3 enum-ref contribution `listStrings` documents. */
function dottedTail(text: string): string {
  const parts = text.split('.');
  return parts[parts.length - 1].trim();
}

/** Inputs to the fused-callee factory — grammars whose CALL node carries the
 *  receiver/name fields directly (Java's `method_invocation` has
 *  `object`/`name`/`arguments` on the call itself; there is no `function`
 *  field). Annotations are the same fusion one level up: the annotation IS
 *  the invocation, so `decoratorCall` returns the annotation node and
 *  `resolveCall` accepts it alongside real calls. */
interface FusedCalleeGrammar {
  readonly callNode: string;
  readonly nameField: string;
  readonly objectField: string;
  readonly argumentsField: string;
  readonly stringNodes: readonly string[];
  readonly decoratorNodes: readonly string[];
  /** Keyword-argument analog inside annotation argument lists
   *  (`element_value_pair {key, value}`); Ruby's hash `pair` is the same
   *  shape (`key: hash_key_symbol, value`). */
  readonly annotationPair: { node: string; keyField: string; valueField: string };
  /** List-literal analog (`element_value_array_initializer`, Ruby `array`). */
  readonly listNode: string;
  readonly functionNodes: readonly string[];
  /** Node types of enum/member references inside a list whose trailing
   *  segment is contributed by `listStrings` (Java `field_access`). */
  readonly listRefNodes?: readonly string[];
  /** Grammar field holding a trailing block/lambda on the call node (Ruby
   *  `block`: `do … end` / `{ … }`) — enables `hasTrailingLambda`. */
  readonly trailingBlockField?: string;
  /** Symbol-literal node types admitted by `stringText` with their leading
   *  `:` stripped (Ruby `simple_symbol` — `namespace :api` group prefixes,
   *  `via: [:get]` verb lists, `resources :articles` names). */
  readonly symbolNodes?: readonly string[];
  /** When a call has NO positional argument and its first pair's KEY is a
   *  string, `firstArg` returns the key node — Ruby's hash-rocket route
   *  idiom `get '/health' => 'status#health'` puts the path in the key. */
  readonly pathFromFirstPairKey?: boolean;
}

function fusedCalleeShape(g: FusedCalleeGrammar): GrammarShape {
  const stringTypes = new Set(g.stringNodes);
  const decoratorTypes = new Set(g.decoratorNodes);
  const symbolTypes = new Set(g.symbolNodes ?? []);

  const stringText = (node: Node): string | null => {
    if (stringTypes.has(node.type)) return node.text;
    // A symbol reads as its bare name (`:api` → `api`) — unquoted, so
    // downstream quote-stripping is a no-op and normalization adds the `/`.
    if (symbolTypes.has(node.type)) return node.text.replace(/^:/, '');
    return null;
  };

  /** The argument-list node of a call OR annotation, else null. */
  const argList = (node: Node): Node | null => {
    if (node.type === g.callNode) return node.childForFieldName(g.argumentsField);
    if (decoratorTypes.has(node.type)) return node.childForFieldName(g.argumentsField);
    return null;
  };

  const args = (node: Node): Node[] => {
    const list = argList(node);
    if (!list) return [];
    const out: Node[] = [];
    for (const c of list.namedChildren) if (c) out.push(c);
    return out;
  };

  return {
    callNodes: [g.callNode],

    resolveCall(call: Node): ResolvedCall | null {
      if (call.type === g.callNode) {
        const name = call.childForFieldName(g.nameField);
        if (!name) return null;
        const obj = call.childForFieldName(g.objectField);
        return obj
          ? { kind: 'member', name: name.text, receiver: obj.text }
          : { kind: 'bare', name: name.text, receiver: '' };
      }
      // An annotation IS the invocation in a fused grammar: `@GetMapping("/x")`
      // has no inner call node, so the decorator round-trips through here.
      // The name may be scoped (`@retrofit2.http.GET`) — the tail is the name.
      if (decoratorTypes.has(call.type)) {
        const name = call.childForFieldName(g.nameField);
        if (!name) return null;
        return { kind: 'bare', name: dottedTail(name.text), receiver: '' };
      }
      return null;
    },

    firstArg(node: Node): Node | null {
      for (const a of args(node)) {
        if (a.type === g.annotationPair.node) continue;
        return a;
      }
      // Hash-rocket idiom: no positional argument, the first pair's STRING
      // key is the path (`get '/health' => 'status#health'`).
      if (g.pathFromFirstPairKey) {
        const first = args(node)[0];
        if (first && first.type === g.annotationPair.node) {
          const key = first.childForFieldName(g.annotationPair.keyField);
          if (key && stringTypes.has(key.type)) return key;
        }
      }
      return null;
    },

    positionalArgs(node: Node): Node[] {
      return args(node).filter((a) => a.type !== g.annotationPair.node);
    },

    stringText,

    decoratorNodes: g.decoratorNodes,

    decoratorCall(decorator: Node): Node | null {
      // Fused: the annotation node itself is the invocation (marker forms
      // included — a marker is a call with no arguments).
      return decorator;
    },

    optionValue(node: Node, name: string): Node | null {
      for (const a of args(node)) {
        if (a.type !== g.annotationPair.node) continue;
        const key = a.childForFieldName(g.annotationPair.keyField);
        if (key && key.text === name) return a.childForFieldName(g.annotationPair.valueField);
      }
      return null;
    },

    listStrings(node: Node): string[] {
      if (node.type !== g.listNode) return [];
      const refTypes = new Set(g.listRefNodes ?? []);
      const out: string[] = [];
      for (const c of node.namedChildren) {
        if (!c) continue;
        const text = stringText(c);
        if (text !== null) out.push(text);
        // Dotted enum refs (`RequestMethod.GET`) contribute their tail — the
        // consumer validates every token, so non-verbs drop out.
        else if (refTypes.has(c.type)) out.push(dottedTail(c.text));
      }
      return out;
    },

    functionNodes: g.functionNodes,

    calleeCall(): Node | null {
      // A fused call node cannot have a call as its callee — chains link
      // through the receiver (`object`) field instead.
      return null;
    },

    receiverNode(call: Node): Node | null {
      if (call.type !== g.callNode) return null;
      return call.childForFieldName(g.objectField);
    },

    ...(g.trailingBlockField !== undefined
      ? {
          hasTrailingLambda(call: Node): boolean {
            return (
              call.type === g.callNode && call.childForFieldName(g.trailingBlockField!) !== null
            );
          },
        }
      : {}),
  };
}

// ─── Shape rows ──────────────────────────────────────────────────────────────
// One row per DISTINCT grammar family. Rows are added with their language
// wave, each verified against the bundled wasm artifact (an unverified row is
// worse than a missing one — the contract test would pass while extraction
// silently misreads the tree).

/** TS / TSX / JS share one shape — the JS-family grammars use identical node
 *  and field names for every construct the extractor reads. */
const JS_FAMILY: GrammarShape = calleeFieldShape({
  callNodes: ['call_expression'],
  identifierNodes: ['identifier'],
  memberNode: 'member_expression',
  memberObjectField: 'object',
  memberPropertyField: 'property',
  stringNodes: ['string', 'template_string'],
  decoratorNodes: ['decorator'],
  functionNodes: ['method_definition', 'function_declaration'],
  optionsObject: { node: 'object', pairNode: 'pair', keyField: 'key', valueField: 'value' },
  listNode: 'array',
});

const PYTHON: GrammarShape = calleeFieldShape({
  callNodes: ['call'],
  identifierNodes: ['identifier'],
  memberNode: 'attribute',
  memberObjectField: 'object',
  memberPropertyField: 'attribute',
  stringNodes: ['string'],
  stringPrefixes: true, // f"/x/{id}", r'...', rb'...'
  decoratorNodes: ['decorator'],
  functionNodes: ['function_definition'],
  keywordArg: { node: 'keyword_argument', nameField: 'name', valueField: 'value' },
  listNode: 'list',
});

const GO: GrammarShape = calleeFieldShape({
  callNodes: ['call_expression'],
  identifierNodes: ['identifier'],
  memberNode: 'selector_expression',
  memberObjectField: 'operand',
  memberPropertyField: 'field',
  stringNodes: ['interpreted_string_literal', 'raw_string_literal'],
  functionNodes: ['function_declaration', 'method_declaration'],
});

/** Java (verified vs the bundled tree-sitter-java wasm, ABI 14): the fused
 *  grammar the factory above exists for — `method_invocation` carries
 *  `object`/`name`/`arguments` on the call node, annotations come in a
 *  with-arguments and a marker form, and annotation keyword arguments are
 *  `element_value_pair` nodes. Enum refs in annotation arrays
 *  (`{RequestMethod.GET}`) are `field_access` nodes. */
const JAVA: GrammarShape = fusedCalleeShape({
  callNode: 'method_invocation',
  nameField: 'name',
  objectField: 'object',
  argumentsField: 'arguments',
  stringNodes: ['string_literal'],
  decoratorNodes: ['annotation', 'marker_annotation'],
  annotationPair: { node: 'element_value_pair', keyField: 'key', valueField: 'value' },
  listNode: 'element_value_array_initializer',
  functionNodes: ['method_declaration'],
  listRefNodes: ['field_access'],
});

/** Ruby (verified vs the bundled tree-sitter-ruby wasm, ABI 14): a natural
 *  fused-callee grammar — `call` carries `receiver`/`method`/`arguments`/
 *  `block` fields directly, hash keyword arguments are `pair` nodes
 *  (`key: hash_key_symbol, value`), and Ruby has no decorator syntax. The
 *  three Ruby-specific factory knobs: symbols read as bare names
 *  (`namespace :api`), the `block` field answers `hasTrailingLambda`
 *  (Sinatra `get '/x' do`), and the hash-rocket route idiom surfaces the
 *  pair KEY as the first argument (`get '/health' => 'status#health'`). */
const RUBY: GrammarShape = fusedCalleeShape({
  callNode: 'call',
  nameField: 'method',
  objectField: 'receiver',
  argumentsField: 'arguments',
  stringNodes: ['string'],
  decoratorNodes: [],
  annotationPair: { node: 'pair', keyField: 'key', valueField: 'value' },
  listNode: 'array',
  functionNodes: ['method', 'singleton_method'],
  trailingBlockField: 'block',
  symbolNodes: ['simple_symbol'],
  pathFromFirstPairKey: true,
});

const GRAMMAR_SHAPES: Readonly<Record<string, GrammarShape>> = {
  typescript: JS_FAMILY,
  tsx: JS_FAMILY,
  javascript: JS_FAMILY,
  python: PYTHON,
  go: GO,
  java: JAVA,
  kotlin: KOTLIN,
  c_sharp: CSHARP,
  ruby: RUBY,
  rust: RUST,
};

/** The shape for a logical grammar name, or null when no row exists yet —
 *  callers treat null as "this grammar's files cannot contribute flow" and
 *  skip, never throw. */
export function grammarShape(grammar: string): GrammarShape | null {
  return GRAMMAR_SHAPES[grammar] ?? null;
}

/** Grammar names with a shape row (for the pack-contract completeness test). */
export function shapedGrammars(): string[] {
  return Object.keys(GRAMMAR_SHAPES);
}
