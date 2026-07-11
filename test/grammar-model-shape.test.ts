/**
 * Grammar MODEL-shape adapter — the per-grammar syntax layer for data-model
 * declarations (`src/ast/grammar-model-shape.ts`), sibling of the flow shape.
 *
 * These tests pin each row against REAL parses of the bundled wasm grammars:
 * class/struct recognition, heritage, decorator attachment (including the TS
 * export-statement hoist and the Python decorated_definition wrap), field
 * enumeration, type text, grammar-level optionality markers, Go struct tags
 * and multi-name declarations. Pack descriptors and drift semantics are
 * pinned elsewhere; this file pins the ADAPTER.
 */

import { describe, it, expect } from 'vitest';
import { parseSource, type Node } from '../src/ast/parse';
import { modelShapeForGrammar, modelShapedGrammars } from '../src/ast/grammar-model-shape';

const ts = modelShapeForGrammar('typescript')!;
const py = modelShapeForGrammar('python')!;
const go = modelShapeForGrammar('go')!;

async function classesOf(src: string, grammar: string): Promise<Node[]> {
  const shape = modelShapeForGrammar(grammar)!;
  const tree = await parseSource(src, grammar);
  expect(tree, `parse ${grammar}`).not.toBeNull();
  const out: Node[] = [];
  const visit = (node: Node) => {
    if (shape.classNodes.includes(node.type)) out.push(node);
    for (const c of node.namedChildren) if (c) visit(c);
  };
  visit(tree!.rootNode);
  return out;
}

describe('grammar model shape — registry', () => {
  it('has rows for the JS family, python, and go', () => {
    for (const g of ['typescript', 'tsx', 'javascript', 'python', 'go']) {
      expect(modelShapeForGrammar(g), g).not.toBeNull();
      expect(modelShapedGrammars()).toContain(g);
    }
  });

  it('returns null (never throws) for an unshaped grammar', () => {
    expect(modelShapeForGrammar('cobol')).toBeNull();
  });

  it('the JS family shares one shape object', () => {
    expect(modelShapeForGrammar('typescript')).toBe(modelShapeForGrammar('tsx'));
    expect(modelShapeForGrammar('typescript')).toBe(modelShapeForGrammar('javascript'));
  });
});

describe('grammar model shape — typescript', () => {
  const SRC = `
@Entity()
export class User extends BaseEntity {
  @Column({ nullable: true })
  email?: string;
  name: string | null = 'x';
  private secret: string;
  greet(): void {}
}

class Plain {
  id = 1;
}
`;

  it('reads name, heritage, and hoisted export decorators', async () => {
    const [user, plain] = await classesOf(SRC, 'typescript');
    expect(ts.className(user)).toBe('User');
    expect(ts.heritage(user)).toEqual(['BaseEntity']);
    const decorators = ts.classDecorators(user);
    expect(decorators).toHaveLength(1);
    expect(decorators[0].text).toBe('@Entity()');

    expect(ts.className(plain)).toBe('Plain');
    expect(ts.heritage(plain)).toEqual([]);
    expect(ts.classDecorators(plain)).toEqual([]);
  });

  it('enumerates fields (not methods) with names, types, markers, decorators', async () => {
    const [user] = await classesOf(SRC, 'typescript');
    const fields = ts.fieldNodes(user);
    expect(fields.map((f) => ts.fieldNames(f)).flat()).toEqual(['email', 'name', 'secret']);

    const [email, name, secret] = fields;
    expect(ts.fieldTypeText(email)).toBe('string');
    expect(ts.fieldOptionalMarker(email)).toBe(true);
    expect(ts.fieldDecorators(email).map((d) => d.text)).toEqual(['@Column({ nullable: true })']);

    expect(ts.fieldTypeText(name)).toBe('string | null');
    expect(ts.fieldOptionalMarker(name)).toBe(false);

    expect(ts.fieldTypeText(secret)).toBe('string');
  });

  it('reads a field-initializer call for fieldValueCall', async () => {
    const [k] = await classesOf(`class K { rel = relation('User'); plain = 3; }`, 'typescript');
    const [rel, plain] = ts.fieldNodes(k);
    expect(ts.fieldValueCall(rel)?.text).toBe(`relation('User')`);
    expect(ts.fieldValueCall(plain)).toBeNull();
  });

  it('plain JS: field_definition/property naming, untyped reads null', async () => {
    const js = modelShapeForGrammar('javascript')!;
    const [k] = await classesOf(`class K { a = 1; @Dec() b = relation(1) }`, 'javascript');
    const fields = js.fieldNodes(k);
    expect(fields.map((f) => js.fieldNames(f)).flat()).toEqual(['a', 'b']);
    const [a, b] = fields;
    expect(js.fieldTypeText(a)).toBeNull();
    // No annotation at all → the marker is honestly unknown (three-valued):
    // a fabricated `required` would let the drift diff block on it.
    expect(js.fieldOptionalMarker(a)).toBeNull();
    expect(js.fieldDecorators(b).map((d) => d.text)).toEqual(['@Dec()']);
    expect(js.fieldValueCall(b)?.text).toBe('relation(1)');
  });
});

describe('grammar model shape — python', () => {
  const SRC = `
@dataclass
class Point:
    x: int
    y: int = 0

class User(models.Model, Mixin, metaclass=Meta):
    email = models.CharField(max_length=255, null=True)

class Item(BaseModel):
    name: str
    def save(self):
        self.tmp = 1
`;

  it('reads name, superclasses (skipping keyword args), and wrap decorators', async () => {
    const [point, user, item] = await classesOf(SRC, 'python');
    expect(py.className(point)).toBe('Point');
    expect(py.classDecorators(point).map((d) => d.text)).toEqual(['@dataclass']);

    expect(py.className(user)).toBe('User');
    expect(py.heritage(user)).toEqual(['models.Model', 'Mixin']);
    expect(py.classDecorators(user)).toEqual([]);

    expect(py.heritage(item)).toEqual(['BaseModel']);
  });

  it('enumerates class-level assignments only (method bodies excluded)', async () => {
    const [point, user, item] = await classesOf(SRC, 'python');
    expect(
      py
        .fieldNodes(point)
        .map((f) => py.fieldNames(f))
        .flat(),
    ).toEqual(['x', 'y']);
    expect(
      py
        .fieldNodes(item)
        .map((f) => py.fieldNames(f))
        .flat(),
    ).toEqual(['name']);

    const [email] = py.fieldNodes(user);
    expect(py.fieldNames(email)).toEqual(['email']);
    expect(py.fieldTypeText(email)).toBeNull();
    expect(py.fieldValueCall(email)?.text).toContain('models.CharField');
    expect(py.fieldOptionalMarker(email)).toBeNull();
  });

  it('reads annotation type text verbatim (normalizer folds the forms)', async () => {
    const [k] = await classesOf(
      `class K(BaseModel):\n    a: Optional[int] = 3\n    b: float | None = None\n`,
      'python',
    );
    const [a, b] = py.fieldNodes(k);
    expect(py.fieldTypeText(a)).toBe('Optional[int]');
    expect(py.fieldTypeText(b)).toBe('float | None');
  });
});

describe('grammar model shape — go', () => {
  const SRC = `
package m

type User struct {
	Email *string \`json:"email,omitempty"\`
	X, Y  int
	inner helper
	Base
}

type Alias = User
type Num int
`;

  it('recognizes only struct-typed specs as model-bearing', async () => {
    const specs = await classesOf(SRC, 'go');
    const names = specs.map((s) => go.className(s));
    expect(names).toContain('User');
    // Alias and Num are type_specs/aliases but not struct-typed → null.
    expect(names.filter((n) => n !== null)).toEqual(['User']);
  });

  it('enumerates fields with multi-name splits, tags, pointer optionality', async () => {
    const specs = await classesOf(SRC, 'go');
    const user = specs.find((s) => go.className(s) === 'User')!;
    const fields = go.fieldNodes(user);

    const [email, xy, inner, embedded] = fields;
    expect(go.fieldNames(email)).toEqual(['Email']);
    expect(go.fieldTypeText(email)).toBe('*string');
    expect(go.fieldOptionalMarker(email)).toBe(true);
    expect(go.fieldTag(email)).toBe('`json:"email,omitempty"`');

    expect(go.fieldNames(xy)).toEqual(['X', 'Y']);
    expect(go.fieldTypeText(xy)).toBe('int');
    expect(go.fieldOptionalMarker(xy)).toBe(false);

    expect(go.fieldNames(inner)).toEqual(['inner']);
    // Embedded field: no declared name — caller skips it.
    expect(go.fieldNames(embedded)).toEqual([]);
  });

  it('heritage and decorators are empty (Go has neither)', async () => {
    const specs = await classesOf(SRC, 'go');
    const user = specs.find((s) => go.className(s) === 'User')!;
    expect(go.heritage(user)).toEqual([]);
    expect(go.classDecorators(user)).toEqual([]);
  });
});
