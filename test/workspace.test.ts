/**
 * Unit tests for src/workspace.ts — the `.dxkit/workspace.json` participants
 * primitive: fail-open read, structural normalization, and round-trip write.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readWorkspace, writeWorkspace, normalizeWorkspace, workspacePath } from '../src/workspace';

describe('workspace.json primitive', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-workspace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when the file is absent (fail-open)', () => {
    expect(readWorkspace(dir)).toBeNull();
  });

  it('returns null on malformed JSON (fail-open, never throws)', () => {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(workspacePath(dir), '{ not json');
    expect(readWorkspace(dir)).toBeNull();
  });

  it('round-trips participants + externals through write/read', () => {
    writeWorkspace(dir, {
      participants: [
        { name: 'web', path: '../web-client' },
        { name: 'api', path: 'src', baseUrls: ['${Config.api()}'] },
      ],
      external: [{ name: 'authz', baseUrls: ['https://auth.example.com'], spec: 'authz.json' }],
    });
    expect(existsSync(workspacePath(dir))).toBe(true);
    const ws = readWorkspace(dir);
    expect(ws?.participants).toHaveLength(2);
    expect(ws?.participants[1]).toEqual({
      name: 'api',
      path: 'src',
      baseUrls: ['${Config.api()}'],
    });
    expect(ws?.external[0]).toEqual({
      name: 'authz',
      baseUrls: ['https://auth.example.com'],
      spec: 'authz.json',
    });
  });

  it('normalizes away malformed entries but keeps well-formed ones', () => {
    const ws = normalizeWorkspace({
      participants: [
        { name: 'ok', path: 'src' },
        { name: 'missing-path' }, // dropped
        { path: 'no-name' }, // dropped
        'not-an-object', // dropped
      ],
      external: [{ name: 'x' }, { spec: 'no-name.json' }],
    });
    expect(ws?.participants).toEqual([{ name: 'ok', path: 'src' }]);
    expect(ws?.external).toEqual([{ name: 'x' }]);
  });

  it('treats an empty (no participants, no externals) object as null', () => {
    expect(normalizeWorkspace({ participants: [], external: [] })).toBeNull();
    expect(normalizeWorkspace({})).toBeNull();
    expect(normalizeWorkspace(null)).toBeNull();
  });

  it('drops non-string baseUrls entries but keeps string ones', () => {
    const ws = normalizeWorkspace({
      participants: [{ name: 'p', path: 's', baseUrls: ['ok', 42, null, 'ok2'] }],
      external: [],
    });
    expect(ws?.participants[0].baseUrls).toEqual(['ok', 'ok2']);
  });
});
