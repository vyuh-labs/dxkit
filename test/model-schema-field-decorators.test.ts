/**
 * fieldDecoratorSpecs (SDK 0.2.0) — annotation-carried field facts through
 * the ONE model extractor: JPA `@Column(nullable = …, name = …)` supplies
 * explicit optionality and wire naming on java AND kotlin (constructor-param
 * fields, use-site targets), with synthetic descriptors. Absent keywords
 * change nothing — an unannotated java field keeps the honest null.
 */

import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/ast/parse';
import { grammarShape } from '../src/ast/grammar-shape';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';
import { extractModelsFromTree } from '../src/analyzers/model-schema/extract';
import type { ModelSchemaSupport } from '../src/languages/types';

const JPA: ModelSchemaSupport = {
  modelDecorators: ['Entity', 'Table', 'Embeddable', 'MappedSuperclass'],
  defaultFieldOptionality: 'unknown', // JPA columns default nullable; Java's grammar can't tell
  fieldDecoratorSpecs: [
    {
      names: ['Column', 'JoinColumn'],
      optionalityKeyword: 'nullable',
      optionalityPolarity: 'nullable',
      wireNameKeyword: 'name',
    },
  ],
};

async function models(src: string, grammar: 'java' | 'kotlin') {
  const tree = await parseSource(src, grammar);
  return extractModelsFromTree(
    tree!.rootNode,
    JPA,
    modelShapeForGrammar(grammar)!,
    grammarShape(grammar),
    `m.${grammar}`,
  );
}

describe('fieldDecoratorSpecs — java (JPA)', () => {
  it('explicit nullable + wire name are read; unannotated fields stay honest null', async () => {
    const set = await models(
      `@Entity
       public class User {
         @Column(name = "user_name", nullable = false) private String name;
         @Column(nullable = true) private String bio;
         private Long plain;
       }`,
      'java',
    );
    expect(set.models).toHaveLength(1);
    const byName = new Map(set.models[0].fields.map((f) => [f.name, f]));
    // wire name replaces the declared name
    expect(byName.has('user_name')).toBe(true);
    expect(byName.has('name')).toBe(false);
    expect(byName.get('user_name')?.required).toBe(true);
    expect(byName.get('bio')?.required).toBe(false);
    // No optionality signal at all → null (defaultFieldOptionality: 'unknown'
    // — stamping required would fabricate a JPA fact and let the gate block).
    expect(byName.get('plain')?.required).toBeNull();
  });

  it('an @Column WITHOUT the keyword changes nothing (absent ≠ default)', async () => {
    const set = await models(
      `@Entity public class T { @Column(name = "w") private String x; }`,
      'java',
    );
    expect(set.models[0].fields[0]).toMatchObject({ name: 'w', required: null });
  });
});

describe('fieldDecoratorSpecs — kotlin (constructor params + use-site targets)', () => {
  it('explicit nullable=false overrides the grammar marker; String? still reads without it', async () => {
    const set = await models(
      `@Entity
       class User(
         @field:Column(nullable = false) val name: String?,
         @Column(name = "wire_bio") val bio: String?,
         val plain: String,
       )`,
      'kotlin',
    );
    const byName = new Map(set.models[0].fields.map((f) => [f.name, f]));
    // Explicit descriptor optionality outranks the grammar's String? marker.
    expect(byName.get('name')?.required).toBe(true);
    // Wire name + marker-derived optionality coexist (String? → not required).
    expect(byName.get('wire_bio')?.required).toBe(false);
    expect(byName.has('bio')).toBe(false);
    // No annotation → the grammar marker answers (String → required).
    expect(byName.get('plain')?.required).toBe(true);
  });
});
