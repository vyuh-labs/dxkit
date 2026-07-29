/**
 * The ONE reader/parser for `.dxkit/policy.json` text (CLAUDE.md Rule 2,
 * applied to policy the way Rule 12 applies `loadGraph` to the code graph).
 *
 * The policy file is JSONC: strict JSON remains valid, and line + block
 * comments plus trailing commas are first-class — the generated scaffold
 * teaches through comments, so every dxkit read point MUST accept them and
 * every write point MUST preserve them. Both live here:
 *
 *   - `parsePolicyText` is the single parse entry (wraps `jsonc-parser`;
 *     never hand-roll comment stripping — a `//` inside a string, like a
 *     URL in a `reason` field, breaks every regex stripper).
 *   - `readPolicyRoot` / `readPolicyObjectSafe` / `readPolicySection` are
 *     the read shapes consumers map onto (throwing tri-state, null-safe,
 *     and fail-open-section respectively).
 *
 * The arch-check bans a `readFileSync` of the policy path (and a
 * `JSON.parse` of its text) outside this module — the pre-JSONC era had
 * EIGHT independent reader families, which is exactly the Rule 2.30
 * divergence class this module retires.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse as jsoncParse, printParseErrorCode, type ParseError } from 'jsonc-parser';

/** Conventional policy path relative to a repo root. Kept here (not imported
 *  from policy.ts) so this module stays a leaf with no internal imports. */
export const POLICY_RELATIVE_PATH = path.join('.dxkit', 'policy.json');

/** Absolute path of the conventional policy file for a repo. */
export function policyPathFor(cwd: string): string {
  return path.join(cwd, POLICY_RELATIVE_PATH);
}

/** The ONE formatting-options value every dxkit JSONC edit uses (the policy
 *  merge-writer, the `.vscode` association) — one home, never re-declared. */
export const JSONC_EDIT_FORMAT = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/**
 * Strict JSONC parse (comments + trailing commas allowed; strict JSON is a
 * subset). Throws with a positional, human-readable message on malformed
 * input. The generic primitive under `parsePolicyText`, shared with every
 * other JSONC surface (the `.vscode` settings merge) — one parser, one
 * leniency contract.
 */
export function parseJsoncText(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = jsoncParse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    const { line, column } = offsetToPosition(text, first.offset);
    throw new Error(
      `${printParseErrorCode(first.error)} at line ${line}, column ${column}` +
        (errors.length > 1 ? ` (+${errors.length - 1} more)` : ''),
    );
  }
  return value;
}

/**
 * Parse POLICY text as JSONC — callers that want fail-open semantics wrap it.
 * (Alias of the generic primitive; kept as the policy-named entry point every
 * policy reader routes through.)
 */
export function parsePolicyText(text: string): unknown {
  return parseJsoncText(text);
}

/** 1-based line/column for a character offset (error messages only). */
function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  const upTo = text.slice(0, offset);
  const line = upTo.split('\n').length;
  const lastNewline = upTo.lastIndexOf('\n');
  return { line, column: offset - lastNewline };
}

/** Tri-state read of a policy file — the shape every throwing/refusing
 *  consumer (resolvePolicy, the merge-writer, policy sync) maps onto. */
export type PolicyRootRead =
  | { readonly status: 'absent' }
  | { readonly status: 'malformed'; readonly error: string }
  | { readonly status: 'ok'; readonly value: Record<string, unknown>; readonly text: string };

/**
 * Read + parse a policy file at an explicit absolute path. `absent` when the
 * file does not exist; `malformed` when it is unreadable, unparseable, or its
 * root is not an object; `ok` with the parsed root and raw text otherwise.
 */
export function readPolicyRoot(absPath: string): PolicyRootRead {
  if (!fs.existsSync(absPath)) return { status: 'absent' };
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return { status: 'malformed', error: `not readable (${(err as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = parsePolicyText(text);
  } catch (err) {
    return { status: 'malformed', error: (err as Error).message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'malformed', error: 'root is not an object' };
  }
  return { status: 'ok', value: parsed as Record<string, unknown>, text };
}

/**
 * Null-safe whole-file read of the conventional policy file: the parsed root
 * object, or `null` when the file is absent OR malformed. Mirrors the
 * `readJsonSafe` semantics the doctor/advisor probes were built on.
 */
export function readPolicyObjectSafe(cwd: string): Record<string, unknown> | null {
  const read = readPolicyRoot(policyPathFor(cwd));
  return read.status === 'ok' ? read.value : null;
}

/**
 * Fail-open read of ONE top-level policy section (`flow`, `loop`,
 * `duplication`, …): the section's raw object, or `undefined` when the file
 * is absent/malformed, the section is missing, or it is not a plain object.
 * The shared entry the per-gate config readers narrow their types from.
 */
export function readPolicySection(cwd: string, key: string): Record<string, unknown> | undefined {
  const root = readPolicyObjectSafe(cwd);
  const section = root?.[key];
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : undefined;
}
