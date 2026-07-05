/**
 * The per-file disposition update uses to decide write-vs-preserve (#10 / #11).
 * Mirrors uninstall's provenance model: refresh dxkit-owned unmodified files,
 * never clobber user-owned ones even under --force.
 */
import { describe, it, expect } from 'vitest';
import { decideUpdateDisposition } from '../src/update-disposition';
import type { ManifestFileEntry } from '../src/types';

const dxkitOwned = (hash: string): ManifestFileEntry => ({
  hash,
  evolving: false,
  provenance: 'created',
});
const userOwned = (): ManifestFileEntry => ({ hash: null, evolving: false, provenance: 'skipped' });

const HASH = 'a'.repeat(64);

describe('decideUpdateDisposition', () => {
  it('absent on disk → write (re)create it', () => {
    expect(
      decideUpdateDisposition({
        exists: false,
        evolving: false,
        priorEntry: undefined,
        onDiskHash: () => HASH,
        force: false,
      }),
    ).toBe('write');
  });

  it('evolving file that exists → skip, never overwritten', () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: true,
        priorEntry: dxkitOwned(HASH),
        onDiskHash: () => HASH,
        force: true,
      }),
    ).toBe('skip');
  });

  it('existing + untracked (no prior entry) → skip, the user owns it', () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: undefined,
        onDiskHash: () => 'x',
        force: true, // even with --force
      }),
    ).toBe('skip');
  });

  it("provenance 'skipped' (user owned it at install) → skip even with --force (the #11 fix)", () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: userOwned(),
        onDiskHash: () => 'anything',
        force: true,
      }),
    ).toBe('skip');
  });

  it('dxkit-owned + on-disk UNMODIFIED → write (refresh delivers shipped fixes — the #10 fix)', () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: dxkitOwned(HASH),
        onDiskHash: () => HASH, // matches what dxkit last wrote
        force: false, // no --force needed
      }),
    ).toBe('write');
  });

  it('dxkit-owned + user EDITED it → skip without --force', () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: dxkitOwned(HASH),
        onDiskHash: () => 'user-edited-different-hash',
        force: false,
      }),
    ).toBe('skip');
  });

  it('dxkit-owned + user EDITED it + --force → write (re-apply the template)', () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: dxkitOwned(HASH),
        onDiskHash: () => 'user-edited-different-hash',
        force: true,
      }),
    ).toBe('write');
  });

  it('user-merge target (settings.json/CLAUDE.md/AGENTS.md) + user EDITED → skip even with --force', () => {
    // A full template overwrite always destroys the user's additions, so these
    // are preserved under --force once edited (a Stop hook in settings.json).
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: dxkitOwned(HASH),
        onDiskHash: () => 'user-added-their-own-hook',
        force: true,
        userMergeTarget: true,
      }),
    ).toBe('skip');
  });

  it('user-merge target that is UNMODIFIED still refreshes', () => {
    expect(
      decideUpdateDisposition({
        exists: true,
        evolving: false,
        priorEntry: dxkitOwned(HASH),
        onDiskHash: () => HASH,
        force: false,
        userMergeTarget: true,
      }),
    ).toBe('write');
  });
});
