import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { detect } from '../src/detect';

const FIX = (name: string) => path.join(__dirname, 'fixtures', name);

describe('detect()', () => {
  describe('python fixture', () => {
    const stack = detect(FIX('python'));

    it('detects python', () => {
      expect(stack.languages.python).toBe(true);
    });

    it('does not falsely detect other languages', () => {
      expect(stack.languages.go).toBe(false);
      expect(stack.languages.node).toBe(false);
      expect(stack.languages.rust).toBe(false);
      expect(stack.languages.csharp).toBe(false);
      expect(stack.languages.nextjs).toBe(false);
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
      expect(stack.languages.node).toBe(true);
      expect(stack.languages.nextjs).toBe(false);
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

    it('detects nextjs and not generic node', () => {
      expect(stack.languages.nextjs).toBe(true);
      expect(stack.languages.node).toBe(false);
    });

    it('reports framework as nextjs', () => {
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

  describe('empty fixture', () => {
    const stack = detect(FIX('empty'));

    it('detects no languages', () => {
      expect(stack.languages.python).toBe(false);
      expect(stack.languages.go).toBe(false);
      expect(stack.languages.node).toBe(false);
      expect(stack.languages.nextjs).toBe(false);
      expect(stack.languages.rust).toBe(false);
      expect(stack.languages.csharp).toBe(false);
    });

    it('falls back to directory name as project name', () => {
      expect(stack.projectName).toBe('empty');
    });

    it('returns no test runner', () => {
      expect(stack.testRunner).toBeUndefined();
    });
  });
});
