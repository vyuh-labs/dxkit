/**
 * Tests for src/analyzers/flow/setup.ts (detection + apply) and the
 * writeFlowPolicy writer in config.ts. Pure helpers are unit-tested directly;
 * detectFlowTopology runs against a small on-disk monorepo fixture (the same
 * shape the flow gate tests use).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hostPrefixOf,
  dominantHostPrefixes,
  servicesFromRoutes,
  detectFlowTopology,
  applyFlowSetup,
} from '../src/analyzers/flow/setup';
import { readFlowConfig, writeFlowPolicy } from '../src/analyzers/flow/config';
import { readWorkspace } from '../src/workspace';
import type { ClientCall } from '../src/analyzers/flow/extract';
import type { RouteEndpoint } from '../src/analyzers/flow/extract';

function call(rawUrl: string): ClientCall {
  return { method: 'GET', rawUrl, path: null, receiver: 'axios', file: 'web/x.ts', line: 1 };
}
function route(file: string): RouteEndpoint {
  return { method: 'GET', path: '/x', via: 'decorator', handler: null, file, line: 1 };
}

describe('hostPrefixOf', () => {
  it('extracts an absolute scheme://host prefix', () => {
    expect(hostPrefixOf('https://api.example.com/articles')).toBe('https://api.example.com');
    expect(hostPrefixOf('http://localhost:3000/x')).toBe('http://localhost:3000');
  });
  it('extracts a leading ${...} base-URL helper template', () => {
    expect(hostPrefixOf('${Config.lb4api()}/articles')).toBe('${Config.lb4api()}');
  });
  it('handles a template literal captured with its backticks', () => {
    // The extractor captures a template-literal URL with backticks intact.
    expect(hostPrefixOf('`${Config.api()}/articles`')).toBe('${Config.api()}');
    expect(hostPrefixOf('`https://api.example.com/x`')).toBe('https://api.example.com');
  });
  it('returns null for a relative URL (nothing to strip)', () => {
    expect(hostPrefixOf('/articles')).toBeNull();
    expect(hostPrefixOf('articles')).toBeNull();
  });
});

describe('dominantHostPrefixes', () => {
  it('ranks prefixes by frequency, most common first', () => {
    const calls = [
      call('${Config.api()}/a'),
      call('${Config.api()}/b'),
      call('https://ext.example.com/c'),
      call('/relative'),
    ];
    expect(dominantHostPrefixes(calls)).toEqual(['${Config.api()}', 'https://ext.example.com']);
  });
  it('is empty when every call is relative', () => {
    expect(dominantHostPrefixes([call('/a'), call('/b')])).toEqual([]);
  });
});

describe('servicesFromRoutes', () => {
  it('returns the distinct top-level dirs when routes span two or more', () => {
    expect(
      servicesFromRoutes([route('api/a.ts'), route('userserver/b.ts'), route('api/c.ts')]),
    ).toEqual(['api', 'userserver']);
  });
  it('returns [] when all routes live under one top-level dir (single service)', () => {
    expect(servicesFromRoutes([route('api/a.ts'), route('api/b.ts')])).toEqual([]);
  });
  it('ignores routes in files at the repo root', () => {
    expect(servicesFromRoutes([route('server.ts'), route('api/a.ts')])).toEqual([]);
  });
});

describe('writeFlowPolicy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-flowpolicy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes flow.mode and reads back through readFlowConfig', () => {
    expect(writeFlowPolicy(dir, { mode: 'warn' })).toBe(true);
    expect(readFlowConfig(dir).mode).toBe('warn');
  });

  it('preserves other policy sections (loop) when patching flow', () => {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit', 'policy.json'),
      JSON.stringify({ loop: { preset: 'security-only' } }),
    );
    writeFlowPolicy(dir, { mode: 'block' });
    const parsed = JSON.parse(readFileSync(join(dir, '.dxkit', 'policy.json'), 'utf8'));
    expect(parsed.loop.preset).toBe('security-only'); // preserved
    expect(parsed.flow.mode).toBe('block');
  });

  it('is idempotent — a no-op write returns false', () => {
    expect(writeFlowPolicy(dir, { mode: 'warn' })).toBe(true);
    expect(writeFlowPolicy(dir, { mode: 'warn' })).toBe(false);
  });

  it('leaves a malformed policy untouched (returns false)', () => {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'policy.json'), '{ broken');
    expect(writeFlowPolicy(dir, { mode: 'block' })).toBe(false);
    expect(readFileSync(join(dir, '.dxkit', 'policy.json'), 'utf8')).toBe('{ broken');
  });
});

describe('applyFlowSetup', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-flowapply-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes policy flow.mode + strip prefixes, no workspace when single-service', () => {
    const written = applyFlowSetup(dir, {
      mode: 'warn',
      stripUrlPrefixes: ['${Config.api()}'],
    });
    expect(written).toEqual(['.dxkit/policy.json']);
    const cfg = readFlowConfig(dir);
    expect(cfg.mode).toBe('warn');
    expect(cfg.stripUrlPrefixes).toEqual(['${Config.api()}']);
    expect(readWorkspace(dir)).toBeNull();
  });

  it('writes workspace.json when participants are named', () => {
    const written = applyFlowSetup(dir, {
      mode: 'block',
      stripUrlPrefixes: [],
      participants: [
        { name: 'api', path: 'api' },
        { name: 'userserver', path: 'userserver' },
      ],
    });
    expect(written).toContain('.dxkit/workspace.json');
    expect(readWorkspace(dir)?.participants.map((p) => p.name)).toEqual(['api', 'userserver']);
  });
});

describe('detectFlowTopology', () => {
  it('detects a monorepo (calls + routes) and suggests the strip prefix', async () => {
    // No git needed — detection reads the working tree directly.
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowdetect-'));
    try {
      mkdirSync(join(dir, 'web'), { recursive: true });
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\n");
      writeFileSync(join(dir, 'api', 'ctrl.ts'), "class C { @get('/articles') a() {} }\n");
      const d = await detectFlowTopology(dir);
      expect(d.topology).toBe('monorepo');
      expect(d.callCount).toBeGreaterThan(0);
      expect(d.routeCount).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'none' on a repo with no flow-capable pack (stays silent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flownone-'));
    try {
      // A bare text file — no package.json, no flow-capable pack active.
      writeFileSync(join(dir, 'README.md'), '# hi\n');
      const d = await detectFlowTopology(dir);
      expect(d.topology).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
