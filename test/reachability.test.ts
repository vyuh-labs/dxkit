import { describe, it, expect } from 'vitest';
import {
  buildReachablePackageSet,
  markReachable,
  specifierToPackage,
} from '../src/analyzers/tools/reachability';
import type { DepVulnFinding, ImportsResult } from '../src/languages/capabilities/types';

describe('specifierToPackage', () => {
  it('returns null for relative paths', () => {
    expect(specifierToPackage('./foo')).toBeNull();
    expect(specifierToPackage('../bar/baz')).toBeNull();
  });

  it('returns null for absolute paths', () => {
    expect(specifierToPackage('/abs/path')).toBeNull();
  });

  it('returns null for URL/protocol specifiers', () => {
    expect(specifierToPackage('http://example.com/mod')).toBeNull();
    expect(specifierToPackage('file:///local.js')).toBeNull();
  });

  it('extracts scoped npm package name', () => {
    expect(specifierToPackage('@loopback/core')).toBe('@loopback/core');
    expect(specifierToPackage('@loopback/core/dist/bar')).toBe('@loopback/core');
  });

  it('returns null for malformed scoped specifier', () => {
    expect(specifierToPackage('@loopback')).toBeNull();
  });

  it('extracts bare npm package name', () => {
    expect(specifierToPackage('lodash')).toBe('lodash');
    expect(specifierToPackage('lodash/get')).toBe('lodash');
  });

  it('extracts Python top-level module from dotted specifier', () => {
    expect(specifierToPackage('foo.bar.baz')).toBe('foo');
    expect(specifierToPackage('requests')).toBe('requests');
  });

  it('extracts Go 3-segment module path', () => {
    expect(specifierToPackage('github.com/user/repo')).toBe('github.com/user/repo');
    expect(specifierToPackage('github.com/user/repo/subpkg')).toBe('github.com/user/repo');
    expect(specifierToPackage('golang.org/x/net/idna')).toBe('golang.org/x/net');
  });

  it('returns null for empty input', () => {
    expect(specifierToPackage('')).toBeNull();
  });
});

describe('buildReachablePackageSet', () => {
  function imports(specsByFile: Record<string, string[]>): ImportsResult {
    const extracted = new Map<string, ReadonlyArray<string>>();
    for (const [f, s] of Object.entries(specsByFile)) extracted.set(f, s);
    return {
      schemaVersion: 1,
      tool: 'test',
      sourceExtensions: ['.ts'],
      extracted,
      edges: new Map(),
    };
  }

  it('unions external packages across every file', () => {
    const result = buildReachablePackageSet(
      imports({
        'src/a.ts': ['axios', 'lodash/get', './util'],
        'src/b.ts': ['@loopback/core', 'foo.bar.baz'],
      }),
    );
    expect(result.has('axios')).toBe(true);
    expect(result.has('lodash')).toBe(true);
    expect(result.has('@loopback/core')).toBe(true);
    expect(result.has('foo')).toBe(true);
    expect(result.size).toBe(4); // relative path './util' not counted
  });

  it('returns empty set when all specs are relative', () => {
    const result = buildReachablePackageSet(
      imports({
        'src/a.ts': ['./foo', '../bar', '/abs'],
      }),
    );
    expect(result.size).toBe(0);
  });
});

describe('markReachable', () => {
  function finding(pkg: string): DepVulnFinding {
    return { id: 'CVE-1', package: pkg, tool: 'test', severity: 'high' };
  }

  it('sets reachable=true when package is in the set', () => {
    const fs: DepVulnFinding[] = [finding('axios'), finding('lodash'), finding('untouched')];
    markReachable(fs, new Set(['axios', 'lodash']));
    expect(fs[0].reachable).toBe(true);
    expect(fs[1].reachable).toBe(true);
    expect(fs[2].reachable).toBe(false);
  });
});
