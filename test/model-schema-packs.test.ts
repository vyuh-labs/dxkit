/**
 * The three v1 pack `modelSchema` declarations, pinned against realistic
 * framework source (the pack-descriptor layer; the grammar-agnostic engine
 * is pinned by model-schema-core.test.ts with synthetic descriptors).
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';
import { extractModelsFromTree } from '../src/analyzers/model-schema/extract';
import { getLanguage } from '../src/languages';
import type { ModelSet } from '../src/analyzers/model-schema/model';

async function extractWithPack(src: string, grammar: string, langId: string): Promise<ModelSet> {
  const descriptor = getLanguage(langId as never)!.modelSchema!;
  const tree = await parseSource(src, grammar);
  expect(tree, `parse ${grammar}`).not.toBeNull();
  return extractModelsFromTree(
    tree!.rootNode,
    descriptor,
    modelShapeForGrammar(grammar)!,
    grammarShape(grammar),
    'sample',
  );
}

describe('typescript pack modelSchema', () => {
  it('extracts a TypeORM entity; helper classes and interfaces stay invisible', async () => {
    const { models } = await extractWithPack(
      `
import { Entity, Column, BaseEntity } from 'typeorm';

@Entity()
export class User {
  @Column() email!: string;
  @Column({ nullable: true }) nick?: string;
  name: string | null;
}

export class ArticleService { cache: Map<string, string>; }
export interface PlainDto { id: number }
`,
      'typescript',
      'typescript',
    );
    expect(models.map((m) => m.name)).toEqual(['User']);
    expect(models[0].via).toBe('decorator');
    expect(models[0].fields).toEqual([
      { name: 'email', type: 'string', required: true },
      { name: 'nick', type: 'string', required: false },
      { name: 'name', type: 'string', required: false },
    ]);
  });

  it('recognizes active-record BaseEntity heritage', async () => {
    const { models } = await extractWithPack(
      `export class Post extends BaseEntity { title: string; }`,
      'typescript',
      'typescript',
    );
    expect(models.map((m) => m.name)).toEqual(['Post']);
    expect(models[0].via).toBe('base-class');
  });

  it('extracts a LoopBack @model; @property({required}) beats the TS annotation', async () => {
    const { models } = await extractWithPack(
      `
import { Entity, model, property } from '@loopback/repository';

@model()
export class AccessToken extends Entity {
  @property({ type: 'string', id: true, defaultFn: 'uuidv4', length: 36 })
  id: string;

  @property({ type: 'string', required: true, mssql: { dataType: 'nvarchar(max)' } })
  token: string;

  @property({ type: 'string' })
  created_at?: string;
}
`,
      'typescript',
      'typescript',
    );
    expect(models.map((m) => m.name)).toEqual(['AccessToken']);
    expect(models[0].via).toBe('decorator');
    // `required: true` is explicit → required. `id`/`created_at` carry no
    // optionality keyword, so each keeps the TS grammar's answer rather than
    // being fabricated required: `id: string` → required, `created_at?` → not.
    expect(models[0].fields).toEqual([
      expect.objectContaining({ name: 'id', type: 'string', required: true }),
      expect.objectContaining({ name: 'token', type: 'string', required: true }),
      expect.objectContaining({ name: 'created_at', type: 'string', required: false }),
    ]);
  });

  // `Entity` is deliberately absent from `modelBaseClasses`: heritage markers
  // match every TS repo (schemaSignals gate only the advisor), and a bare
  // `extends Entity` is common in unrelated code. Without `@model()` it must
  // stay invisible — this is the false-positive class the LoopBack support
  // must not open.
  it('a bare `extends Entity` with no @model() is NOT a model', async () => {
    const { models } = await extractWithPack(
      `export class Particle extends Entity { velocity: number; }`,
      'typescript',
      'typescript',
    );
    expect(models).toEqual([]);
  });
});

describe('python pack modelSchema', () => {
  it('extracts a Django model with aliased types and null= optionality', async () => {
    const { models } = await extractWithPack(
      `
class Article(models.Model):
    title = models.CharField(max_length=200)
    summary = models.TextField(null=True)
    views = models.PositiveIntegerField()
    author = models.ForeignKey(User, on_delete=models.CASCADE)

class NotAModel:
    x = 1
`,
      'python',
      'python',
    );
    expect(models.map((m) => m.name)).toEqual(['Article']);
    expect(models[0].fields).toEqual([
      { name: 'title', type: 'string', required: true },
      { name: 'summary', type: 'string', required: false },
      { name: 'views', type: 'int', required: true },
      { name: 'author', type: 'fk', required: true },
    ]);
  });

  it('weak Base heritage needs Column corroboration (the homonym-Base class)', async () => {
    // Real-repo validation: frameworks carry their own unrelated `Base`
    // classes (pricing/availability strategies). A bare `Base` heritage with
    // no ORM field constructor must NOT mint a model; with one, it must.
    const { models } = await extractWithPack(
      `
class Unavailable(Base):
    code = "unavailable"
    message = "n/a"

class OrderRow(Base):
    id = Column(Integer, primary_key=True)
`,
      'python',
      'python',
    );
    expect(models.map((m) => m.name)).toEqual(['OrderRow']);
  });

  it('extracts pydantic + SQLAlchemy + dataclass forms', async () => {
    const { models } = await extractWithPack(
      `
class Item(BaseModel):
    name: str
    price: float | None = None

class OrderRow(Base):
    id = Column(Integer, primary_key=True)
    note = mapped_column(String, nullable=True)

@dataclass
class Point:
    x: int
`,
      'python',
      'python',
    );
    expect(models.map((m) => m.name)).toEqual(['Item', 'OrderRow', 'Point']);
    const [item, order, point] = models;
    expect(item.fields).toEqual([
      { name: 'name', type: 'str', required: true },
      { name: 'price', type: 'float', required: false },
    ]);
    expect(order.fields).toEqual([
      { name: 'id', type: 'Integer', required: true },
      { name: 'note', type: 'String', required: false },
    ]);
    expect(point.via).toBe('decorator');
    expect(point.fields).toEqual([{ name: 'x', type: 'int', required: true }]);
  });
});

describe('go pack modelSchema', () => {
  it('extracts tagged structs with wire names; untagged structs invisible', async () => {
    const { models } = await extractWithPack(
      `
package models

type User struct {
	ID    uint    \`json:"id" gorm:"primaryKey"\`
	Email string  \`json:"email"\`
	Nick  *string \`json:"nick,omitempty"\`
}

type internalCache struct {
	entries map[string]string
}
`,
      'go',
      'go',
    );
    expect(models.map((m) => m.name)).toEqual(['User']);
    expect(models[0].via).toBe('struct-tag');
    expect(models[0].fields).toEqual([
      { name: 'id', type: 'uint', required: true },
      { name: 'email', type: 'string', required: true },
      { name: 'nick', type: 'string', required: false },
    ]);
  });
});
