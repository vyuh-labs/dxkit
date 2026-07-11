/**
 * AST access — the frozen slice of dxkit's tree-sitter layer.
 *
 * The parse engine itself (grammar wasm loading, caches, extension →
 * grammar dispatch) lives in the dxkit monorepo (`src/ast/parse.ts`) and is
 * free to change; what freezes here is the SHAPE a consumer receives
 * (`ParsedFile`, the `Node`/`Tree` types grammar shapes are written
 * against), the `walk` traversal helper, and the signatures the plugin host
 * will bind parsing through when the in-process runtime lands.
 */

import type { Node, Tree } from 'web-tree-sitter';

// Re-export the node/tree types so consumers depend on this module, not on
// web-tree-sitter directly (keeps the engine swap contained).
export type { Node, Tree } from 'web-tree-sitter';

/**
 * A successfully parsed file. `languageId` is the id of the language pack
 * whose grammar parsed the file; dxkit internally narrows it to its own
 * pack-id union via the type parameter, while extensions see `string`
 * (the pack set grows — the union is not part of the frozen surface).
 */
export interface ParsedFile<LanguageIdT extends string = string> {
  readonly tree: Tree;
  readonly source: string;
  readonly grammar: string;
  readonly languageId: LanguageIdT;
}

/**
 * Depth-first walk of a node and its descendants. The visitor runs on each
 * node; return `false` to skip a node's children. Consumers use this rather
 * than walking `node.children` directly so a future engine swap stays
 * contained behind the frozen surface.
 */
export function walk(node: Node, visit: (node: Node) => void | boolean): void {
  const proceed = visit(node);
  if (proceed === false) return;
  for (const child of node.children) {
    if (child) walk(child, visit);
  }
}

/**
 * Frozen signature of the host-provided file parser: resolve the file's
 * grammar from its extension via the active packs, parse, and return null
 * (never throw) when no grammar matches or the engine is unavailable —
 * consumers stay fail-open. dxkit's implementation lives in
 * `src/ast/parse.ts`; the plugin runtime hands rung-4 extensions a function
 * of exactly this shape.
 */
export type ParseFileFn = (filePath: string) => Promise<ParsedFile | null>;

/**
 * Frozen signature of the host-provided source parser (parse a string with
 * a named grammar). Null on unknown grammar / unavailable engine — fail-open,
 * as with {@link ParseFileFn}.
 */
export type ParseSourceFn = (source: string, grammar: string) => Promise<Tree | null>;
