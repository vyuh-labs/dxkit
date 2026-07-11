/**
 * Model-schema normalization — the shared, identity-bearing canonicalizer
 * for field types and optionality (mirror of `flow/normalize.ts` for paths
 * and verbs). Treat changes here with the care of a fingerprint-scheme bump:
 * a normalization change re-keys every committed allowlist decision that
 * names a type.
 *
 * Deliberately LEXICAL: it canonicalizes spelling (whitespace, optionality
 * wrappers, pack-declared aliases) and never attempts cross-language or
 * resolved-type equivalence — `varchar(255)` and `string` stay distinct
 * unless a pack aliases them, and a type alias's underlying change is a
 * documented blind spot (resolving it would need a type-checker, which would
 * break the gate's ref-reliability).
 */

/** A field's normalized shape facts. `null` = not determinable — and an
 *  unknown NEVER blocks (the diff caps unknown-touching findings below the
 *  block threshold). */
export interface NormalizedField {
  readonly type: string | null;
  readonly required: boolean | null;
}

/** Optionality wrappers folded OUT of a type's text, each mapping to
 *  "optional": TS/JS `| null` / `| undefined`, Python `Optional[X]` /
 *  `X | None`, Go's pointer `*X`. Order-independent for unions. */
const NULLISH_UNION_MEMBERS = new Set(['null', 'undefined', 'none']);

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Fold a raw type text into its canonical token + an optionality signal.
 * Returns `optional: true` only when an optionality WRAPPER was folded;
 * absence of a wrapper says nothing (the field's baseline requiredness comes
 * from the grammar marker / descriptor keyword, not from here).
 */
function foldTypeText(
  raw: string,
  wrappers?: readonly string[],
): { type: string; optional: boolean } {
  let text = stripWhitespace(raw);
  let optional = false;

  // Go pointer: *X → X, optional.
  while (text.startsWith('*')) {
    text = text.slice(1);
    optional = true;
  }

  // Pack-declared transparent wrappers + Optional[X], folded in a loop so
  // nesting resolves in any order: so.Mapped[Optional[str]] → str, optional.
  for (;;) {
    const wrapper = /^(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\[(.+)\]$/.exec(text);
    if (!wrapper) break;
    if (wrapper[1] === 'Optional') {
      text = wrapper[2];
      optional = true;
    } else if (wrappers?.includes(wrapper[1])) {
      text = wrapper[2];
    } else {
      break;
    }
  }

  // Union with a nullish member: X|null, None|X, X|null|undefined → X.
  if (text.includes('|')) {
    const members = text.split('|');
    const solid = members.filter((m) => !NULLISH_UNION_MEMBERS.has(m.toLowerCase()));
    if (solid.length < members.length) {
      optional = true;
      text = solid.join('|');
    }
  }

  return { type: text, optional };
}

/** Fold a type token through a pack's lexical aliases (keys lowercase). */
export function applyTypeAliases(
  type: string,
  aliases: Readonly<Record<string, string>> | undefined,
): string {
  return aliases?.[type.toLowerCase()] ?? type;
}

/**
 * Normalize one field's raw facts into its canonical `{ type, required }`.
 *
 * Requiredness resolution, most-specific wins:
 *   1. an EXPLICIT descriptor signal (`nullable=True` written on a field
 *      constructor) — `descriptorOptional`;
 *   2. an optionality wrapper folded from the type text (`Optional[X]`,
 *      `| null`, `*X`);
 *   3. the grammar-level marker (`?`, pointer type) — `markerOptional`;
 *   4. the framework DEFAULT for an absent keyword —
 *      `descriptorDefaultOptional` (Django's null=False, weakest signal);
 *   5. otherwise: required when a type is known, unknown (null) when not.
 */
export function normalizeField(opts: {
  rawType: string | null;
  markerOptional: boolean | null;
  descriptorOptional?: boolean | null;
  /** The framework default when the optionality keyword is ABSENT — ranks
   *  below a folded annotation (SQLAlchemy 2.0 derives nullability from
   *  `Mapped[Optional[X]]`), above bare type-presence. */
  descriptorDefaultOptional?: boolean | null;
  typeAliases?: Readonly<Record<string, string>>;
  typeWrappers?: readonly string[];
  /** What a typed field with NO optionality signal means (pack-declared):
   *  `'required'` (TS/Pydantic semantics — the engine default) or
   *  `'unknown'` (JPA — an honest null that never gates). */
  defaultFieldOptionality?: 'required' | 'unknown';
}): NormalizedField {
  let type: string | null = null;
  let foldedOptional = false;
  if (opts.rawType !== null && opts.rawType !== '') {
    const folded = foldTypeText(opts.rawType, opts.typeWrappers);
    type = applyTypeAliases(folded.type, opts.typeAliases);
    foldedOptional = folded.optional;
  }

  let required: boolean | null;
  if (opts.descriptorOptional !== undefined && opts.descriptorOptional !== null) {
    required = !opts.descriptorOptional; // explicit kwarg — authoritative
  } else if (foldedOptional) {
    required = false; // the annotation said Optional/| null
  } else if (opts.markerOptional !== null) {
    required = !opts.markerOptional;
  } else if (
    opts.descriptorDefaultOptional !== undefined &&
    opts.descriptorDefaultOptional !== null
  ) {
    required = !opts.descriptorDefaultOptional; // framework default (weakest signal)
  } else if (type !== null && opts.defaultFieldOptionality !== 'unknown') {
    required = true;
  } else {
    required = null;
  }

  return { type, required };
}

/** The wire field name carried by a Go-style struct tag for `key`
 *  (`json:"email,omitempty"` → `email`), plus its omitempty optionality.
 *  Null when the tag has no entry for the key or excludes the field (`-`). */
export function tagWireName(tag: string, key: string): { name: string; optional: boolean } | null {
  const m = new RegExp(`\\b${key}:"([^"]*)"`).exec(tag);
  if (!m) return null;
  const parts = m[1].split(',');
  const name = parts[0];
  if (name === '' || name === '-') return null;
  return { name, optional: parts.includes('omitempty') };
}
