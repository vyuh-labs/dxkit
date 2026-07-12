/**
 * Wave-3 model-schema engine features: positional wire names
 * (`wireNameFrom: 'firstArg'`), the C# partial-class merge at assembly,
 * EF Core type-reference promotion (`DbSet<T>` containers), and Rails
 * schema-file tables. Inline descriptors mirror the pack declarations;
 * the pack wiring itself is pinned by the fixture matrix.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';
import {
  extractModelsFromTree,
  extractSchemaFileTables,
} from '../src/analyzers/model-schema/extract';
import { mergePartialEntities } from '../src/analyzers/model-schema/model';
import { gatherModelSet } from '../src/analyzers/model-schema/gather';
import type { ModelSchemaSupport } from '../src/languages/types';

async function extractModels(src: string, grammar: string, descriptor: ModelSchemaSupport) {
  const tree = await parseSource(src, grammar);
  return extractModelsFromTree(
    tree!.rootNode,
    descriptor,
    modelShapeForGrammar(grammar)!,
    grammarShape(grammar),
    'test-file',
  );
}

describe('positional wire names (wireNameFrom: firstArg)', () => {
  it('C# [Column("user_name")] / [JsonPropertyName("created_at")] rename on the wire', async () => {
    const src = `
[Table("orders")]
public class Order {
    [Column("user_name")] public string UserName { get; set; }
    [JsonPropertyName("created_at")] public string? CreatedAt { get; set; }
    public int Id { get; set; }
}`;
    const { models } = await extractModels(src, 'c_sharp', {
      modelDecorators: ['Table'],
      fieldDecoratorSpecs: [{ names: ['Column', 'JsonPropertyName'], wireNameFrom: 'firstArg' }],
    });
    expect(models).toHaveLength(1);
    expect(models[0].fields.map((f) => f.name)).toEqual(['user_name', 'created_at', 'Id']);
    expect(models[0].fields[1].required).toBe(false); // string? — the grammar marker survives
  });

  it('kotlinx @SerialName("wire") — the positional form the keyword read could not see', async () => {
    const src = `
@Serializable
data class Article(
    @SerialName("created_at") val createdAt: String,
    val title: String,
)`;
    const { models } = await extractModels(src, 'kotlin', {
      modelDecorators: ['Serializable'],
      fieldDecoratorSpecs: [{ names: ['SerialName'], wireNameFrom: 'firstArg' }],
    });
    expect(models[0].fields.map((f) => f.name)).toEqual(['created_at', 'title']);
  });

  it('a marker [Column] without arguments changes nothing', async () => {
    const src = `
[Table("t")]
public class T { [Column] public string Plain { get; set; } }`;
    const { models } = await extractModels(src, 'c_sharp', {
      modelDecorators: ['Table'],
      fieldDecoratorSpecs: [{ names: ['Column'], wireNameFrom: 'firstArg' }],
    });
    expect(models[0].fields[0].name).toBe('Plain');
  });
});

describe('partial-class merge at assembly', () => {
  it('same-name all-partial entities merge with a field union', () => {
    const merged = mergePartialEntities([
      {
        name: 'Order',
        via: 'decorator',
        file: 'Order.cs',
        line: 1,
        partial: true,
        fields: [
          { name: 'Id', type: 'int', required: true },
          { name: 'Total', type: 'decimal', required: true },
        ],
      },
      {
        name: 'Order',
        via: 'decorator',
        file: 'Order.Designer.cs',
        line: 1,
        partial: true,
        fields: [
          { name: 'Id', type: 'int', required: true },
          { name: 'CreatedAt', type: 'DateTime', required: true },
        ],
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].fields.map((f) => f.name)).toEqual(['Id', 'Total', 'CreatedAt']);
    expect(merged[0].file).toBe('Order.cs');
  });

  it('a same-name group with a non-partial member is left untouched', () => {
    const models = [
      { name: 'X', via: 'decorator' as const, file: 'a.cs', line: 1, partial: true, fields: [] },
      { name: 'X', via: 'decorator' as const, file: 'b.cs', line: 1, fields: [] },
    ];
    expect(mergePartialEntities(models)).toHaveLength(2);
  });

  it('the extractor stamps the partial marker', async () => {
    const src = `[Table("orders")] public partial class Order { public int Id { get; set; } }`;
    const { models } = await extractModels(src, 'c_sharp', { modelDecorators: ['Table'] });
    expect(models[0].partial).toBe(true);
  });
});

describe('type-reference containers (EF Core DbSet<T>)', () => {
  const EF: ModelSchemaSupport = {
    modelDecorators: ['Table'],
    modelTypeRefContainers: {
      containerBaseClasses: ['DbContext'],
      propertyTypeWrappers: ['DbSet'],
    },
  };

  it('collects refs from the container and keeps unmarked classes as candidates', async () => {
    const src = `
public class ShopDb : DbContext {
    public DbSet<Order> Orders { get; set; }
    public DbSet<Customer> Customers { get; set; }
}
public class Order { public int Id { get; set; } }
public class Unreferenced { public int X { get; set; } }`;
    const result = await extractModels(src, 'c_sharp', EF);
    expect(result.typeRefs).toEqual(['Order', 'Customer']);
    expect(result.models).toHaveLength(0); // nothing directly marked
    const candidateNames = (result.candidates ?? []).map((c) => c.name);
    expect(candidateNames).toContain('Order');
    expect(candidateNames).toContain('Unreferenced');
  });

  it('gather promotes referenced candidates repo-wide (cross-file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-efcore-'));
    writeFileSync(
      join(dir, 'ShopDb.cs'),
      `public class ShopDb : DbContext { public DbSet<Order> Orders { get; set; } }`,
    );
    writeFileSync(
      join(dir, 'Order.cs'),
      `public class Order { public int Id { get; set; } public string? Note { get; set; } }`,
    );
    writeFileSync(join(dir, 'Helper.cs'), `public class Helper { public int N { get; set; } }`);
    const set = await gatherModelSet({ roots: [dir], relativeTo: dir });
    const order = set.models.find((m) => m.name === 'Order');
    expect(order).toBeDefined();
    expect(order!.via).toBe('type-ref');
    expect(order!.fields.map((f) => f.name)).toEqual(['Id', 'Note']);
    expect(set.models.find((m) => m.name === 'Helper')).toBeUndefined();
  });
});

describe('schema-file tables (Rails db/schema.rb)', () => {
  const SCHEMA_SRC = `
ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "users", force: :cascade do |t|
    t.string "email", null: false
    t.string "nickname"
    t.datetime "created_at", null: false
    t.index ["email"], name: "index_users_on_email", unique: true
  end

  create_table "articles" do |t|
    t.string "title", null: false
    t.text "body"
    t.timestamps
  end
end`;

  it('one entity per create_table; columns typed by the member method', async () => {
    const tree = await parseSource(SCHEMA_SRC, 'ruby');
    const models = extractSchemaFileTables(
      tree!.rootNode,
      { files: ['db/schema.rb'], tableCallees: ['create_table'], optionalityKeyword: 'null' },
      {},
      grammarShape('ruby')!,
      'db/schema.rb',
    );
    expect(models.map((m) => m.name)).toEqual(['users', 'articles']);
    const users = models[0];
    expect(users.via).toBe('schema-file');
    // t.index's first arg is an array, not a string — never a column.
    expect(users.fields.map((f) => f.name)).toEqual(['email', 'nickname', 'created_at']);
    expect(users.fields[0]).toEqual({ name: 'email', type: 'string', required: true });
    // Absent null: keyword → the framework default (nullable ⇒ optional).
    expect(users.fields[1]).toEqual({ name: 'nickname', type: 'string', required: false });
    expect(models[1].fields.map((f) => f.name)).toEqual(['title', 'body']);
  });

  it('gather mints table entities and demotes class markers while the file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-rails-'));
    mkdirSync(join(dir, 'db'));
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'db', 'schema.rb'), SCHEMA_SRC);
    writeFileSync(
      join(dir, 'app', 'user.rb'),
      `class User < ApplicationRecord\n  attr_accessor :transient_flag\nend\n`,
    );
    const set = await gatherModelSet({ roots: [dir], relativeTo: dir });
    // Table entities are the model source…
    expect(set.models.map((m) => m.name).sort()).toEqual(['articles', 'users']);
    // …and the marker class did NOT also mint a same-logical-model `User`.
    expect(set.models.find((m) => m.name === 'User')).toBeUndefined();
  });
});

describe('fluent-chain field constructors (Exposed — the kotlin backlog closure)', () => {
  it('walks receiver links to the chain head and reads .nullable() optionality', async () => {
    const src = `
object Users : Table("users") {
    val id = integer("id").autoIncrement()
    val name = varchar("name", 50)
    val bio = text("bio").nullable()
}
object Helper {
    val entries = mutableMapOf<Int, String>()
}`;
    const tree = await parseSource(src, 'kotlin');
    const { models } = extractModelsFromTree(
      tree!.rootNode,
      {
        weakModelBaseClasses: ['Table'],
        fieldCallees: [
          {
            names: ['integer', 'varchar', 'text'],
            typeFrom: 'callee',
            optionalityChainCallees: ['nullable'],
          },
        ],
      },
      modelShapeForGrammar('kotlin')!,
      grammarShape('kotlin'),
      'test-file',
    );
    // The weak Table marker is corroborated by the column constructors;
    // Helper has none and stays invisible.
    expect(models.map((m) => m.name)).toEqual(['Users']);
    const byName = Object.fromEntries(models[0].fields.map((f) => [f.name, f]));
    // Chain tails (.autoIncrement()) no longer defeat the constructor read.
    expect(byName['id']).toEqual({ name: 'id', type: 'integer', required: true });
    expect(byName['name']).toEqual({ name: 'name', type: 'varchar', required: true });
    // The .nullable() link marks the field optional.
    expect(byName['bio']).toEqual({ name: 'bio', type: 'text', required: false });
  });
});
