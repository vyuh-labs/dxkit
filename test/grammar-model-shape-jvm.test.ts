/**
 * Java + Kotlin grammar MODEL-shape rows, verified against the bundled wasms.
 * Java: annotations under a `modifiers` child, repeated `declarator` fields
 * (`int a, b;`), record components as parameters, and NO grammar-level
 * optionality (null — the honest unknown; `@Column(nullable=…)` is a
 * framework fact). Kotlin (zero-field grammar): fields from TWO sources
 * (val/var constructor params + body properties), real `String?` optionality,
 * and use-site-target annotations returning the inner node.
 */

import { describe, it, expect } from 'vitest';
import { parseSource, walk, type Node } from '../src/ast/parse';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';

const java = modelShapeForGrammar('java')!;
const kotlin = modelShapeForGrammar('kotlin')!;

async function classNode(src: string, grammar: string, name: string): Promise<Node> {
  const tree = await parseSource(src, grammar);
  const shape = modelShapeForGrammar(grammar)!;
  let found: Node | null = null;
  walk(tree!.rootNode, (n) => {
    if (!found && shape.classNodes.includes(n.type) && shape.className(n) === name) found = n;
    return undefined;
  });
  expect(found, `class ${name}`).not.toBeNull();
  return found!;
}

const JAVA_ENTITY = `
import jakarta.persistence.*;

@Entity
@Table(name = "users")
public class User extends BaseEntity implements Auditable, Serializable {
  @Id
  private Long id;

  @Column(name = "user_name", nullable = false)
  private String name;

  private int a, b;

  private List<Tag> tags = loadDefaults();
}
`;

describe('java grammar model shape', () => {
  it('reads name, heritage (superclass + interfaces), and class annotations', async () => {
    const cls = await classNode(JAVA_ENTITY, 'java', 'User');
    expect(java.heritage(cls)).toEqual(['BaseEntity', 'Auditable', 'Serializable']);
    const decs = java.classDecorators(cls).map((d) => d.text);
    expect(decs.some((t) => t.includes('Entity'))).toBe(true);
    expect(decs.some((t) => t.includes('Table'))).toBe(true);
  });

  it('reads fields: multi-declarator names, types, null optionality, field annotations', async () => {
    const cls = await classNode(JAVA_ENTITY, 'java', 'User');
    const fields = java.fieldNodes(cls);
    const names = fields.flatMap((f) => java.fieldNames(f));
    expect(names).toEqual(['id', 'name', 'a', 'b', 'tags']);
    const byName = new Map(fields.map((f) => [java.fieldNames(f)[0], f]));
    expect(java.fieldTypeText(byName.get('id')!)).toBe('Long');
    expect(java.fieldTypeText(byName.get('tags')!)).toBe('List<Tag>');
    // Java has no grammar-level optionality marker — honest null, never a block.
    expect(java.fieldOptionalMarker(byName.get('name')!)).toBeNull();
    const nameAnns = java.fieldDecorators(byName.get('name')!).map((d) => d.text);
    expect(nameAnns.some((t) => t.includes('Column'))).toBe(true);
    // Initializer call is exposed for fieldCallees resolution.
    expect(java.fieldValueCall(byName.get('tags')!)).not.toBeNull();
  });

  it('reads record components as fields', async () => {
    const src = `public record Point(int x, int y) {}`;
    const rec = await classNode(src, 'java', 'Point');
    const fields = rec ? java.fieldNodes(rec) : [];
    expect(fields.flatMap((f) => java.fieldNames(f))).toEqual(['x', 'y']);
    expect(java.fieldTypeText(fields[0])).toBe('int');
  });
});

const KOTLIN_MODELS = `
@Serializable
data class User(
  val id: Int,
  val name: String?,
  var tags: List<String> = emptyList(),
  @field:Column(name = "wire_email") val email: String,
  notAProperty: Int,
) : BaseEntity(), Auditable {
  @Column(nullable = true)
  var inBody: String = ""

  val inferred = integer("id")
}

object Users : Table("users") {
  val id = integer("id")
}
`;

describe('kotlin grammar model shape (zero-field grammar)', () => {
  it('reads name, heritage (constructor + interface forms), class annotations', async () => {
    const cls = await classNode(KOTLIN_MODELS, 'kotlin', 'User');
    expect(kotlin.heritage(cls)).toEqual(['BaseEntity', 'Auditable']);
    expect(kotlin.classDecorators(cls).map((d) => d.text)).toEqual(['Serializable']);
  });

  it('collects fields from BOTH sources: val/var constructor params + body properties', async () => {
    const cls = await classNode(KOTLIN_MODELS, 'kotlin', 'User');
    const names = kotlin.fieldNodes(cls).flatMap((f) => kotlin.fieldNames(f));
    // `notAProperty` has no val/var binding → not a property, excluded.
    expect(names).toEqual(['id', 'name', 'tags', 'email', 'inBody', 'inferred']);
  });

  it('reads types and REAL grammar-level optionality (String? / String / inferred)', async () => {
    const cls = await classNode(KOTLIN_MODELS, 'kotlin', 'User');
    const fields = kotlin.fieldNodes(cls);
    const byName = new Map(fields.map((f) => [kotlin.fieldNames(f)[0], f]));
    expect(kotlin.fieldTypeText(byName.get('name')!)).toBe('String?');
    expect(kotlin.fieldOptionalMarker(byName.get('name')!)).toBe(true);
    expect(kotlin.fieldOptionalMarker(byName.get('id')!)).toBe(false);
    expect(kotlin.fieldTypeText(byName.get('tags')!)).toBe('List<String>');
    // Inferred type → null marker (honest unknown), initializer call exposed.
    expect(kotlin.fieldOptionalMarker(byName.get('inferred')!)).toBeNull();
    expect(kotlin.fieldValueCall(byName.get('inferred')!)).not.toBeNull();
  });

  it('use-site-target field annotations return the INNER node (no @field: prefix)', async () => {
    const cls = await classNode(KOTLIN_MODELS, 'kotlin', 'User');
    const fields = kotlin.fieldNodes(cls);
    const email = fields.find((f) => kotlin.fieldNames(f)[0] === 'email')!;
    const anns = kotlin.fieldDecorators(email).map((d) => d.text);
    expect(anns).toHaveLength(1);
    expect(anns[0].startsWith('Column')).toBe(true);
    expect(anns[0]).not.toContain('field:');
  });

  it('object declarations are model-bearing (Exposed-style heritage)', async () => {
    const obj = await classNode(KOTLIN_MODELS, 'kotlin', 'Users');
    expect(kotlin.heritage(obj)).toEqual(['Table']);
  });
});
