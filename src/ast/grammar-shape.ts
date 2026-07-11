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

const GRAMMAR_SHAPES: Readonly<Record<string, GrammarShape>> = {
  typescript: JS_FAMILY,
  tsx: JS_FAMILY,
  javascript: JS_FAMILY,
  python: PYTHON,
  go: GO,
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
