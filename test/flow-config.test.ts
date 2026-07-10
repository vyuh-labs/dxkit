/** Tests for src/analyzers/flow/config.ts — the single reader of the
 *  `.dxkit/policy.json:flow` section. Fail-open to conservative defaults. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFlowConfig } from '../src/analyzers/flow/config';

function repoWith(policy: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowcfg-'));
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(join(dir, '.dxkit', 'policy.json'), JSON.stringify(policy));
  return dir;
}

describe('readFlowConfig', () => {
  it('returns conservative defaults when no policy file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowcfg-none-'));
    try {
      const c = readFlowConfig(dir);
      expect(c).toEqual({
        stripUrlPrefixes: [],
        specs: [],
        mode: 'block',
        blockThreshold: 1,
        onMergeRefresh: false,
        refreshMode: 'pr',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes the refresh knobs: onMergeRefresh strict-true, refreshMode pr unless push', () => {
    for (const [raw, expected] of [
      [
        { onMergeRefresh: true, refreshMode: 'push' },
        { on: true, mode: 'push' },
      ],
      [
        { onMergeRefresh: 'yes', refreshMode: 'auto-merge' },
        { on: false, mode: 'pr' },
      ],
      [{}, { on: false, mode: 'pr' }],
    ] as const) {
      const dir = repoWith({ flow: raw });
      try {
        const c = readFlowConfig(dir);
        expect(c.onMergeRefresh).toBe(expected.on);
        expect(c.refreshMode).toBe(expected.mode);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('reads a full flow section', () => {
    const dir = repoWith({
      flow: {
        stripUrlPrefixes: ['https://api.example.com'],
        specs: ['openapi.json', 'v2.yaml'],
        mode: 'warn',
        blockThreshold: 0.5,
      },
    });
    try {
      expect(readFlowConfig(dir)).toEqual({
        stripUrlPrefixes: ['https://api.example.com'],
        specs: ['openapi.json', 'v2.yaml'],
        mode: 'warn',
        blockThreshold: 0.5,
        onMergeRefresh: false,
        refreshMode: 'pr',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back per-field on bad types (fail-open)', () => {
    const dir = repoWith({ flow: { mode: 'nonsense', blockThreshold: -3, specs: 'not-array' } });
    try {
      const c = readFlowConfig(dir);
      expect(c.mode).toBe('block'); // invalid mode → default
      expect(c.blockThreshold).toBe(1); // non-positive → default
      expect(c.specs).toEqual([]); // non-array → empty
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns defaults on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowcfg-bad-'));
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'policy.json'), '{ not json');
    try {
      expect(readFlowConfig(dir).mode).toBe('block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops non-string entries from string lists', () => {
    const dir = repoWith({ flow: { specs: ['ok.json', 3, null, 'also.yaml'] } });
    try {
      expect(readFlowConfig(dir).specs).toEqual(['ok.json', 'also.yaml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
