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

// ─── policy set ─────────────────────────────────────────────────────────────

export interface PolicySetOptions {
  readonly json?: boolean;
}

export interface PolicySetOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** Managed files the post-write refresh touched (empty when no install). */
  readonly refreshed: readonly string[];
  /** Installer notes worth echoing (schedule renders, secret reminders). */
  readonly notes: readonly string[];
}

/** Parse a CLI value: JSON when it parses (`true`, `5`, `[]`, `"x"`), else the
 *  raw string — so `policy set depBump.schedule daily` needs no quoting. */
function parseSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Nested single-leaf patch from a dotted path. */
function patchFor(dotted: string, value: unknown): Record<string, unknown> {
  const segs = dotted.split('.');
  let out: unknown = value;
  for (let i = segs.length - 1; i >= 0; i--) out = { [segs[i]]: out };
  return out as Record<string, unknown>;
}

/**
 * `vyuh-dxkit policy set <dotted.path> <value>` — the incantation killer
 * (4.3.4). One command that (1) validates the path against the knob registry
 * (`POLICY_PARAMS` — the same metadata that renders the schema, the teaching
 * comments, and the policy guide, so "settable" and "documented" cannot
 * drift), (2) merge-writes through the ONE comment-preserving writer, (3)
 * reads the value back through the public reader, and (4) re-runs update's
 * OWN managed-surface refresh so the workflows the knob gates re-render
 * immediately — "remember to run update after a policy change" stops being
 * knowledge the user must carry. The structured blocks (`checks[]`,
 * `pairedChecks[]`) stay file-edited: an array of objects has no honest
 * one-argument form, and pretending otherwise would mangle exactly the
 * config a human most needs to review.
 */
export async function resolvePolicySet(
  cwd: string,
  dotted: string,
  rawValue: string,
): Promise<PolicySetOutcome> {
  const { POLICY_PARAMS, paramMetaFor } = await import('./baseline/policy-metadata');
  const meta = paramMetaFor(dotted);
  if (!meta) {
    const last = dotted.split('.').pop() ?? dotted;
    const near = POLICY_PARAMS.filter(
      (p) => p.path.includes(last) || p.path.startsWith(dotted.split('.')[0] ?? ''),
    )
      .map((p) => p.path)
      .slice(0, 5);
    return {
      ok: false,
      message:
        `'${dotted}' is not a settable policy knob.` +
        (near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '') +
        ` Structured blocks (checks, pairedChecks) are edited in .dxkit/policy.json directly;` +
        ` the full knob index is in the policy guide.`,
      refreshed: [],
      notes: [],
    };
  }
  const value = parseSetValue(rawValue);
  if (meta.enumValues && (typeof value !== 'string' || !meta.enumValues.includes(value))) {
    return {
      ok: false,
      message: `'${dotted}' takes one of: ${meta.enumValues.join(', ')} (got ${JSON.stringify(value)})`,
      refreshed: [],
      notes: [],
    };
  }

  const { mergeIntoPolicyFile } = await import('./baseline/policy-write');
  const outcome = mergeIntoPolicyFile(cwd, patchFor(dotted, value));
  if (outcome.reason === 'malformed-policy') {
    return {
      ok: false,
      message:
        '.dxkit/policy.json is not valid JSON/JSONC — left untouched. Fix the file, then re-run.',
      refreshed: [],
      notes: [],
    };
  }

  // Read back through the public reader — a merge that silently did not take
  // must be caught here, not discovered in CI.
  const read = readPolicyRoot(policyPathFor(cwd));
  const got = read.status === 'ok' ? valueAtPath(read.value, dotted) : undefined;
  if (JSON.stringify(got) !== JSON.stringify(value)) {
    return {
      ok: false,
      message: `policy did not read back as written: ${dotted}=${JSON.stringify(got)} (wanted ${JSON.stringify(value)})`,
      refreshed: [],
      notes: [],
    };
  }

  // The post-write refresh: update's OWN lane (Rule 2 — a second refresh
  // path here would drift from update's provenance rules). Only on an
  // installed repo; a policy-only checkout just writes the file.
  const refreshed: string[] = [];
  const notes: string[] = [];
  const fs = await import('fs');
  const path = await import('path');
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const { resolveInstallFlags } = await import('./update');
      const { refreshManagedSurfaces } = await import('./managed-artifacts');
      const { flags } = resolveInstallFlags(manifest, cwd);
      refreshManagedSurfaces(cwd, { force: false, flags }, (r) => {
        refreshed.push(...r.installed);
        notes.push(...r.notes);
      });
    } catch (err) {
      notes.push(
        `managed-surface refresh failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `run \`vyuh-dxkit update\` to re-render the workflows this knob gates`,
      );
    }
  } else {
    notes.push(
      'no dxkit install here (.vyuh-dxkit.json absent) — policy written, workflows untouched',
    );
  }

  return {
    ok: true,
    message: `${dotted} = ${renderValue(value)}${outcome.changed === false ? ' (already set)' : ''}`,
    refreshed,
    notes,
  };
}

export async function runPolicySet(
  cwd: string,
  dotted: string,
  rawValue: string,
  opts: PolicySetOptions = {},
): Promise<void> {
  const result = await resolvePolicySet(cwd, dotted, rawValue);
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    logger.fail(result.message);
    process.exitCode = 1;
    return;
  }
  logger.success(result.message);
  for (const f of [...new Set(result.refreshed)]) logger.info(`  refreshed ${f}`);
  for (const n of result.notes) logger.info(`  ${n}`);
}
