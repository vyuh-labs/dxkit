/**
 * The generated policy scaffold (4.3) — never hand-written, assembled from the
 * registries so it cannot drift from what dxkit actually reads:
 *
 *   - ACTIVE section: the values init/configure computed for this repo, each
 *     carrying its per-parameter trailing comment from the ONE metadata table
 *     (`policy-metadata.ts`);
 *   - OPT-IN section: one commented-out, syntactically-complete stanza per
 *     dormant capability. Uncommenting IS activation (E3) — the renderer
 *     serializes example VALUES itself, so a stanza can never be emitted
 *     unparseable, and every member line ends in a comma (JSONC allows the
 *     trailing one) so any subset of uncommented stanzas parses.
 *
 * `renderStanzaBlock` is shared with `policy sync` (P6): the missing-stanza
 * append uses the exact renderer init used, so a synced file and a fresh
 * scaffold teach identically.
 */
import {
  POLICY_GUIDE_URL,
  POLICY_STANZAS,
  paramMetaFor,
  type PolicyStanzaMeta,
  type ScaffoldCtx,
} from './policy-metadata';

const INDENT = '  ';

/** Local-path schema stamp: offline, and version-matched to the installed
 *  dxkit. The hosted mirror is named in the header comment (decision A5). */
export const POLICY_SCHEMA_STAMP = './node_modules/@vyuhlabs/dxkit/policy.schema.json';

export interface RenderScaffoldOptions {
  /** Values rendered ACTIVE (the fold of the configure plan's patches, or an
   *  existing policy's content). Stanzas whose top-level key appears here are
   *  suppressed — the capability is already on. */
  readonly active: Record<string, unknown>;
  readonly ctx: ScaffoldCtx;
  /** dxkit version stamped in the header (staleness signal for `policy sync`). */
  readonly version: string;
  /** TEST MODE: emit every stanza's code lines uncommented. Proves the
   *  "uncomment to activate" promise parses — never used for a real write. */
  readonly activateAllStanzas?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Trailing comment for a parameter path, from the shared metadata table. */
function paramComment(path: string): string | undefined {
  const meta = paramMetaFor(path);
  if (!meta) return undefined;
  const values = meta.enumValues ? ` (${meta.enumValues.join(' | ')})` : '';
  return `${meta.summary}${values} → policy-guide#${meta.anchor}`;
}

/** Inline JSON with a space after commas — `["GPL-", "AGPL-"]` reads better
 *  in a teaching file than the packed stringify form. */
function renderInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((el) => renderInline(el)).join(', ')}]`;
  return JSON.stringify(value);
}

interface MemberOptions {
  /** Suppress the trailing comment on THIS member's own line (used for a
   *  stanza's top-level key, whose header + blurb already teach it). */
  readonly omitOwnComment?: boolean;
}

/** Render one `"key": value,` member (possibly multi-line), trailing comment
 *  on the line that opens the value. Every member ends in a comma — JSONC
 *  accepts the trailing one, which is what makes uncommenting any stanza
 *  after the last active member safe. */
function renderMember(
  key: string,
  value: unknown,
  pathSegs: readonly string[],
  depth: number,
  opts: MemberOptions = {},
): string[] {
  const ind = INDENT.repeat(depth);
  const comment = opts.omitOwnComment ? undefined : paramComment(pathSegs.join('.'));
  const suffix = comment ? ` // ${comment}` : '';

  if (isPlainObject(value)) {
    const inner = Object.entries(value).flatMap(([k, v]) =>
      renderMember(k, v, [...pathSegs, k], depth + 1),
    );
    return [`${ind}"${key}": {${opts.omitOwnComment ? '' : suffix}`, ...inner, `${ind}},`];
  }
  if (Array.isArray(value) && value.some((el) => isPlainObject(el))) {
    const inner = value.flatMap((el) => renderArrayElement(el, depth + 1));
    return [`${ind}"${key}": [${suffix}`, ...inner, `${ind}],`];
  }
  return [`${ind}"${key}": ${renderInline(value)},${suffix}`];
}

/** Render one array element (object elements multi-line; no comments inside). */
function renderArrayElement(el: unknown, depth: number): string[] {
  const ind = INDENT.repeat(depth);
  if (!isPlainObject(el)) return [`${ind}${renderInline(el)},`];
  const inner = Object.entries(el).map(([k, v]) => `${ind}${INDENT}"${k}": ${renderInline(v)},`);
  return [`${ind}{`, ...inner, `${ind}},`];
}

/**
 * One opt-in stanza as scaffold lines. `activate` emits the code lines
 * uncommented (test mode); the default comments them out.
 */
export function renderStanzaBlock(
  stanza: PolicyStanzaMeta,
  ctx: ScaffoldCtx,
  opts: { readonly activate?: boolean } = {},
): string[] {
  const ind = INDENT;
  const lines: string[] = [];
  lines.push(`${ind}// ── ${stanza.title} ──  policy-guide#${stanza.anchor}`);
  for (const b of stanza.blurb) lines.push(`${ind}// ${b}`);
  const code = renderMember(stanza.key, stanza.example(ctx), [stanza.key], 1, {
    omitOwnComment: true,
  });
  if (opts.activate) {
    lines.push(...code);
  } else {
    for (const c of code) lines.push(`${ind}// ${c.slice(ind.length)}`);
  }
  for (const f of stanza.followUp ?? []) lines.push(`${ind}// ${f}`);
  return lines;
}

/** The stanzas the scaffold would emit for this repo + active set. */
export function applicableStanzas(
  active: Record<string, unknown>,
  ctx: ScaffoldCtx,
): readonly PolicyStanzaMeta[] {
  const activeKeys = new Set(Object.keys(active));
  return POLICY_STANZAS.filter(
    (s) => !activeKeys.has(s.key) && (s.appliesWhen ? s.appliesWhen(ctx) : true),
  );
}

/** Render the full policy scaffold text (ends in a newline). */
export function renderPolicyScaffold(opts: RenderScaffoldOptions): string {
  const { active, ctx } = opts;
  const lines: string[] = [];

  lines.push('{');
  lines.push(`${INDENT}// ── dxkit policy ──  scaffolded by dxkit ${opts.version}`);
  lines.push(`${INDENT}// This file is JSONC: comments are welcome, and dxkit's own tools`);
  lines.push(`${INDENT}// preserve them. Uncommenting an opt-in stanza below ACTIVATES it.`);
  lines.push(`${INDENT}// Every knob's teaching guide (the policy-guide#… anchors resolve here):`);
  lines.push(`${INDENT}// ${POLICY_GUIDE_URL}`);
  lines.push(`${INDENT}"$schema": ${JSON.stringify(POLICY_SCHEMA_STAMP)},`);

  for (const [key, value] of Object.entries(active)) {
    lines.push(...renderMember(key, value, [key], 1));
  }

  const stanzas = applicableStanzas(active, ctx);
  for (const stanza of stanzas) {
    lines.push('');
    lines.push(...renderStanzaBlock(stanza, ctx, { activate: opts.activateAllStanzas }));
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}
