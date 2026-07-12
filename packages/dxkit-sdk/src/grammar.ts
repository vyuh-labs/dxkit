/**
 * Grammar-shape ACCESS types — how one tree-sitter grammar's syntax is read.
 *
 * Different grammars name the same constructs differently (TypeScript's
 * `call_expression`/`member_expression` vs Python's `call`/`attribute` vs
 * Go's `call_expression`/`selector_expression`). A GrammarShape /
 * GrammarModelShape row encapsulates those facts so ONE extractor walks any
 * grammar. The per-grammar rows and factories live in the dxkit monorepo
 * (`src/ast/grammar-shape.ts` / `grammar-model-shape.ts`); these interfaces
 * are the frozen contract they satisfy, and the shapes rung-4 plugins will
 * receive access through.
 *
 * Every function is total over arbitrary nodes (returns null / empty rather
 * than throwing) so consumers stay fail-open.
 */

import type { Node } from 'web-tree-sitter';

/** A call site decomposed into its callee form. */
export interface ResolvedCall {
  /** `bare` — `fetch(...)`, `path(...)`; `member` — `requests.get(...)`. */
  readonly kind: 'bare' | 'member';
  /** Bare callee name, or the member property/method name (`get`). */
  readonly name: string;
  /** Member receiver text (`requests`, `this.http`); `''` for bare calls. */
  readonly receiver: string;
}

/**
 * How to read one grammar's tree. Every function is total over arbitrary nodes
 * (returns null / empty rather than throwing) so the extractor stays fail-open.
 */
export interface GrammarShape {
  /** Node types that are invocations in this grammar. */
  readonly callNodes: readonly string[];
  /** Decompose a call node's callee; null when it is neither bare nor member. */
  resolveCall(call: Node): ResolvedCall | null;
  /** First positional (non-keyword) argument node of a call, else null. */
  firstArg(call: Node): Node | null;
  /** All positional (non-keyword) argument nodes of a call, in order. */
  positionalArgs(call: Node): Node[];
  /**
   * A string literal's text — verbatim including quotes/backticks, with any
   * language-level prefix (Python `f"..."` / `r"..."`) stripped so downstream
   * normalization sees the quote first. Null for a non-string node.
   */
  stringText(node: Node): string | null;
  /** Node types of decorator/annotation attachments (`[]` = grammar has none). */
  readonly decoratorNodes: readonly string[];
  /** The invocation inside a decorator (`@app.get('/x')` → the call), else null. */
  decoratorCall(decorator: Node): Node | null;
  /**
   * Value node of a named option on a call — a keyword argument (Python
   * `methods=[...]`) or an entry of a trailing object-literal argument (JS
   * `fetch(url, { method: 'POST' })`). Null when absent.
   */
  optionValue(call: Node, name: string): Node | null;
  /**
   * Texts of the string elements of a list/array node — verbatim, quoted.
   * A grammar whose lists can carry dotted ENUM references in place of
   * strings (Java's `{RequestMethod.GET, RequestMethod.POST}`) may also
   * contribute each reference's trailing identifier segment (unquoted) —
   * the consumer normalizes and validates every token, so a non-verb tail
   * simply drops out.
   */
  listStrings(node: Node): string[];
  /** Function/method definition node types (decorated-handler-name fallback). */
  readonly functionNodes: readonly string[];
  /**
   * The callee node of a call whose callee is ITSELF a call — the outer node
   * of a trailing-lambda pair (Kotlin `get("/x") { … }` → the inner
   * `get("/x")` call) or a curried `f(x)(y)`. Null when the callee is a
   * plain identifier/member. Optional (additive, SDK minor): grammars whose
   * shapes predate it simply don't participate in ancestor group-prefix
   * walks.
   */
  calleeCall?(call: Node): Node | null;
  /**
   * The receiver EXPRESSION NODE of a member call (`webClient.get()` →
   * the `webClient` node; `a.b().c()` → the `a.b()` call node), for
   * builder-chain traversal. Null for bare calls. Optional (additive,
   * SDK minor).
   */
  receiverNode?(call: Node): Node | null;
  /**
   * Does this call carry a trailing lambda/block argument (Kotlin
   * `get("/x") { … }`)? The `routeVerbCallees.requireTrailingLambda`
   * precision guard reads it. Optional (additive, SDK minor).
   */
  hasTrailingLambda?(call: Node): boolean;
  /**
   * The declared NAME of a function/method definition node (one of
   * `functionNodes`) — for grammars whose wasm defines no `name` field
   * (kotlin), where `childForFieldName('name')` cannot answer. The
   * decorated-handler-name fallback consults it. Optional (additive,
   * SDK minor).
   */
  functionName?(node: Node): string | null;
  /**
   * The name of the TYPE DECLARATION enclosing a node (the nearest ancestor
   * class/record), or null when the node is not inside one. Consumed by the
   * `routeTemplateTokens` descriptor (ASP.NET's `[controller]`
   * token substitutes the enclosing class name). Optional (additive,
   * SDK minor).
   */
  enclosingTypeName?(node: Node): string | null;
}

/** How to read one grammar's model-declaration syntax. */
export interface GrammarModelShape {
  /** Node types that can declare a named, field-bearing type. */
  readonly classNodes: readonly string[];
  /** The declared name, or null when this node is not a model-bearing
   *  declaration in this grammar (a Go `type_spec` aliasing a non-struct). */
  className(node: Node): string | null;
  /** Heritage expressions as verbatim identifier-path texts (`models.Model`,
   *  `BaseEntity`). Empty when the grammar/node has none. */
  heritage(node: Node): string[];
  /** Decorator nodes attached to this class — encapsulates per-grammar
   *  attachment quirks (TS hoists decorators of an exported class onto the
   *  `export_statement`; Python wraps in `decorated_definition`). */
  classDecorators(node: Node): Node[];
  /** Field/property declarations in the class body, in source order. */
  fieldNodes(classNode: Node): Node[];
  /** Declared names of one field node — plural because Go allows
   *  `X, Y int` in a single declaration. Empty for unnamed (embedded) fields. */
  fieldNames(field: Node): string[];
  /** Verbatim text of the field's declared type, or null when absent. */
  fieldTypeText(field: Node): string | null;
  /**
   * Grammar-level optionality marker ONLY: the TS `?` token, a Go pointer
   * type. Lexical forms (`| null`, `Optional[...]`, `| None`) fold in the
   * shared normalizer, and framework forms (`nullable=True`) come from the
   * pack descriptor. Null when this grammar has no such marker.
   */
  fieldOptionalMarker(field: Node): boolean | null;
  /** The field's struct tag text (Go), verbatim including backticks. */
  fieldTag(field: Node): string | null;
  /** The call node initializing this field (`Column(...)`,
   *  `models.CharField(...)`), for descriptor `fieldCallees` resolution. */
  fieldValueCall(field: Node): Node | null;
  /** Decorator nodes attached to this field (`@Column(...)`). */
  fieldDecorators(field: Node): Node[];
  /**
   * Is this class declaration marked PARTIAL (C#'s `partial class` modifier —
   * one logical type split across several declarations, typically for
   * codegen)? The model-set assembly merges same-name entities into one when
   * EVERY declaration is partial-marked, so a field moving between partials
   * never reads as remove+add. Optional (additive, SDK minor); grammars
   * without the concept omit it.
   */
  partialMarker?(classNode: Node): boolean;
}
