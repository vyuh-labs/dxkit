import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { python, extractPyImportsRaw, resolvePyImportRaw } from '../src/languages/python';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-py-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('python.detect', () => {
  it('detects via pyproject.toml', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname="x"\n');
    expect(python.detect(tmp)).toBe(true);
  });

  it('detects via setup.py', () => {
    fs.writeFileSync(path.join(tmp, 'setup.py'), 'from setuptools import setup\n');
    expect(python.detect(tmp)).toBe(true);
  });

  it('detects via requirements.txt', () => {
    fs.writeFileSync(path.join(tmp, 'requirements.txt'), 'flask\n');
    expect(python.detect(tmp)).toBe(true);
  });

  it('detects via .py file within depth 2', () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'app.py'), '');
    expect(python.detect(tmp)).toBe(true);
  });

  it('returns false for empty directory', () => {
    expect(python.detect(tmp)).toBe(false);
  });
});

describe('extractPyImportsRaw', () => {
  const run = extractPyImportsRaw;

  it('captures simple import', () => {
    expect(run('import os')).toEqual(['os']);
  });

  it('captures dotted import', () => {
    expect(run('import foo.bar')).toEqual(['foo.bar']);
  });

  it('captures `from X import Y`', () => {
    expect(run('from collections import OrderedDict')).toEqual(['collections']);
  });

  it('captures relative imports with dots', () => {
    expect(run('from .sibling import x\nfrom ..parent import y')).toEqual(['.sibling', '..parent']);
  });

  it('handles multi-name and aliased imports', () => {
    expect(run('import os, sys as system, json')).toEqual(['os', 'sys', 'json']);
  });

  it('ignores imports in comments', () => {
    expect(run('# import bogus\nimport real')).toEqual(['real']);
  });
});

describe('resolvePyImportRaw', () => {
  it('resolves package as X.py', () => {
    fs.writeFileSync(path.join(tmp, 'a.py'), '');
    fs.writeFileSync(path.join(tmp, 'b.py'), '');
    expect(resolvePyImportRaw('a.py', 'b', tmp)).toBe('b.py');
  });

  it('resolves package as X/__init__.py', () => {
    fs.writeFileSync(path.join(tmp, 'a.py'), '');
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.writeFileSync(path.join(tmp, 'pkg', '__init__.py'), '');
    expect(resolvePyImportRaw('a.py', 'pkg', tmp)).toBe('pkg/__init__.py');
  });

  it('resolves relative import with single dot', () => {
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.writeFileSync(path.join(tmp, 'pkg', 'a.py'), '');
    fs.writeFileSync(path.join(tmp, 'pkg', 'b.py'), '');
    expect(resolvePyImportRaw('pkg/a.py', '.b', tmp)).toBe('pkg/b.py');
  });

  it('returns null for unresolvable external package', () => {
    fs.writeFileSync(path.join(tmp, 'a.py'), '');
    expect(resolvePyImportRaw('a.py', 'requests', tmp)).toBeNull();
  });

  it('returns null for `from . import X` (ambiguous)', () => {
    fs.writeFileSync(path.join(tmp, 'a.py'), '');
    expect(resolvePyImportRaw('a.py', '.', tmp)).toBeNull();
  });
});

describe('python.mapLintSeverity', () => {
  const map = python.mapLintSeverity!;

  it('maps bandit (S) codes to critical', () => {
    expect(map('S105')).toBe('critical');
    expect(map('S608')).toBe('critical');
  });

  it('maps pyflakes (F) and bugbear (B) codes to high', () => {
    expect(map('F401')).toBe('high');
    expect(map('F841')).toBe('high');
    expect(map('B008')).toBe('high');
  });

  it('maps pycodestyle errors (E) and complexity (C) to medium', () => {
    expect(map('E501')).toBe('medium');
    expect(map('C901')).toBe('medium');
  });

  it('maps pycodestyle warnings (W) and other stylistic codes to low', () => {
    expect(map('W605')).toBe('low');
    expect(map('N801')).toBe('low');
    expect(map('D100')).toBe('low');
    expect(map('I001')).toBe('low');
  });

  it('maps unknown prefixes to low', () => {
    expect(map('XYZ123')).toBe('low');
    expect(map('')).toBe('low');
  });
});
