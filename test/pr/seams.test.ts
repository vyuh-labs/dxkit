import { describe, it, expect } from 'vitest';
import { gatherPrSeams } from '../../src/pr/seams';

describe('gatherPrSeams', () => {
  it('short-circuits to no prompts when nothing changed (never touches the tree)', async () => {
    expect(await gatherPrSeams('/nonexistent', new Set())).toEqual([]);
  });

  it('fails open on an unreadable tree', async () => {
    // A path with changed files but no analyzable tree yields no prompts, never throws.
    expect(await gatherPrSeams('/nonexistent', new Set(['src/a.ts']))).toEqual([]);
  });
});
