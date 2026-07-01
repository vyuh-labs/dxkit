/** Tests for the flow-surface registry helpers in src/languages/index.ts —
 *  the pack-driven set of extensions that can carry flow, and the changed-files
 *  trigger that gates the ref-based flow gate. */

import { describe, it, expect } from 'vitest';
import { LANGUAGES, allFlowSourceExtensions, changedFilesTouchFlowSurface } from '../src/languages';

describe('allFlowSourceExtensions', () => {
  it('includes the TypeScript pack extensions (httpFlow + a grammar)', () => {
    const exts = allFlowSourceExtensions(LANGUAGES);
    expect(exts).toContain('.ts');
    expect(exts).toContain('.tsx');
    expect(exts).toContain('.js');
  });

  it('is empty for a pack set with no flow-capable pack', () => {
    expect(allFlowSourceExtensions([])).toEqual([]);
  });
});

describe('changedFilesTouchFlowSurface', () => {
  it('is true when a source file in a flow extension changed', () => {
    expect(changedFilesTouchFlowSurface(['web/List.tsx', 'README.md'], LANGUAGES)).toBe(true);
  });

  it('is false when only non-source files changed', () => {
    expect(
      changedFilesTouchFlowSurface(['README.md', 'docs/x.png', '.github/ci.yml'], LANGUAGES),
    ).toBe(false);
  });

  it('is true when a configured spec changed even with no source change', () => {
    expect(
      changedFilesTouchFlowSurface(['api/openapi.json'], LANGUAGES, ['api/openapi.json']),
    ).toBe(true);
  });

  it('normalizes backslash paths (Windows changed-file lists)', () => {
    expect(changedFilesTouchFlowSurface(['web\\src\\List.tsx'], LANGUAGES)).toBe(true);
  });

  it('is false (nothing to gate) when no flow-capable pack is active', () => {
    expect(changedFilesTouchFlowSurface(['web/List.tsx'], [])).toBe(false);
  });
});
