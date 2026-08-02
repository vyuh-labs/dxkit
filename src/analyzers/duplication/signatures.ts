/**
 * Per-function callee signatures, extracted from dxkit's OWN tree-sitter AST
 * (never graphify). This is the source of the structural-duplicate (seam)
 * signal's callee sets. graphify's call graph is intra-repo — it drops
 * external/framework calls (`auth`, `NextResponse.json`, `Promise.all`), so a
 * framework handler presents a callee set of ~3 and unrelated handlers
 * coincidentally score 1.00. Reading the FULL call set from the AST (framework
 * calls included) restores discrimination: unrelated handlers that share only
 * the framework skeleton fall below the similarity floor, real copies stay high.
 *
 * Pack-driven (Rule 6): function-definition node types (`functionNodes`) and
 * callee resolution (`resolveCall`) come from the frozen `GrammarShape`, so
 * every language pack is covered by construction — no per-language branch here.
 * Fail-open per file: a parse failure or an unshaped grammar drops that file's
 * signatures, never throws.
 */
import * as path from 'path';
import { withParsedFile, type Node } from '../../ast/parse';
import { grammarShape } from '../../ast/grammar-shape';
import { walkSourceFiles } from '../tools/walk-source-files';

/** One named function/method and the complete set of symbols it calls. */
export interface FunctionSignature {
  /** Repo-relative POSIX path of the defining file. */
  readonly file: string;
  /** The function/method's declared name (the duplicate anchor symbol). */
  readonly name: string;
  /** 1-based line of the definition. */
  readonly line: number;
  /** 1-based last line of the definition — the function's SPAN together with
   *  `line`. Lets the two-ref gate mark per-FUNCTION "did the diff touch this
   *  anchor" (via the canonical changed-line index) instead of per-file, so an
   *  untouched sibling in a modified file is never labeled added. */
  readonly endLine: number;
  /** AST leaf (token) count attributed to this function — the size proxy for
   *  the `minBodyTokens` seam floor. A 3-line delegating wrapper counts a few
   *  dozen; a substantive function counts hundreds. */
  readonly tokens: number;
  /** Every distinct callee name in the function body — bare call names and
   *  member method names alike (`getDivisions`, `json`, `all`), attributed to
   *  the NEAREST enclosing named function so a nested declaration's calls do not
   *  pollute the outer set. */
  readonly callees: ReadonlySet<string>;
}

export interface SignatureOpts {
  /** Exclude test/spec files (default true — test scaffolding is legitimately
   *  repetitive; Rule 6 test-file patterns via the source walker). */
  readonly excludeTests?: boolean;
}

/** Mutable accumulator; the callee set fills in as the walk descends. */
interface Building {
  file: string;
  name: string;
  line: number;
  endLine: number;
  tokens: number;
  callees: Set<string>;
}

/**
 * Recursive descent that attributes each call to its nearest enclosing NAMED
 * function. A `functionNodes` node with a resolvable name opens a new boundary;
 * an unnamed one (an anonymous callback) does not — its calls roll up to the
 * enclosing named function, exactly as the reimplementation unit intends.
 */
function collect(
  node: Node,
  shape: NonNullable<ReturnType<typeof grammarShape>>,
  file: string,
  current: Building | null,
  acc: Building[],
): void {
  let cur = current;
  if (shape.functionNodes.includes(node.type)) {
    const name = node.childForFieldName('name')?.text ?? shape.functionName?.(node) ?? null;
    if (name) {
      cur = {
        file,
        name,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        tokens: 0,
        callees: new Set(),
      };
      acc.push(cur);
    }
  }
  if (cur && shape.callNodes.includes(node.type)) {
    const resolved = shape.resolveCall(node);
    if (resolved?.name) cur.callees.add(resolved.name);
  }
  // A leaf is one AST token; attributed (like callees) to the nearest
  // enclosing named function — the `minBodyTokens` size signal.
  if (cur && node.childCount === 0) cur.tokens++;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collect(child, shape, file, cur, acc);
  }
}

/**
 * Extract the callee signature of every named function/method under `root`.
 * `root` must be an absolute path (a repo root or a ref worktree). Fail-open.
 */
export async function gatherFunctionSignatures(
  root: string,
  opts: SignatureOpts = {},
): Promise<FunctionSignature[]> {
  const excludeTests = opts.excludeTests ?? true;
  const files = walkSourceFiles(root, { includeTests: !excludeTests });
  const out: FunctionSignature[] = [];
  for (const rel of files) {
    const sigs = await withParsedFile(path.join(root, rel), (parsed) => {
      const shape = grammarShape(parsed.grammar);
      if (!shape) return [] as Building[];
      const acc: Building[] = [];
      collect(parsed.tree.rootNode, shape, rel, null, acc);
      return acc;
    });
    if (sigs) out.push(...sigs);
  }
  return out;
}
