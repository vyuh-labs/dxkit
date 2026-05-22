import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as child_process from 'child_process';
import { clearVisibilityCache, detectRepoVisibility } from '../../src/baseline/visibility';

/**
 * Visibility probe tests — mock `execSync` and assert each branch
 * of `detectRepoVisibility`. `execSync` is the only I/O surface;
 * mocking it covers every failure path without needing a live `gh`.
 */

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execSync: vi.fn() };
});

const execSyncMock = vi.mocked(child_process.execSync);

beforeEach(() => {
  clearVisibilityCache();
  execSyncMock.mockReset();
});

describe('detectRepoVisibility', () => {
  it('returns "public" when gh reports visibility:public', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"public"}\n');
    expect(detectRepoVisibility('/repo')).toBe('public');
  });

  it('returns "private" when gh reports visibility:private', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"PRIVATE"}\n');
    expect(detectRepoVisibility('/repo')).toBe('private');
  });

  it('returns "internal" when gh reports visibility:internal (GHE middle tier)', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"internal"}\n');
    expect(detectRepoVisibility('/repo')).toBe('internal');
  });

  it('returns "unknown" when visibility field is missing', () => {
    execSyncMock.mockReturnValueOnce('{}\n');
    expect(detectRepoVisibility('/repo')).toBe('unknown');
  });

  it('returns "unknown" when visibility field has an unrecognized value', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"hidden"}\n');
    expect(detectRepoVisibility('/repo')).toBe('unknown');
  });

  it('returns "unknown" when gh exits non-zero', () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('gh: command not found');
    });
    expect(detectRepoVisibility('/repo')).toBe('unknown');
  });

  it('returns "unknown" when gh stdout is not valid JSON', () => {
    execSyncMock.mockReturnValueOnce('not-json\n');
    expect(detectRepoVisibility('/repo')).toBe('unknown');
  });

  it('caches results per-cwd', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"public"}\n');
    expect(detectRepoVisibility('/repo')).toBe('public');
    // Second probe at the same path must not call execSync again
    expect(detectRepoVisibility('/repo')).toBe('public');
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('separate cwds are cached independently', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"public"}\n');
    execSyncMock.mockReturnValueOnce('{"visibility":"private"}\n');
    expect(detectRepoVisibility('/repo-a')).toBe('public');
    expect(detectRepoVisibility('/repo-b')).toBe('private');
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it('clearVisibilityCache forces a re-probe', () => {
    execSyncMock.mockReturnValueOnce('{"visibility":"public"}\n');
    execSyncMock.mockReturnValueOnce('{"visibility":"private"}\n');
    expect(detectRepoVisibility('/repo')).toBe('public');
    clearVisibilityCache();
    expect(detectRepoVisibility('/repo')).toBe('private');
  });
});
