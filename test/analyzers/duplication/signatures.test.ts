/**
 * The AST-native function-signature extractor. Pins that dxkit reads the FULL
 * callee set per named function from its own tree-sitter AST — including the
 * framework/external calls graphify's intra-repo graph drops — across languages
 * (Rule 6: `functionNodes` + `resolveCall` are pack-declared), attributes nested
 * calls to the nearest enclosing named function, and excludes test files.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gatherFunctionSignatures } from '../../../src/analyzers/duplication/signatures';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-sigs-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const byName = (sigs: Awaited<ReturnType<typeof gatherFunctionSignatures>>, name: string) =>
  sigs.find((s) => s.name === name);

describe('gatherFunctionSignatures — AST callee extraction (TypeScript)', () => {
  it('captures the FULL callee set, framework calls included', async () => {
    const dir = repo({
      'src/route.ts': `
        import { auth } from "x";
        export async function GET() {
          const u = await auth();
          const data = await getDivisions(u);
          return NextResponse.json(data);
        }
      `,
    });
    const sigs = await gatherFunctionSignatures(dir);
    const get = byName(sigs, 'GET');
    expect(get).toBeDefined();
    // The framework calls (auth, json) AND the data call are all captured —
    // graphify would drop auth + json (external), collapsing the signal.
    expect([...get!.callees].sort()).toEqual(['auth', 'getDivisions', 'json']);
  });

  it('attributes nested-function calls to the nearest enclosing named function', async () => {
    const dir = repo({
      'src/outer.ts': `
        export function outer() {
          alpha();
          function inner() { beta(); gamma(); }
          inner();
        }
      `,
    });
    const sigs = await gatherFunctionSignatures(dir);
    // outer calls alpha + inner (not beta/gamma — those belong to inner).
    expect([...byName(sigs, 'outer')!.callees].sort()).toEqual(['alpha', 'inner']);
    expect([...byName(sigs, 'inner')!.callees].sort()).toEqual(['beta', 'gamma']);
  });

  it('extracts class methods by name', async () => {
    const dir = repo({
      'src/svc.ts': `
        class Svc {
          load() { fetchThing(); parseThing(); renderThing(); }
        }
      `,
    });
    const sigs = await gatherFunctionSignatures(dir);
    const load = byName(sigs, 'load');
    expect(load).toBeDefined();
    expect([...load!.callees].sort()).toEqual(['fetchThing', 'parseThing', 'renderThing']);
  });

  it('excludes test files by default', async () => {
    const dir = repo({
      'src/thing.test.ts': `export function shouldNotAppear() { a(); b(); c(); }`,
    });
    expect(await gatherFunctionSignatures(dir)).toHaveLength(0);
    // ...but is included when tests are not excluded.
    const withTests = await gatherFunctionSignatures(dir, { excludeTests: false });
    expect(byName(withTests, 'shouldNotAppear')).toBeDefined();
  });
});

describe('gatherFunctionSignatures — cross-language (Python)', () => {
  it('extracts Python function callees (pack-declared functionNodes)', async () => {
    const dir = repo({
      'app/handler.py': [
        'def handle():',
        '    require_user()',
        '    data = get_divisions()',
        '    return respond(data)',
      ].join('\n'),
    });
    const sigs = await gatherFunctionSignatures(dir);
    const handle = byName(sigs, 'handle');
    expect(handle).toBeDefined();
    expect([...handle!.callees].sort()).toEqual(['get_divisions', 'require_user', 'respond']);
  });
});
