import { describe, it, expect } from 'vitest';
import { basePackageEvidence } from '../src/analyzers/correctness/lockfile-evidence';

/**
 * #284 — the format-aware "which packages could this file have provided?"
 * evidence. The contract under test: KEYS (installed/declared names)
 * count, VALUES (peer metadata, ranges, prose) never do, and anything
 * unparseable or unmodeled returns null so the caller keeps the
 * conservative containment fallback.
 */

describe('basePackageEvidence — npm lockfiles', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { app: '1.0.0' } },
      'node_modules/@scope/installed': {
        version: '1.0.0',
        peerDependencies: { 'peer-only-pkg': '>=1' },
      },
      'node_modules/@scope/installed/node_modules/nested-pkg': { version: '2.0.0' },
    },
  });

  it('installed-tree keys count, nested entries included', () => {
    const set = basePackageEvidence('package-lock.json', lock)!;
    expect(set.has('@scope/installed')).toBe(true);
    expect(set.has('nested-pkg')).toBe(true);
  });

  it('peer metadata inside an entry does NOT count (the three class)', () => {
    const set = basePackageEvidence('package-lock.json', lock)!;
    expect(set.has('peer-only-pkg')).toBe(false);
  });

  it('v1 dependencies-tree keys count recursively', () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { outer: { version: '1.0.0', dependencies: { inner: { version: '2.0.0' } } } },
    });
    const set = basePackageEvidence('package-lock.json', v1)!;
    expect(set.has('outer')).toBe(true);
    expect(set.has('inner')).toBe(true);
  });

  it('unparseable JSON → null (containment fallback)', () => {
    expect(basePackageEvidence('package-lock.json', '{ nope')).toBeNull();
  });
});

describe('basePackageEvidence — yarn.lock', () => {
  it('classic entry headers, scoped + multi-key', () => {
    const yarn = [
      '# yarn lockfile v1',
      '',
      '"@scope/a@^1.0.0", "@scope/a@^1.1.0":',
      '  version "1.2.0"',
      '  dependencies:',
      '    mentioned-in-body "^3.0.0"',
      '',
      'plain-pkg@^2.0.0:',
      '  version "2.0.1"',
    ].join('\n');
    const set = basePackageEvidence('yarn.lock', yarn)!;
    expect(set.has('@scope/a')).toBe(true);
    expect(set.has('plain-pkg')).toBe(true);
    // Body lines are indented and never parsed as names.
    expect(set.has('mentioned-in-body')).toBe(false);
  });

  it('berry protocol keys', () => {
    const berry = ['"berry-pkg@npm:^1.0":', '  version: 1.0.0'].join('\n');
    expect(basePackageEvidence('yarn.lock', berry)!.has('berry-pkg')).toBe(true);
  });
});

describe('basePackageEvidence — pnpm-lock.yaml', () => {
  it('packages-section keys across dialects; other sections ignored', () => {
    const pnpm = [
      'lockfileVersion: 6.0',
      '',
      'importers:',
      '  .:',
      '    dependencies:',
      '      importer-mention: 1.0.0',
      '',
      'packages:',
      '  /old-style/1.0.0:',
      '    resolution: {}',
      '  /@scope/newer@2.0.0:',
      '    resolution: {}',
      "  'quoted-pkg@3.0.0':",
      '    resolution: {}',
    ].join('\n');
    const set = basePackageEvidence('pnpm-lock.yaml', pnpm)!;
    expect(set.has('old-style')).toBe(true);
    expect(set.has('@scope/newer')).toBe(true);
    expect(set.has('quoted-pkg')).toBe(true);
    expect(set.has('importer-mention')).toBe(false);
  });
});

describe('basePackageEvidence — package.json + unmodeled formats', () => {
  it('declared names across all four sections count (peers included: no lockfile beside a bare manifest means the install flags are unknowable, and counting keeps the block)', () => {
    const manifest = JSON.stringify({
      dependencies: { a: '1' },
      devDependencies: { b: '1' },
      optionalDependencies: { c: '1' },
      peerDependencies: { d: '1' },
    });
    const set = basePackageEvidence('package.json', manifest)!;
    for (const name of ['a', 'b', 'c', 'd']) expect(set.has(name)).toBe(true);
  });

  it('unmodeled formats → null (non-JS ecosystems keep containment byte-for-byte)', () => {
    expect(basePackageEvidence('Gemfile.lock', 'GEM\n  remote: x')).toBeNull();
    expect(basePackageEvidence('requirements.txt', 'flask==2.0')).toBeNull();
    expect(basePackageEvidence('go.sum', 'example.com/m v1.0.0 h1:x')).toBeNull();
  });
});
