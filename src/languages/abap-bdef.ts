/**
 * The ABAP pack's `.bdef` STRUCTURAL floor (#309, 4.4.1 WP8.5).
 *
 * abaplint (the pack's syntax floor) has no BDL parser, so a truncated or
 * prose-contaminated behavior definition passed the floor silently —
 * reported live by an embedder gating LLM-generated RAP trees, with the
 * failure classes ranked from what they actually catch downstream:
 *
 *   1. truncation mid-block (the dominant class): unbalanced `{ }`, or a
 *      last statement with no terminator — including the sharp shape that
 *      LOOKS complete (`define behavior` + braces present, block never
 *      closes);
 *   2. prose/markup leakage: markdown fences, `**bold**`, narration
 *      sentences bleeding into the artifact;
 *   3. header-shape absence: no `managed|unmanaged|abstract …
 *      implementation in class` header, or no `define behavior for` at
 *      all;
 *   4. empty / whitespace-only files.
 *
 * Reported under the check's OWN label (`bdef.structure`, rendered as
 * `floor.abap:bdef.structure`) — distinct from `abaplint-syntax`, so a
 * verdict reader can tell "structurally plausible" from "parsed". When
 * upstream abaplint grows BDL parsing, this check retires in its favor.
 * Cross-artifact consistency (does the entity match a CDS view; do
 * granted operations match consumers) is explicitly OUT of scope —
 * contract-level verification a structural floor must not half-claim.
 *
 * DISCOVERY covers BOTH serialization conventions — plain `<name>.bdef`
 * (honestly-named un-parsed trees) AND abapGit `<name>.bdef.asbdef` —
 * because matching only one silently blinds the floor to the other (the
 * WP6 abapGit-naming class, mirrored). Bias: false NEGATIVES only — a
 * legal artifact must never be refused, so every rule is shallow and a
 * doubtful line is accepted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { walkPaths } from '../analyzers/tools/walk-paths';
import type {
  CorrectnessContext,
  StructuralFinding,
  StructureCheckResult,
} from './capabilities/correctness';

export const BDEF_STRUCTURE_LABEL = 'bdef.structure';

/** Both serialization conventions (see module doc). `.asbdef` files are
 *  found by extension; plain `.bdef` files by their own extension. */
function discoverBdefFiles(cwd: string): string[] {
  return walkPaths(cwd, { extensions: ['.bdef', '.asbdef'] }).filter(
    (rel) => rel.endsWith('.bdef') || rel.endsWith('.bdef.asbdef'),
  );
}

/** Strip line comments (`//`) and block comments; BDL string literals do
 *  not span the shapes we check, so a plain scan suffices. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/** The first structural problem in one `.bdef` source, or null (plausible). */
export function bdefStructuralProblem(source: string): string | null {
  // Class 4: empty / whitespace-only.
  if (source.trim() === '') return 'empty or whitespace-only behavior definition';

  const stripped = stripComments(source);

  // Class 2: prose/markup leakage — line-anchored, on NON-comment lines.
  // Markdown shapes (fences / headings / bold) plus sentence-shaped lines
  // (ending '.' or ':') — BDL statements end with ';', '{', '}', or continue
  // bare; no legal line ends with '.' or ':'.
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^(```|#|\*\*)/.test(line)) {
      return `markup leaked into the artifact (line starts with "${line.slice(0, 3)}")`;
    }
    if (/[.:]$/.test(line) && /\s/.test(line)) {
      return `prose leaked into the artifact ("${line.slice(0, 60)}${line.length > 60 ? '…' : ''}")`;
    }
  }

  // Class 3: header shape — the implementation header (managed / unmanaged /
  // abstract variants) and at least one `define behavior for`.
  if (!/^\s*(managed|unmanaged|abstract)\b/m.test(stripped)) {
    return 'no managed/unmanaged/abstract implementation header';
  }
  if (!/\bdefine\s+behavior\s+for\s+\S+/.test(stripped)) {
    return 'no `define behavior for <entity>` statement';
  }

  // Class 1: truncation — unbalanced braces, or a final statement with no
  // terminator (the sharp shape: block opened, never closed, last statement
  // bare — looks complete to a "has define behavior + braces" check).
  let braceBalance = 0;
  for (const ch of stripped) {
    if (ch === '{') braceBalance++;
    else if (ch === '}') {
      braceBalance--;
      if (braceBalance < 0) return 'unbalanced braces (a `}` closes nothing)';
    }
  }
  if (braceBalance > 0) return 'unbalanced braces (a `{` block never closes — truncated?)';
  const lastMeaningful = stripped.trim().slice(-1);
  if (lastMeaningful !== ';' && lastMeaningful !== '}') {
    return `last statement has no terminator (ends "${stripped.trim().slice(-20)}") — truncated?`;
  }

  return null;
}

/** The pack's `structureCheck` implementation. Pure + read-only; `none`
 *  when the tree carries no behavior definitions at all. */
export function abapBdefStructureCheck(ctx: CorrectnessContext): StructureCheckResult {
  const files = discoverBdefFiles(ctx.cwd);
  if (files.length === 0) return { kind: 'none' };
  const findings: StructuralFinding[] = [];
  for (const rel of files) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(ctx.cwd, rel), 'utf8');
    } catch {
      // An unreadable artifact is not evidence of broken content — skip it
      // (false-negative bias), the file-level walk already proved it exists.
      continue;
    }
    const problem = bdefStructuralProblem(source);
    if (problem !== null) findings.push({ file: rel, problem });
  }
  return findings.length === 0
    ? { kind: 'clean', label: BDEF_STRUCTURE_LABEL, checkedFiles: files.length }
    : { kind: 'broken', label: BDEF_STRUCTURE_LABEL, findings };
}
