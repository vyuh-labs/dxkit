import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  gatherTestFiles,
  gatherSourceFiles,
  matchTestsToSource,
} from '../src/analyzers/tests/gather';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-gtest-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmp, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('gatherTestFiles', () => {
  it('finds *.test.ts files', () => {
    writeFile(
      'test/a.test.ts',
      'import { describe, it } from "vitest";\ndescribe("a", () => { it("x", () => { expect(1).toBe(1); }); });',
    );
    const files = gatherTestFiles(tmp);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('test/a.test.ts');
    expect(files[0].status).toBe('active');
    expect(files[0].framework).toBe('vitest');
  });

  it('finds *.spec.ts files', () => {
    writeFile('src/foo.spec.ts', 'describe("foo", () => { it("works", () => {}); });');
    const files = gatherTestFiles(tmp);
    expect(files.length).toBe(1);
    expect(files[0].path).toContain('foo.spec.ts');
  });

  it('finds *_test.py files', () => {
    writeFile('tests/test_math.py', 'def test_add():\n  assert 1 + 1 == 2\n');
    const files = gatherTestFiles(tmp);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const pyTest = files.find((f) => f.path.includes('test_math'));
    expect(pyTest).toBeDefined();
    expect(pyTest!.framework).toBe('pytest');
  });

  it('finds Go test files', () => {
    writeFile('pkg/foo_test.go', 'package foo\nimport "testing"\nfunc TestFoo(t *testing.T) {}');
    const files = gatherTestFiles(tmp);
    const goTest = files.find((f) => f.path.includes('_test.go'));
    expect(goTest).toBeDefined();
    expect(goTest!.framework).toBe('go-test');
  });

  it('classifies commented-out tests', () => {
    writeFile('test/dead.test.ts', '// describe("old", () => {\n//   it("x", () => {});\n// });\n');
    const files = gatherTestFiles(tmp);
    expect(files.length).toBe(1);
    expect(files[0].status).toBe('commented-out');
  });

  it('classifies empty test files', () => {
    writeFile('test/empty.test.ts', '');
    const files = gatherTestFiles(tmp);
    expect(files.length).toBe(1);
    expect(files[0].status).toBe('empty');
  });

  it('returns empty for repos with no tests', () => {
    writeFile('src/app.ts', 'export const x = 1;');
    const files = gatherTestFiles(tmp);
    expect(files.length).toBe(0);
  });

  it('excludes node_modules', () => {
    writeFile('node_modules/pkg/test.test.ts', 'describe("x", () => {});');
    writeFile('test/real.test.ts', 'describe("x", () => { it("y", () => {}); });');
    const files = gatherTestFiles(tmp);
    expect(files.every((f) => !f.path.includes('node_modules'))).toBe(true);
  });
});

describe('gatherSourceFiles', () => {
  it('finds .ts source files excluding test files', () => {
    writeFile('src/app.ts', 'export const x = 1;\n'.repeat(10));
    writeFile('src/app.test.ts', 'test("x", () => {});');
    const files = gatherSourceFiles(tmp);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/app.ts');
  });

  it('classifies controllers as controller type', () => {
    writeFile('src/controllers/user.ts', 'export class UserController {}\n'.repeat(5));
    const files = gatherSourceFiles(tmp);
    const ctrl = files.find((f) => f.path.includes('controllers'));
    expect(ctrl).toBeDefined();
    expect(ctrl!.type).toBe('controller');
  });

  it('classifies auth-related files as critical risk', () => {
    writeFile('src/auth/jwt.ts', 'export function verify() {}\n'.repeat(5));
    const files = gatherSourceFiles(tmp);
    const auth = files.find((f) => f.path.includes('auth'));
    expect(auth).toBeDefined();
    expect(auth!.risk).toBe('critical');
  });

  it('excludes .d.ts files', () => {
    writeFile('src/types.d.ts', 'declare module "x";');
    writeFile('src/app.ts', 'export const x = 1;\n');
    const files = gatherSourceFiles(tmp);
    expect(files.every((f) => !f.path.endsWith('.d.ts'))).toBe(true);
  });

  it('finds .py source files', () => {
    writeFile('src/app.py', 'def main():\n  pass\n');
    const files = gatherSourceFiles(tmp);
    expect(files.some((f) => f.path.endsWith('.py'))).toBe(true);
  });
});

describe('matchTestsToSource', () => {
  it('matches test file to source by basename', () => {
    writeFile('src/user.ts', 'export class User {}\n'.repeat(5));
    writeFile('test/user.test.ts', 'describe("user", () => { it("x", () => {}); });');
    const tests = gatherTestFiles(tmp);
    const sources = gatherSourceFiles(tmp);
    matchTestsToSource(tests, sources);
    const user = sources.find((s) => s.path.includes('user'));
    expect(user?.hasMatchingTest).toBe(true);
  });

  it('does not match when names differ', () => {
    writeFile('src/database.ts', 'export const db = {};\n'.repeat(5));
    writeFile('test/user.test.ts', 'describe("user", () => { it("x", () => {}); });');
    const tests = gatherTestFiles(tmp);
    const sources = gatherSourceFiles(tmp);
    matchTestsToSource(tests, sources);
    const db = sources.find((s) => s.path.includes('database'));
    expect(db?.hasMatchingTest).toBe(false);
  });

  it('does not credit commented-out tests', () => {
    writeFile('src/foo.ts', 'export const x = 1;\n'.repeat(5));
    writeFile('test/foo.test.ts', '// describe("foo", () => {\n//   it("x", () => {});\n// });');
    const tests = gatherTestFiles(tmp);
    const sources = gatherSourceFiles(tmp);
    matchTestsToSource(tests, sources);
    expect(sources[0].hasMatchingTest).toBe(false);
  });
});
