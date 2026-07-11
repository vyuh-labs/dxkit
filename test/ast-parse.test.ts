import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSource,
  parseFile,
  grammarForExtension,
  walk,
  astEngineAvailable,
  resetAstCachesForTest,
  type Node,
} from '../src/ast/parse';

beforeEach(() => resetAstCachesForTest());

describe('AST engine', () => {
  it('loads the wasm engine in this environment', async () => {
    expect(await astEngineAvailable()).toBe(true);
  });

  it('parses TypeScript and walks the tree to find calls + decorators', async () => {
    const tree = await parseSource(
      "const x = axios.get('/articles/' + id); class C { @get('/users/{id}') f() {} }",
      'typescript',
    );
    expect(tree).not.toBeNull();
    let calls = 0;
    let decorators = 0;
    walk(tree!.rootNode, (n) => {
      if (n.type === 'call_expression') calls++;
      if (n.type === 'decorator') decorators++;
    });
    expect(calls).toBeGreaterThanOrEqual(2); // axios.get(...) and the @get(...) call
    expect(decorators).toBe(1);
  });

  it('exposes string-literal argument text (what flow extraction reads)', async () => {
    const tree = await parseSource("router.post('/login', handler);", 'typescript');
    const strings: string[] = [];
    walk(tree!.rootNode, (n: Node) => {
      if (n.type === 'string') strings.push(n.text);
    });
    expect(strings).toContain("'/login'");
  });

  it('parses a JSX/TSX construct with the tsx grammar', async () => {
    const tree = await parseSource('const E = () => <div onClick={f}>hi</div>;', 'tsx');
    expect(tree).not.toBeNull();
    let jsx = 0;
    walk(tree!.rootNode, (n) => {
      if (n.type.startsWith('jsx')) jsx++;
    });
    expect(jsx).toBeGreaterThan(0);
  });

  it('walk honors a false return to skip a subtree', async () => {
    const tree = await parseSource('function f() { g(); }', 'typescript');
    let visitedCall = false;
    walk(tree!.rootNode, (n) => {
      if (n.type === 'function_declaration') return false; // skip the body
      if (n.type === 'call_expression') visitedCall = true;
    });
    expect(visitedCall).toBe(false);
  });

  it('degrades gracefully (null) on an unknown grammar', async () => {
    expect(await parseSource('whatever', 'not-a-real-grammar')).toBeNull();
  });
});

describe('grammarForExtension (pack-driven resolution)', () => {
  it('resolves TS/JS extensions to the right grammar via the registry', () => {
    expect(grammarForExtension('.ts')).toEqual({ grammar: 'typescript', languageId: 'typescript' });
    expect(grammarForExtension('.tsx')).toEqual({ grammar: 'tsx', languageId: 'typescript' });
    expect(grammarForExtension('.js')?.grammar).toBe('javascript');
    expect(grammarForExtension('.JSX')?.grammar).toBe('javascript'); // case-insensitive
    // The python pack declares its grammar as of the M6 wave.
    expect(grammarForExtension('.py')).toEqual({ grammar: 'python', languageId: 'python' });
  });

  it('returns null for an extension no pack parses yet', () => {
    expect(grammarForExtension('.rb')).toBeNull(); // ruby pack: grammar lands in its M6 wave
    expect(grammarForExtension('.zzz')).toBeNull();
  });
});

describe('parseFile', () => {
  it('reads + parses a file, resolving grammar from its extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-ast-'));
    const file = join(dir, 'sample.ts');
    writeFileSync(file, "export const r = fetch('/health');");
    const parsed = await parseFile(file);
    expect(parsed).not.toBeNull();
    expect(parsed!.grammar).toBe('typescript');
    expect(parsed!.languageId).toBe('typescript');
    expect(parsed!.source).toContain('/health');
  });

  it('returns null for an unsupported extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-ast-'));
    const file = join(dir, 'data.zzz');
    writeFileSync(file, 'nothing');
    expect(await parseFile(file)).toBeNull();
  });
});
