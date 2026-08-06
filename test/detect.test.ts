import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { detect, explainNoLanguages } from '../src/detect';

const FIX = (name: string) => path.join(__dirname, 'fixtures', name);

describe('detect()', () => {
  describe('python fixture', () => {
    const stack = detect(FIX('python'));

    it('detects python', () => {
      expect(stack.languages.python).toBe(true);
    });

    it('does not falsely detect other languages', () => {
      expect(stack.languages.go).toBe(false);
      expect(stack.languages.typescript).toBe(false);
      expect(stack.languages.rust).toBe(false);
      expect(stack.languages.csharp).toBe(false);
      // 10f.4: nextjs is now a framework signal, not a `languages` flag.
      expect(stack.framework).not.toBe('nextjs');
    });

    it('extracts python version from pyproject.toml requires-python', () => {
      expect(stack.versions.python).toBe('3.11');
    });

    it('reads project name from pyproject.toml', () => {
      expect(stack.projectName).toBe('fixture-py');
    });

    it('reads project description from pyproject.toml', () => {
      expect(stack.projectDescription).toBe('A python fixture for dxkit detect tests');
    });

    it('detects pytest as test runner', () => {
      expect(stack.testRunner?.framework).toBe('pytest');
    });
  });

  describe('node fixture', () => {
    const stack = detect(FIX('node'));

    it('detects node and not nextjs', () => {
      // 10f.4: typescript pack matches any package.json (Node OR Next.js).
      // The "is this Next.js?" distinction now lives in `framework`.
      expect(stack.languages.typescript).toBe(true);
      expect(stack.framework).not.toBe('nextjs');
    });

    it('extracts node major version from engines.node', () => {
      expect(stack.versions.node).toBe('20');
    });

    it('reads project name from package.json', () => {
      expect(stack.projectName).toBe('fixture-node');
    });

    it('detects vitest as test runner', () => {
      expect(stack.testRunner?.framework).toBe('vitest');
      expect(stack.testRunner?.command).toBe('npx vitest');
    });
  });

  describe('nextjs fixture', () => {
    const stack = detect(FIX('nextjs'));

    it('detects nextjs as typescript+framework signal', () => {
      // 10f.4: nextjs project activates the typescript pack (any
      // package.json) AND surfaces `framework: 'nextjs'`.
      expect(stack.languages.typescript).toBe(true);
      expect(stack.framework).toBe('nextjs');
    });
  });

  describe('go fixture', () => {
    const stack = detect(FIX('go'));

    it('detects go', () => {
      expect(stack.languages.go).toBe(true);
    });

    it('extracts go version from go.mod', () => {
      expect(stack.versions.go).toBe('1.22');
    });

    it('reads module name from go.mod', () => {
      expect(stack.projectName).toBe('fixture-go');
    });

    it('detects go-test as test runner', () => {
      expect(stack.testRunner?.framework).toBe('go-test');
    });
  });

  describe('node-exact fixture (^20)', () => {
    const stack = detect(FIX('node-exact'));

    it('extracts version 20 from exact pin ^20', () => {
      expect(stack.versions.node).toBe('20');
    });
  });

  describe('node-range fixture (>=10)', () => {
    const stack = detect(FIX('node-range'));

    it('prefers installed Node version over range minimum', () => {
      // >=10 is a range — should use installed version, not "10"
      const installedMajor = process.version.replace(/^v/, '').split('.')[0];
      expect(stack.versions.node).toBe(installedMajor);
    });

    it('does not return "10" for >=10 range', () => {
      expect(stack.versions.node).not.toBe('10');
    });
  });

  describe('empty fixture', () => {
    const stack = detect(FIX('empty'));

    it('detects no languages', () => {
      expect(stack.languages.python).toBe(false);
      expect(stack.languages.go).toBe(false);
      expect(stack.languages.typescript).toBe(false);
      expect(stack.languages.rust).toBe(false);
      expect(stack.languages.csharp).toBe(false);
      expect(stack.framework).not.toBe('nextjs');
    });

    it('falls back to directory name as project name', () => {
      expect(stack.projectName).toBe('empty');
    });

    it('returns no test runner', () => {
      expect(stack.testRunner).toBeUndefined();
    });
  });
});

describe('explainNoLanguages — two truths, two messages (the empty-branch class)', () => {
  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-nolang-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    return dir;
  }
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('an (almost) empty branch says so and points at other branches — never "unsupported"', () => {
    const dir = repo();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# scaffold');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], {
      cwd: dir,
    });
    execFileSync('git', ['branch', 'working'], { cwd: dir });
    execFileSync('git', ['branch', 'development'], { cwd: dir });
    const msg = explainNoLanguages(dir);
    expect(msg).toContain('no source on the checked-out branch');
    expect(msg).toContain("'main'");
    expect(msg).toContain('NOT a claim that your stack is unsupported');
    expect(msg).toContain('3 branches');
  });

  it('unsupported source names what was seen (checkable, not a shrug)', () => {
    const dir = repo();
    dirs.push(dir);
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(dir, `mod${i}.zig`), `const x = ${i};`);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], {
      cwd: dir,
    });
    const msg = explainNoLanguages(dir);
    expect(msg).toContain('no supported language among 15 files');
    expect(msg).toContain('.zig');
    expect(msg).toContain('language pack');
  });

  it('a non-git directory degrades to the generic message, never a throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-nolang-plain-'));
    dirs.push(dir);
    expect(explainNoLanguages(dir)).toContain('no languages detected');
  });
});
