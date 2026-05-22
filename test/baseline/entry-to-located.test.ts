import { describe, it, expect } from 'vitest';
import { entriesToLocated, entryToLocated } from '../../src/baseline/entry-to-located';
import type { BaselineEntry } from '../../src/baseline/types';

/**
 * The converter is a pure dispatch — each kind has at most a few
 * lines. Test goals: confirm locator fields land for kinds the
 * matcher's location-pair / content-hash passes consume, and confirm
 * content-independent kinds fall through to identity-only.
 */
describe('entryToLocated', () => {
  it('populates file + canonical rule + line + contentHash for secrets', () => {
    const entry: BaselineEntry = {
      id: 'abc',
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'private-key',
      file: 'src/keys.ts',
      line: 42,
      contentHash: 'deadbeefdeadbeef',
    };
    expect(entryToLocated(entry)).toEqual({
      id: 'abc',
      file: 'src/keys.ts',
      line: 42,
      rule: 'canonical:private-key-on-disk', // canonical-rule mapping kicks in
      contentHash: 'deadbeefdeadbeef',
    });
  });

  it('omits contentHash when the entry has none', () => {
    const entry: BaselineEntry = {
      id: 'abc',
      kind: 'code',
      tool: 'semgrep',
      rule: 'eval-use',
      file: 'src/a.ts',
      line: 12,
    };
    const out = entryToLocated(entry);
    expect(out.contentHash).toBeUndefined();
    expect(out.rule).toBe('raw:semgrep:eval-use'); // unmapped → raw passthrough
  });

  it('uses the marker as the rule discriminator for hygiene', () => {
    const entry: BaselineEntry = {
      id: 'h1',
      kind: 'hygiene',
      file: 'src/a.ts',
      line: 100,
      marker: 'todo',
    };
    expect(entryToLocated(entry)).toEqual({
      id: 'h1',
      file: 'src/a.ts',
      line: 100,
      rule: 'todo',
    });
  });

  it('falls through to identity-only for content-independent kinds', () => {
    const cases: BaselineEntry[] = [
      { id: 'd1', kind: 'dep-vuln', package: 'lodash', advisoryId: 'GHSA-x' },
      {
        id: 'd2',
        kind: 'duplication',
        fileA: 'a',
        fileB: 'b',
        lines: 10,
        startLineA: 1,
        startLineB: 1,
      },
      { id: 'd4', kind: 'test-gap', file: 'src/a.ts', risk: 'high' },
      { id: 'd5', kind: 'large-file', file: 'src/big.ts' },
      { id: 'd6', kind: 'stale-file', file: '.foo.swp', suffix: 'swp' },
      { id: 'd7', kind: 'secret-hmac', tool: 'gitleaks', rule: 'aws-token', hmac: 'h' },
    ];
    for (const entry of cases) {
      const out = entryToLocated(entry);
      expect(out.id).toBe(entry.id);
      expect(out.file).toBeUndefined();
      expect(out.line).toBeUndefined();
      expect(out.rule).toBeUndefined();
    }
  });

  it('entriesToLocated maps each element', () => {
    const entries: BaselineEntry[] = [
      { id: 'a', kind: 'large-file', file: 'foo.ts' },
      { id: 'b', kind: 'large-file', file: 'bar.ts' },
    ];
    expect(entriesToLocated(entries)).toHaveLength(2);
  });
});
