import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  python,
  extractPyImportsRaw,
  resolvePyImportRaw,
  findPyProjectVenvPython,
} from '../src/languages/python';

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

  it('detects via .py file count above threshold (no manifest)', () => {
    // python.detect falls through to hasPyFile() when no manifest is
    // present. The threshold is >=3 .py files — one stray .py is
    // ambient noise (build-output artifacts on polyglot repos), not
    // signal that the project is Python. Three suggests an actual
    // Python source tree even without a pyproject.toml/setup.py/...
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'app.py'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'helpers.py'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'models.py'), '');
    expect(python.detect(tmp)).toBe(true);
  });

  it('does NOT detect on a single stray .py file (polyglot guard)', () => {
    // One .py in a non-Python project (typical pattern: a stray
    // build-output artifact in a C#/Java/etc. repo) must not activate
    // the python pack. Otherwise dominantVocabulary may pick python's
    // words for prose on a stack written in a different language.
    fs.mkdirSync(path.join(tmp, 'StagingArea'));
    fs.writeFileSync(path.join(tmp, 'StagingArea', 'stray.py'), '');
    expect(python.detect(tmp)).toBe(false);
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

describe('findPyProjectVenvPython', () => {
  function writePythonBin(root: string, name = 'python'): string {
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, name);
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    return exe;
  }

  afterEach(() => {
    delete process.env.VIRTUAL_ENV;
  });

  it('returns null when no venv is present', () => {
    expect(findPyProjectVenvPython(tmp)).toBe(null);
  });

  it('prefers ./.venv over ./venv (detection order)', () => {
    const venv = writePythonBin(path.join(tmp, 'venv'));
    const dotVenv = writePythonBin(path.join(tmp, '.venv'));
    const found = findPyProjectVenvPython(tmp);
    expect(found).toBe(dotVenv);
    expect(found).not.toBe(venv);
  });

  it('falls back to ./venv when ./.venv is absent', () => {
    const venv = writePythonBin(path.join(tmp, 'venv'));
    expect(findPyProjectVenvPython(tmp)).toBe(venv);
  });

  it('accepts python3 when python is absent', () => {
    const venv = writePythonBin(path.join(tmp, '.venv'), 'python3');
    expect(findPyProjectVenvPython(tmp)).toBe(venv);
  });

  it('falls back to $VIRTUAL_ENV when no local venv is present', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-py-ext-'));
    try {
      const exe = writePythonBin(external);
      process.env.VIRTUAL_ENV = external;
      expect(findPyProjectVenvPython(tmp)).toBe(exe);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('prioritizes ./.venv over $VIRTUAL_ENV (in-project wins)', () => {
    const dotVenvExe = writePythonBin(path.join(tmp, '.venv'));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-py-ext-'));
    try {
      writePythonBin(external);
      process.env.VIRTUAL_ENV = external;
      expect(findPyProjectVenvPython(tmp)).toBe(dotVenvExe);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

describe('python.correctness', () => {
  /** Write a fake `.venv/bin/<name>` executable so the resolver + pytest gate
   *  see a project interpreter with pytest installed. */
  function installVenvBin(name: string): string {
    const binDir = path.join(tmp, '.venv', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, name);
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    return exe;
  }
  const ctx = (over: Partial<{ changedFiles: string[]; scope: 'affected' | 'full' }> = {}) => ({
    cwd: tmp,
    changedFiles: over.changedFiles ?? ['app.py'],
    scope: over.scope ?? ('affected' as const),
  });

  it('syntaxCheck: py_compile on the changed .py files via the venv python', () => {
    const py = installVenvBin('python');
    const cmd = python.correctness!.syntaxCheck(ctx({ changedFiles: ['app.py', 'README.md'] }));
    expect(cmd).toEqual({ label: 'syntax', bin: py, args: ['-m', 'py_compile', 'app.py'] });
  });

  it('syntaxCheck: null when no .py changed (pytest import is the full-scope backstop)', () => {
    installVenvBin('python');
    expect(python.correctness!.syntaxCheck(ctx({ changedFiles: ['README.md'] }))).toBeNull();
  });

  it('affectedTests: null when the project has no pytest signal', () => {
    installVenvBin('python');
    installVenvBin('pytest');
    // No pytest.ini / conftest.py / [tool.pytest] → not a pytest project.
    expect(python.correctness!.affectedTests(ctx())).toBeNull();
  });

  it('affectedTests: runs the changed test modules on the affected surface', () => {
    fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]\n');
    const py = installVenvBin('python');
    installVenvBin('pytest');
    const cmd = python.correctness!.affectedTests(
      ctx({ changedFiles: ['src/app.py', 'tests/test_app.py'] }),
    );
    expect(cmd).toEqual({
      label: 'affected-tests',
      bin: py,
      args: ['-m', 'pytest', 'tests/test_app.py'],
    });
  });

  it('affectedTests: null on the affected surface when no test module changed', () => {
    fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]\n');
    installVenvBin('python');
    installVenvBin('pytest');
    expect(python.correctness!.affectedTests(ctx({ changedFiles: ['src/app.py'] }))).toBeNull();
  });

  it('affectedTests: whole suite at full scope', () => {
    fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]\n');
    const py = installVenvBin('python');
    installVenvBin('pytest');
    const cmd = python.correctness!.affectedTests(ctx({ scope: 'full' }));
    expect(cmd).toEqual({ label: 'affected-tests', bin: py, args: ['-m', 'pytest'] });
  });

  it('affectedTests: null (fail-open) when pytest is not installed in the env', () => {
    fs.writeFileSync(path.join(tmp, 'pytest.ini'), '[pytest]\n');
    installVenvBin('python'); // python present, but NO pytest sibling
    expect(python.correctness!.affectedTests(ctx({ scope: 'full' }))).toBeNull();
  });
});
