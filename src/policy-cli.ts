/**
 * `vyuh-dxkit policy get <dotted.path> [--default <v>]` — the one policy
 * reader for scripts and shipped workflow YAML (Rule 2 applied to CI).
 *
 * Before this command, every workflow template that needed a policy value
 * hand-rolled a `node -e "require('./.dxkit/policy.json')…"` one-liner — N
 * independent parsers in templates, the same divergence class the policy-text
 * module retires in `src/`, and every one of them a strict-JSON reader that
 * breaks the day the policy file carries a comment. `policy get` routes the
 * read through the canonical JSONC entry point instead.
 *
 * Output contract (built for `$(…)` capture in shell):
 *   - strings / numbers / booleans print raw (no quotes, no trailing
 *     decoration), objects / arrays print as compact JSON, `null` prints
 *     `null`;
 *   - an absent path (or an absent/malformed file) prints `--default` when
 *     one is given and exits 0 — a workflow step must be able to degrade to
 *     its documented default without a shell conditional;
 *   - with no `--default`, an absent path exits 1 with a note on stderr
 *     (loud, so a typo'd path in a script never reads as "empty value"), and
 *     a malformed file exits 1 with the parse error.
 */
import * as logger from './logger';
import { policyPathFor, readPolicyRoot } from './baseline/policy-text';

export interface PolicyGetOptions {
  /** Value to print (exit 0) when the path, file, or parse is absent. */
  readonly default?: string;
}

export type PolicyGetResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

/** Walk a dotted path over plain objects; undefined the moment a segment
 *  is missing or the current value is not a plain object. */
function valueAtPath(root: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = root;
  for (const seg of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Render a policy value for `$(…)` capture. */
function renderValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Pure resolution — the whole command minus process I/O, for tests and any
 *  future in-process consumer. */
export function resolvePolicyGet(
  cwd: string,
  dotted: string,
  opts: PolicyGetOptions = {},
): PolicyGetResult {
  const read = readPolicyRoot(policyPathFor(cwd));

  if (read.status === 'malformed') {
    if (opts.default !== undefined) return { ok: true, output: opts.default };
    return { ok: false, error: `policy file is not valid JSON/JSONC: ${read.error}` };
  }

  const value = read.status === 'ok' ? valueAtPath(read.value, dotted) : undefined;
  if (value === undefined) {
    if (opts.default !== undefined) return { ok: true, output: opts.default };
    return {
      ok: false,
      error:
        read.status === 'absent'
          ? `no policy file at .dxkit/policy.json and no --default given`
          : `policy has no value at '${dotted}' and no --default given`,
    };
  }

  return { ok: true, output: renderValue(value) };
}

export function runPolicyGet(cwd: string, dotted: string, opts: PolicyGetOptions = {}): void {
  const result = resolvePolicyGet(cwd, dotted, opts);
  if (result.ok) {
    process.stdout.write(result.output + '\n');
    return;
  }
  logger.fail(result.error);
  process.exitCode = 1;
}
