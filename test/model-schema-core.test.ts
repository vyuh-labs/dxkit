/**
 * Model-schema core — extraction (grammar-agnostic, descriptor-driven),
 * normalization folds, the name-anchored relocation-tolerant join, and the
 * drift diff's taxonomy + unknown rules.
 *
 * Descriptors here are SYNTHETIC (pack declarations are pinned with their
 * own wave, mirror of the flow test layering): these tests prove the
 * extractor carries no framework literal and the diff carries no posture.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';
import { extractModelsFromTree } from '../src/analyzers/model-schema/extract';
import { normalizeField, tagWireName } from '../src/analyzers/model-schema/normalize';
import {
  diffModelSets,
  pairModels,
  type ModelEntity,
  type ModelSet,
} from '../src/analyzers/model-schema/model';
import type { ModelSchemaSupport } from '../src/languages/types';

async function extract(
  src: string,
  grammar: string,
  descriptor: ModelSchemaSupport,
  file = 'sample',
): Promise<ModelSet> {
  const tree = await parseSource(src, grammar);
  expect(tree, `parse ${grammar}`).not.toBeNull();
  return extractModelsFromTree(
    tree!.rootNode,
    descriptor,
    modelShapeForGrammar(grammar)!,
    grammarShape(grammar),
    file,
  );
}

function entity(name: string, file: string, fields: ModelEntity['fields']): ModelEntity {
  return { name, via: 'base-class', file, line: 1, fields };
}
function set(...models: ModelEntity[]): ModelSet {
  return { models, dynamicModels: [] };
}

describe('normalize', () => {
  it('folds optionality wrappers out of type text', () => {
    expect(normalizeField({ rawType: 'Optional[int]', markerOptional: null })).toEqual({
      type: 'int',
      required: false,
    });
    expect(normalizeField({ rawType: 'str | None', markerOptional: null })).toEqual({
      type: 'str',
      required: false,
    });
    expect(normalizeField({ rawType: 'string | null', markerOptional: false })).toEqual({
      type: 'string',
      required: false,
    });
    expect(normalizeField({ rawType: '*string', markerOptional: true })).toEqual({
      type: 'string',
      required: false,
    });
  });

  it('folds pack-declared transparent wrappers before other folds', () => {
    expect(
      normalizeField({
        rawType: 'so.Mapped[Optional[str]]',
        markerOptional: null,
        typeWrappers: ['Mapped'],
      }),
    ).toEqual({ type: 'str', required: false });
    expect(
      normalizeField({ rawType: 'Mapped[int]', markerOptional: null, typeWrappers: ['Mapped'] }),
    ).toEqual({ type: 'int', required: true });
    // Undeclared wrapper stays — it IS the type.
    expect(
      normalizeField({ rawType: 'List[int]', markerOptional: null, typeWrappers: ['Mapped'] }).type,
    ).toBe('List[int]');
  });

  it('resolves requiredness by specificity: descriptor > fold > marker', () => {
    // Marker says optional (`?`), no fold, no descriptor.
    expect(normalizeField({ rawType: 'string', markerOptional: true }).required).toBe(false);
    // No marker concept (python), plain annotation → required.
    expect(normalizeField({ rawType: 'str', markerOptional: null }).required).toBe(true);
    // Descriptor wins over everything (nullable=True on a required-marked field).
    expect(
      normalizeField({ rawType: 'string', markerOptional: false, descriptorOptional: true })
        .required,
    ).toBe(false);
    // Nothing known at all.
    expect(normalizeField({ rawType: null, markerOptional: null })).toEqual({
      type: null,
      required: null,
    });
  });

  it('applies lowercase-keyed pack type aliases after folding', () => {
    expect(
      normalizeField({
        rawType: 'CharField',
        markerOptional: null,
        typeAliases: { charfield: 'string' },
      }).type,
    ).toBe('string');
  });

  it('reads struct-tag wire names, omitempty, and exclusions', () => {
    expect(tagWireName('`json:"email,omitempty" gorm:"col"`', 'json')).toEqual({
      name: 'email',
      optional: true,
    });
    expect(tagWireName('`json:"name"`', 'json')).toEqual({ name: 'name', optional: false });
    expect(tagWireName('`json:"-"`', 'json')).toBeNull();
    expect(tagWireName('`gorm:"x"`', 'json')).toBeNull();
  });
});

describe('extraction — typescript (decorator markers)', () => {
  const DESCRIPTOR: ModelSchemaSupport = { modelDecorators: ['Entity'] };

  it('extracts decorated classes only, with ? optionality and null unions', async () => {
    const { models } = await extract(
      `
@Entity()
export class User extends Base {
  email?: string;
  name: string | null;
  age: number;
}
class Helper { x: number; }
`,
      'typescript',
      DESCRIPTOR,
    );
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('User');
    expect(models[0].via).toBe('decorator');
    expect(models[0].fields).toEqual([
      { name: 'email', type: 'string', required: false },
      { name: 'name', type: 'string', required: false },
      { name: 'age', type: 'number', required: true },
    ]);
  });

  it('discloses a marked model with no readable fields as dynamic', async () => {
    const out = await extract(`@Entity() class Ghost { }`, 'typescript', DESCRIPTOR);
    expect(out.models).toHaveLength(1);
    expect(out.dynamicModels).toEqual([{ name: 'Ghost', file: 'sample', line: 1 }]);
  });
});

describe('extraction — python (heritage + field constructors)', () => {
  it('django-style: callee type token, optionality keyword, framework default', async () => {
    const { models } = await extract(
      `
class User(models.Model):
    email = models.CharField(max_length=255, null=True)
    age = models.IntegerField()
`,
      'python',
      {
        modelBaseClasses: ['Model'],
        fieldCallees: [{ names: ['CharField', 'IntegerField'], optionalityKeyword: 'null' }],
        typeAliases: { charfield: 'string', integerfield: 'int' },
      },
    );
    expect(models[0].via).toBe('base-class');
    expect(models[0].fields).toEqual([
      { name: 'email', type: 'string', required: false },
      { name: 'age', type: 'int', required: true }, // null absent → framework default
    ]);
  });

  it('sqlalchemy-style: type from first argument, nullable keyword', async () => {
    const { models } = await extract(
      `
class Item(Base):
    id = Column(Integer, primary_key=True)
    label = db.Column(db.String(80), nullable=False)
`,
      'python',
      {
        modelBaseClasses: ['Base'],
        fieldCallees: [{ names: ['Column'], typeFrom: 'firstArg', optionalityKeyword: 'nullable' }],
      },
    );
    expect(models[0].fields).toEqual([
      { name: 'id', type: 'Integer', required: true },
      { name: 'label', type: 'String', required: true },
    ]);
  });

  it('pydantic/dataclass-style: annotations with Optional folds', async () => {
    const { models } = await extract(
      `
@dataclass
class Point:
    x: int
    y: Optional[int] = None
`,
      'python',
      { modelDecorators: ['dataclass'] },
    );
    expect(models[0].fields).toEqual([
      { name: 'x', type: 'int', required: true },
      { name: 'y', type: 'int', required: false },
    ]);
  });
});

describe('extraction — go (struct-tag markers)', () => {
  it('extracts tagged structs with wire names, omitempty, pointers, multi-name', async () => {
    const { models } = await extract(
      `
package m
type User struct {
	Email *string \`json:"email,omitempty"\`
	Name  string  \`json:"name"\`
	X, Y  int     \`json:"-"\`
	skip  helper
}
type helper struct{ n int }
`,
      'go',
      { structTagKeys: ['json'] },
    );
    expect(models).toHaveLength(1);
    expect(models[0].via).toBe('struct-tag');
    expect(models[0].fields).toEqual([
      { name: 'email', type: 'string', required: false },
      { name: 'name', type: 'string', required: true },
      { name: 'X', type: 'int', required: true }, // json:"-" → declared name kept
      { name: 'Y', type: 'int', required: true },
      { name: 'skip', type: 'helper', required: true },
    ]);
  });
});

describe('pairModels — name-anchored, relocation-tolerant', () => {
  const fields = [{ name: 'id', type: 'int', required: true }];

  it('a pure file move pairs as relocated with confidence 1', () => {
    const join = pairModels(
      set(entity('User', 'a/models.ts', fields)),
      set(entity('User', 'b/models.ts', fields)),
    );
    expect(join.pairs).toHaveLength(1);
    expect(join.pairs[0].reason).toBe('relocated');
    expect(join.pairs[0].confidence).toBe(1);
    expect(join.removed).toEqual([]);
    expect(join.added).toEqual([]);
  });

  it('same-named models in different modules disambiguate by file', () => {
    const a1 = entity('User', 'mod-a/m.ts', [{ name: 'a', type: 'int', required: true }]);
    const b1 = entity('User', 'mod-b/m.ts', [{ name: 'b', type: 'int', required: true }]);
    const join = pairModels(set(a1, b1), set({ ...a1 }, { ...b1 }));
    expect(join.pairs.every((p) => p.reason === 'exact')).toBe(true);
    expect(join.pairs).toHaveLength(2);
  });

  it('move-plus-edit pairs via similarity, not remove+add', () => {
    const base = set(
      entity('User', 'a.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: true },
        { name: 'age', type: 'int', required: true },
      ]),
      entity('User', 'other.ts', [{ name: 'zzz', type: 'int', required: true }]),
    );
    const head = set(
      entity('User', 'moved.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: true },
      ]),
      entity('User', 'other.ts', [{ name: 'zzz', type: 'int', required: true }]),
    );
    const join = pairModels(base, head);
    // After the exact stage pairs other.ts, one candidate remains per side —
    // it pairs unconditionally as relocated (single-leftover rule).
    const moved = join.pairs.find((p) => p.head.file === 'moved.ts');
    expect(moved).toBeDefined();
    expect(moved!.base.file).toBe('a.ts');
    expect(moved!.reason).toBe('relocated');
    expect(join.removed).toEqual([]);
  });

  it('multiple relocated candidates arbitrate by field-set similarity', () => {
    const base = set(
      entity('User', 'a.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: true },
      ]),
      entity('User', 'b.ts', [
        { name: 'sku', type: 'string', required: true },
        { name: 'qty', type: 'int', required: true },
      ]),
    );
    const head = set(
      entity('User', 'x.ts', [
        { name: 'sku', type: 'string', required: true },
        { name: 'qty', type: 'int', required: true },
      ]),
      entity('User', 'y.ts', [
        { name: 'id', type: 'int', required: true },
        { name: 'email', type: 'string', required: true },
      ]),
    );
    const join = pairModels(base, head);
    expect(join.pairs).toHaveLength(2);
    expect(join.pairs.every((p) => p.reason === 'similarity')).toBe(true);
    const byBase = new Map(join.pairs.map((p) => [p.base.file, p.head.file]));
    expect(byBase.get('a.ts')).toBe('y.ts');
    expect(byBase.get('b.ts')).toBe('x.ts');
    expect(join.removed).toEqual([]);
    expect(join.added).toEqual([]);
  });

  it('a rename is an honest remove + add', () => {
    const join = pairModels(
      set(entity('User', 'a.ts', fields)),
      set(entity('Person', 'a.ts', fields)),
    );
    expect(join.pairs).toEqual([]);
    expect(join.removed.map((e) => e.name)).toEqual(['User']);
    expect(join.added.map((e) => e.name)).toEqual(['Person']);
  });
});

describe('diffModelSets — taxonomy and unknown rules', () => {
  const base = set(
    entity('User', 'm.ts', [
      { name: 'id', type: 'int', required: true },
      { name: 'email', type: 'string', required: false },
      { name: 'bio', type: 'string', required: true },
      { name: 'blob', type: null, required: null },
    ]),
  );

  it('classifies every change with the right class and confidence', () => {
    const head = set(
      entity('User', 'm.ts', [
        { name: 'id', type: 'string', required: true }, // type-changed
        { name: 'email', type: 'string', required: true }, // required-added
        // bio removed
        { name: 'blob', type: 'bytes', required: null }, // unknown → known: low conf
        { name: 'nick', type: 'string', required: false }, // added optional
        { name: 'org', type: 'string', required: true }, // added required
      ]),
      entity('Audit', 'a.ts', [{ name: 'at', type: 'time', required: true }]),
    );
    const drifts = diffModelSets(base, head);
    const byKey = new Map(drifts.map((d) => [`${d.changeClass}:${d.field ?? d.model}`, d]));

    expect(byKey.get('field-type-changed:id')?.confidence).toBe(1);
    expect(byKey.get('field-required-added:email')?.confidence).toBe(1);
    expect(byKey.get('field-removed:bio')?.from).toBe('string');
    expect(byKey.get('field-type-changed:blob')?.confidence).toBeLessThan(1); // unknown never blocks
    expect(byKey.get('field-added:nick')).toBeDefined();
    expect(byKey.get('field-added-required:org')).toBeDefined();
    expect(byKey.get('model-added:Audit')).toBeDefined();
    expect(drifts).toHaveLength(7);
  });

  it('a pure file move produces ZERO findings', () => {
    const moved = set(entity('User', 'relocated/models.ts', [...base.models[0].fields]));
    expect(diffModelSets(base, moved)).toEqual([]);
  });

  it('model removal blocks-shaped; identical sets are silent', () => {
    expect(diffModelSets(base, set())).toEqual([
      expect.objectContaining({ changeClass: 'model-removed', model: 'User', confidence: 1 }),
    ]);
    expect(diffModelSets(base, base)).toEqual([]);
  });

  it('both-unknown comparisons emit nothing', () => {
    const a = set(entity('K', 'k.ts', [{ name: 'x', type: null, required: null }]));
    const b = set(entity('K', 'k.ts', [{ name: 'x', type: null, required: null }]));
    expect(diffModelSets(a, b)).toEqual([]);
  });
});
