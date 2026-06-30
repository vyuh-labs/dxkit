/**
 * Canonical AST access — dxkit's in-process, graphify-independent parser.
 *
 * This is the ONE module that touches a tree-sitter engine. Every AST-based
 * feature (flow extraction today; a future graph builder that could replace
 * graphify; any later AST analysis) parses through here, so the engine stays
 * swappable in a single file — the same adapter discipline graphify sits
 * behind, but for raw parsing.
 *
 * Why its own layer (vs graphify): graphify is a high-level *graph builder*
 * (functions/calls/communities) that does not expose raw call/decorator/
 * string-literal nodes, and it runs as an optional Python subprocess. This
 * layer is the low-level *parser*: source → concrete syntax tree, in-process
 * (web-tree-sitter wasm), no Python, no graphify. It is also the foundation a
 * future in-house graph builder would consume to migrate the code graph off
 * graphify.
 *
 * Design:
 *   - **Lazy + graceful.** The wasm engine loads on first use (keeps startup
 *     fast) and every entry point returns `null` rather than throwing when the
 *     engine or a grammar is unavailable — AST features degrade, they don't
 *     crash (mirrors graphify's "unavailable" contract).
 *   - **Pack-driven grammars (Rule 6).** A file's grammar is resolved from the
 *     owning pack's `treeSitterGrammars[ext]`; this module never hardcodes a
 *     per-language mapping. Logical grammar names map to wasm artifacts here,
 *     so the artifact source (currently `tree-sitter-wasms`, pinned) is
 *     swappable / vendorable without touching packs.
 *   - **Cached.** Parser.init runs once; each grammar's `Language` and a bound
 *     `Parser` are cached for the process.
 */

import { readFileSync } from 'fs';
import { dirname, extname, join } from 'path';
import type { Language, Node, Parser, Tree } from 'web-tree-sitter';
import { LANGUAGES } from '../languages';
import type { LanguageId } from '../languages/types';

// Re-export the node/tree types so consumers depend on this module, not on
// web-tree-sitter directly (keeps the engine swap contained here).
export type { Node, Tree } from 'web-tree-sitter';

/** A successfully parsed file. */
export interface ParsedFile {
  readonly tree: Tree;
  readonly source: string;
  readonly grammar: string;
  readonly languageId: LanguageId;
}

// ── Engine + grammar caches (process-lifetime) ──────────────────────────────

interface Engine {
  ParserCtor: typeof Parser;
  LanguageCtor: typeof Language;
}

let enginePromise: Promise<Engine | null> | null = null;
const languageCache = new Map<string, Language | null>();
const parserCache = new Map<string, Parser>();
let warnedUnavailable = false;

/**
 * Resolve a dependency's installed directory via its package.json (works
 * around packages whose `main`/`exports` block direct resolution — e.g.
 * `tree-sitter-wasms`' broken `main`, and `web-tree-sitter`' exports-gated
 * package.json: resolve the runtime entry for that one).
 */
function runtimeWasmPath(): string {
  return join(dirname(require.resolve('web-tree-sitter')), 'tree-sitter.wasm');
}
function grammarWasmPath(grammar: string): string {
  const wasmsDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
  return join(wasmsDir, 'out', `tree-sitter-${grammar}.wasm`);
}

/** Lazily load + init the wasm engine. Returns null (once-warned) on failure. */
async function getEngine(): Promise<Engine | null> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    try {
      // Dynamic import keeps the engine out of the startup path; web-tree-sitter
      // is require-compatible so this resolves cleanly under CommonJS output.
      const mod = await import('web-tree-sitter');
      const runtime = runtimeWasmPath();
      await mod.Parser.init({ locateFile: () => runtime });
      return { ParserCtor: mod.Parser, LanguageCtor: mod.Language };
    } catch (err) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[dxkit] AST engine unavailable, skipping AST features: ${reason}\n`);
      }
      return null;
    }
  })();
  return enginePromise;
}

async function getLanguage(engine: Engine, grammar: string): Promise<Language | null> {
  if (languageCache.has(grammar)) return languageCache.get(grammar) ?? null;
  let lang: Language | null = null;
  try {
    lang = await engine.LanguageCtor.load(grammarWasmPath(grammar));
  } catch {
    lang = null; // grammar artifact missing/unreadable → that language degrades
  }
  languageCache.set(grammar, lang);
  return lang;
}

async function getParser(engine: Engine, grammar: string): Promise<Parser | null> {
  const cached = parserCache.get(grammar);
  if (cached) return cached;
  const lang = await getLanguage(engine, grammar);
  if (!lang) return null;
  const parser = new engine.ParserCtor();
  parser.setLanguage(lang);
  parserCache.set(grammar, parser);
  return parser;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Whether the AST engine can be loaded in this environment (for doctor checks). */
export async function astEngineAvailable(): Promise<boolean> {
  return (await getEngine()) !== null;
}

/**
 * Parse source text with a named grammar. Returns the tree, or `null` if the
 * engine or grammar is unavailable (never throws).
 */
export async function parseSource(source: string, grammar: string): Promise<Tree | null> {
  const engine = await getEngine();
  if (!engine) return null;
  const parser = await getParser(engine, grammar);
  if (!parser) return null;
  try {
    return parser.parse(source);
  } catch {
    return null;
  }
}

/**
 * The grammar + owning language for a file extension (with leading dot),
 * resolved from the active pack registry — or `null` if no pack parses it.
 */
export function grammarForExtension(
  ext: string,
): { grammar: string; languageId: LanguageId } | null {
  const lower = ext.toLowerCase();
  for (const pack of LANGUAGES) {
    const grammar = pack.treeSitterGrammars?.[lower];
    if (grammar) return { grammar, languageId: pack.id };
  }
  return null;
}

/**
 * Read + parse a file, resolving its grammar from the extension via the pack
 * registry. Returns `null` if the extension maps to no grammar, the file is
 * unreadable, or the engine is unavailable.
 */
export async function parseFile(filePath: string): Promise<ParsedFile | null> {
  const resolved = grammarForExtension(extname(filePath));
  if (!resolved) return null;
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const tree = await parseSource(source, resolved.grammar);
  if (!tree) return null;
  return { tree, source, grammar: resolved.grammar, languageId: resolved.languageId };
}

/**
 * Depth-first walk of a node and its descendants. The visitor runs on each
 * node; return `false` to skip a node's children. Consumers use this rather
 * than walking `node.children` directly so a future engine swap stays
 * contained in this module.
 */
export function walk(node: Node, visit: (node: Node) => void | boolean): void {
  const proceed = visit(node);
  if (proceed === false) return;
  for (const child of node.children) {
    if (child) walk(child, visit);
  }
}

/** Test seam: drop cached engine/grammars/parsers so a test can re-init. */
export function resetAstCachesForTest(): void {
  enginePromise = null;
  languageCache.clear();
  parserCache.clear();
  warnedUnavailable = false;
}
