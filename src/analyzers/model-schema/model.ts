/**
 * The model-schema domain model: extracted entities, the name-anchored
 * base↔head join, and the ONE drift diff (Rule 2 — `diffModelSets` is the
 * single computation of "what changed", consumed by BOTH the guardrail gate
 * and the `schema diff` CLI; a parity test pins them).
 *
 * Join discipline (decided in design review): a model is a CONTRACT-domain
 * entity — its name is its address, the file is where it happens to live
 * today. So pairing anchors on the NAME and tolerates relocation:
 * relocating an unchanged declaration is never drift; renaming the
 * declaration is. Identity (Rule 9) follows the same doctrine — the
 * fingerprint hashes (model, field, changeClass) and nothing locational.
 */

/** One declared field, normalized. `null` facts are honest unknowns — the
 *  diff never lets an unknown-touching comparison block. */
export interface ModelField {
  readonly name: string;
  readonly type: string | null;
  readonly required: boolean | null;
}

/** One extracted data model. `file` is repo-relative when gathered with
 *  `relativeTo` (Rule 9 discipline); `line` is display metadata, never
 *  identity. `via` is display provenance: the marker that recognized the
 *  model — `type-ref` (referenced from a container property, EF Core's
 *  `DbSet<T>`) and `schema-file` (minted from a declared schema file's
 *  table calls, Rails `db/schema.rb`) join the source-marker kinds. */
export interface ModelEntity {
  readonly name: string;
  readonly via: 'base-class' | 'decorator' | 'struct-tag' | 'spec' | 'type-ref' | 'schema-file';
  readonly file: string;
  readonly line: number;
  readonly fields: readonly ModelField[];
  /** The declaration carries a partial-class marker (C#) — same-name
   *  entities that are ALL partial merge into one at model-set assembly. */
  readonly partial?: boolean;
}

/** A recognized model with no statically readable fields — either genuinely
 *  empty or dynamically built. Disclosed (mirror of flow's `dynamicCalls`),
 *  never silently dropped; the entity ALSO stays in `models` so a later
 *  readable version diffs as field additions, not a phantom model-added. */
export interface DynamicModelSite {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

/** One side's extracted models (one repo at one ref). */
export interface ModelSet {
  readonly models: readonly ModelEntity[];
  readonly dynamicModels: readonly DynamicModelSite[];
}

/**
 * Merge same-name entities that are ALL partial-marked into one (fields =
 * name-deduplicated union, location = the first declaration) — the model-set
 * ASSEMBLY step for C# partial classes. One logical type is split across
 * several declarations (typically codegen), so without the merge a field
 * moving between partials reads as remove+add and a second declaration reads
 * as a duplicate model. A same-name group with ANY non-partial member is
 * left untouched: the C# compiler rejects same-name-same-namespace
 * non-partial duplicates, so a mixed group means genuinely distinct types
 * (different namespaces) and merging would fabricate one.
 */
export function mergePartialEntities(models: readonly ModelEntity[]): ModelEntity[] {
  const byName = new Map<string, ModelEntity[]>();
  for (const m of models) {
    const group = byName.get(m.name);
    if (group) group.push(m);
    else byName.set(m.name, [m]);
  }
  const out: ModelEntity[] = [];
  for (const group of byName.values()) {
    if (group.length < 2 || !group.every((m) => m.partial === true)) {
      out.push(...group);
      continue;
    }
    const fields: ModelField[] = [];
    const seen = new Set<string>();
    for (const m of group) {
      for (const f of m.fields) {
        if (seen.has(f.name)) continue;
        seen.add(f.name);
        fields.push(f);
      }
    }
    out.push({ ...group[0], fields });
  }
  return out;
}

export type ModelPairReason = 'exact' | 'relocated' | 'similarity';

/** A base↔head correspondence with match confidence, `matchAcrossRuns`
 *  style: reasons are structured, confidence is in [0, 1] and propagates
 *  into every finding minted off the pair. */
export interface ModelPair {
  readonly base: ModelEntity;
  readonly head: ModelEntity;
  readonly reason: ModelPairReason;
  readonly confidence: number;
}

export interface ModelJoin {
  readonly pairs: readonly ModelPair[];
  readonly removed: readonly ModelEntity[];
  readonly added: readonly ModelEntity[];
}

/** Field-name-set Jaccard similarity — the disambiguator when several
 *  same-named models exist and file matching leaves candidates unresolved. */
function fieldSimilarity(a: ModelEntity, b: ModelEntity): number {
  const an = new Set(a.fields.map((f) => f.name));
  const bn = new Set(b.fields.map((f) => f.name));
  if (an.size === 0 && bn.size === 0) return 1;
  let shared = 0;
  for (const n of an) if (bn.has(n)) shared++;
  const union = an.size + bn.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Minimum field-set similarity for a cross-file pairing of same-named
 *  models when more than one candidate is in play. */
const SIMILARITY_FLOOR = 0.5;

/**
 * Pair base and head models: name-anchored, two-stage (exact file, then
 * field-set similarity). A single candidate on each side pairs regardless
 * of file — that IS the relocation tolerance.
 */
export function pairModels(base: ModelSet, head: ModelSet): ModelJoin {
  const byName = (models: readonly ModelEntity[]) => {
    const m = new Map<string, ModelEntity[]>();
    for (const e of models) {
      const list = m.get(e.name);
      if (list) list.push(e);
      else m.set(e.name, [e]);
    }
    return m;
  };
  const baseByName = byName(base.models);
  const headByName = byName(head.models);

  const pairs: ModelPair[] = [];
  const removed: ModelEntity[] = [];
  const added: ModelEntity[] = [];

  for (const [name, baseGroup] of baseByName) {
    const headGroup = headByName.get(name);
    if (!headGroup) {
      removed.push(...baseGroup);
      continue;
    }

    const baseLeft = [...baseGroup];
    const headLeft = [...headGroup];

    // Stage 1: exact file.
    for (let i = baseLeft.length - 1; i >= 0; i--) {
      const j = headLeft.findIndex((h) => h.file === baseLeft[i].file);
      if (j >= 0) {
        pairs.push({ base: baseLeft[i], head: headLeft[j], reason: 'exact', confidence: 1 });
        baseLeft.splice(i, 1);
        headLeft.splice(j, 1);
      }
    }

    // Stage 2: single leftover on each side pairs unconditionally — the
    // relocation case. With several candidates, greedy best field-set
    // similarity above the floor.
    if (baseLeft.length === 1 && headLeft.length === 1) {
      pairs.push({ base: baseLeft[0], head: headLeft[0], reason: 'relocated', confidence: 1 });
      baseLeft.length = 0;
      headLeft.length = 0;
    } else {
      while (baseLeft.length > 0 && headLeft.length > 0) {
        let best: { bi: number; hi: number; score: number } | null = null;
        for (let bi = 0; bi < baseLeft.length; bi++) {
          for (let hi = 0; hi < headLeft.length; hi++) {
            const score = fieldSimilarity(baseLeft[bi], headLeft[hi]);
            if (!best || score > best.score) best = { bi, hi, score };
          }
        }
        if (!best || best.score < SIMILARITY_FLOOR) break;
        pairs.push({
          base: baseLeft[best.bi],
          head: headLeft[best.hi],
          reason: 'similarity',
          confidence: best.score,
        });
        baseLeft.splice(best.bi, 1);
        headLeft.splice(best.hi, 1);
      }
    }

    removed.push(...baseLeft);
    added.push(...headLeft);
  }

  for (const [name, headGroup] of headByName) {
    if (!baseByName.has(name)) added.push(...headGroup);
  }

  return { pairs, removed, added };
}

/** The fixed drift taxonomy. Which classes BLOCK is gate posture
 *  (`gate.ts`), not a property of the diff. */
export type DriftClass =
  | 'model-removed'
  | 'model-added'
  | 'field-removed'
  | 'field-added'
  | 'field-added-required'
  | 'field-type-changed'
  | 'field-required-added'
  | 'field-optionality-relaxed';

/** One detected change. `file`/`line` locate the HEAD side when it exists
 *  (the base side for removals) — display metadata, never identity. */
export interface SchemaDrift {
  readonly changeClass: DriftClass;
  readonly model: string;
  readonly field: string | null;
  /** Normalized before/after facts for the message (null = unknown/absent). */
  readonly from: string | null;
  readonly to: string | null;
  readonly file: string;
  readonly line: number;
  /** Intrinsic confidence in [0, 1]: pair confidence, degraded when an
   *  unknown participates. The gate blocks only at/above its threshold, so
   *  an unknown-touching finding can warn but never block. */
  readonly confidence: number;
}

/** Confidence for a comparison where one side's fact is unknown — below
 *  every sane block threshold by construction. */
const UNKNOWN_CONFIDENCE = 0.4;

function fieldMap(e: ModelEntity): Map<string, ModelField> {
  const m = new Map<string, ModelField>();
  for (const f of e.fields) m.set(f.name, f);
  return m;
}

/**
 * THE drift diff — pure over two model sets. Base is the grandfather by
 * construction: only differences between the two refs surface, so
 * pre-existing state can never produce a finding.
 */
export function diffModelSets(base: ModelSet, head: ModelSet): SchemaDrift[] {
  const { pairs, removed, added } = pairModels(base, head);
  const out: SchemaDrift[] = [];

  for (const e of removed) {
    out.push({
      changeClass: 'model-removed',
      model: e.name,
      field: null,
      from: e.file,
      to: null,
      file: e.file,
      line: e.line,
      confidence: 1,
    });
  }
  for (const e of added) {
    out.push({
      changeClass: 'model-added',
      model: e.name,
      field: null,
      from: null,
      to: e.file,
      file: e.file,
      line: e.line,
      confidence: 1,
    });
  }

  for (const pair of pairs) {
    const baseFields = fieldMap(pair.base);
    const headFields = fieldMap(pair.head);
    const at = { file: pair.head.file, line: pair.head.line };

    for (const [name, bf] of baseFields) {
      const hf = headFields.get(name);
      if (!hf) {
        out.push({
          changeClass: 'field-removed',
          model: pair.base.name,
          field: name,
          from: bf.type,
          to: null,
          ...at,
          confidence: pair.confidence,
        });
        continue;
      }

      // Type comparison. Both known and different → real drift at pair
      // confidence. Exactly one side unknown → disclosed at UNKNOWN
      // confidence (warns, never blocks): the visible fact changed, but we
      // cannot prove the wire type did. Both unknown → nothing to compare.
      if (bf.type !== hf.type) {
        const bothKnown = bf.type !== null && hf.type !== null;
        if (bothKnown || bf.type !== null || hf.type !== null) {
          out.push({
            changeClass: 'field-type-changed',
            model: pair.base.name,
            field: name,
            from: bf.type,
            to: hf.type,
            ...at,
            confidence: bothKnown ? pair.confidence : UNKNOWN_CONFIDENCE,
          });
        }
      }

      // Requiredness transitions only when both sides are known — an
      // unknown-to-known transition is visibility, not drift.
      if (bf.required !== null && hf.required !== null && bf.required !== hf.required) {
        out.push({
          changeClass: hf.required ? 'field-required-added' : 'field-optionality-relaxed',
          model: pair.base.name,
          field: name,
          from: String(bf.required),
          to: String(hf.required),
          ...at,
          confidence: pair.confidence,
        });
      }
    }

    for (const [name, hf] of headFields) {
      if (baseFields.has(name)) continue;
      out.push({
        changeClass: hf.required === true ? 'field-added-required' : 'field-added',
        model: pair.base.name,
        field: name,
        from: null,
        to: hf.type,
        ...at,
        confidence: pair.confidence,
      });
    }
  }

  // Stable output: model, then field, then class — byte-stable renderings.
  return out.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      (a.field ?? '').localeCompare(b.field ?? '') ||
      a.changeClass.localeCompare(b.changeClass),
  );
}
