/**
 * Integration tests for src/baseline/flow-gate-check.ts — the additive,
 * fail-open flow gate pass over a real ref-based comparison. Each test builds a
 * small monorepo git fixture (backend routes + frontend calls), commits a base
 * state, mutates the working tree, and asserts the gate's verdict against the
 * base ref. The pure net-new algorithm is covered by flow-gate.test.ts; here we
 * exercise the wiring — trigger-skip, ref gather, served-truth self-skip, mode
 * override, and fail-open.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateFlowGateForGuardrail } from '../../src/baseline/flow-gate-check';
import type { ResolvedMode } from '../../src/baseline/modes';
import { computeFlowBindingFingerprint } from '../../src/analyzers/tools/fingerprint';
import type { AllowlistFile } from '../../src/allowlist/file';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** A monorepo: backend serves GET /articles, frontend calls it. Committed on
 *  `main` as the base state. */
function makeFlowRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowgate-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, 'web'), { recursive: true });
  mkdirSync(join(dir, 'api'), { recursive: true });
  // A package.json makes the TypeScript pack detect as active — the surface
  // trigger checks active packs (Rule 6), and every real Node repo has one.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\n");
  writeFileSync(join(dir, 'api', 'ctrl.ts'), "class C { @get('/articles') a() {} }\n");
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

const refMode: ResolvedMode = {
  mode: 'ref-based',
  source: 'cli',
  explanation: 'test',
  ref: 'main',
};

describe('evaluateFlowGateForGuardrail — skip paths', () => {
  it('skips when mode is not ref-based (committed mode)', async () => {
    const dir = makeFlowRepo();
    try {
      const out = await evaluateFlowGateForGuardrail({
        cwd: dir,
        mode: { mode: 'committed-full', source: 'cli', explanation: 'test' },
      });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('not-ref-based');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when policy mode is off', async () => {
    const dir = makeFlowRepo();
    try {
      const out = await evaluateFlowGateForGuardrail({
        cwd: dir,
        mode: refMode,
        modeOverride: 'off',
      });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('off');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evaluateFlowGateForGuardrail — real ref-based gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFlowRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('blocks a net-new call to a non-served endpoint', async () => {
    // Working tree adds a NEW call to a route nobody serves.
    writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/dead');\n");
    const out = await evaluateFlowGateForGuardrail({ cwd: dir, mode: refMode });
    expect(out.ran).toBe(true);
    expect(out.blocks).toBe(true);
    expect(out.findings.map((f) => f.path)).toContain('/dead');
    const dead = out.findings.find((f) => f.path === '/dead')!;
    expect(dead.reason).toBe('no-route');
    expect(dead.verdict).toBe('block');
  });

  it('warn mode demotes a would-block breakage to a warning', async () => {
    writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/dead');\n");
    const out = await evaluateFlowGateForGuardrail({
      cwd: dir,
      mode: refMode,
      modeOverride: 'warn',
    });
    expect(out.ran).toBe(true);
    expect(out.blocks).toBe(false);
    expect(out.warns).toBe(true);
    expect(out.findings.every((f) => f.verdict === 'warn')).toBe(true);
  });

  it('passes clean when every call still resolves', async () => {
    // No change to the working tree — the one call still resolves.
    const out = await evaluateFlowGateForGuardrail({ cwd: dir, mode: refMode });
    expect(out.blocks).toBe(false);
    expect(out.findings).toEqual([]);
  });

  it('grandfathers a call that was already broken at base', async () => {
    // Commit a broken call as the base, then make an UNRELATED change at HEAD.
    writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/legacy');\n");
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'pre-existing break']);
    git(dir, ['tag', 'base2']);
    // HEAD: touch the file but keep the pre-existing broken call.
    writeFileSync(
      join(dir, 'web', 'List.tsx'),
      "axios.get('/articles');\naxios.get('/legacy');\n// edit\n",
    );
    const out = await evaluateFlowGateForGuardrail({
      cwd: dir,
      mode: { ...refMode, ref: 'base2' },
    });
    expect(out.findings).toEqual([]); // /legacy was broken before → not net-new
  });

  it('skips a diff that touches no flow surface (docs-only change)', async () => {
    writeFileSync(join(dir, 'README.md'), '# docs\n');
    const out = await evaluateFlowGateForGuardrail({ cwd: dir, mode: refMode });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('no-flow-surface-change');
  });
});

describe('evaluateFlowGateForGuardrail — allowlist suppression', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFlowRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function allowlistFor(method: string, routePath: string, file: string, over = {}): AllowlistFile {
    return {
      schemaVersion: 'dxkit-allowlist/v1',
      mode: 'full',
      identityScheme: 'v2',
      entries: [
        {
          fingerprint: computeFlowBindingFingerprint(method, routePath, file),
          kind: 'flow-binding',
          category: 'false-positive',
          addedAt: '2026-01-01',
          reason: 'served by a system dxkit cannot see',
          addedBy: 'test',
          ...over,
        },
      ],
    } as AllowlistFile;
  }

  it('an active allowlist entry waives a flow block (per-finding escape hatch)', async () => {
    writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/dead');\n");
    const out = await evaluateFlowGateForGuardrail({
      cwd: dir,
      mode: refMode,
      allowlist: allowlistFor('GET', '/dead', 'web/List.tsx'),
    });
    expect(out.ran).toBe(true);
    expect(out.blocks).toBe(false); // waived
    expect(out.findings).toEqual([]); // not counted
    expect(out.suppressed).toHaveLength(1);
    expect(out.suppressed[0]).toMatchObject({ category: 'false-positive' });
    expect(out.suppressed[0].finding.path).toBe('/dead');
  });

  it('an EXPIRED allowlist entry does not waive — the finding re-blocks', async () => {
    writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/dead');\n");
    const out = await evaluateFlowGateForGuardrail({
      cwd: dir,
      mode: refMode,
      now: new Date('2026-06-01'),
      allowlist: allowlistFor('GET', '/dead', 'web/List.tsx', {
        category: 'deferred',
        expiresAt: '2020-01-01', // long past
      }),
    });
    expect(out.blocks).toBe(true);
    expect(out.suppressed).toEqual([]);
    expect(out.findings.map((f) => f.path)).toContain('/dead');
  });

  it('an entry for a DIFFERENT binding does not waive this one', async () => {
    writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/dead');\n");
    const out = await evaluateFlowGateForGuardrail({
      cwd: dir,
      mode: refMode,
      allowlist: allowlistFor('GET', '/other', 'web/List.tsx'), // wrong path → different id
    });
    expect(out.blocks).toBe(true);
    expect(out.suppressed).toEqual([]);
  });
});

describe('evaluateFlowGateForGuardrail — served-truth self-skip', () => {
  it('skips when neither side has any served route (frontend-only, no snapshot)', async () => {
    // A repo that only makes calls and serves nothing — with no committed
    // served.json, there is no truth to gate against, so it must not false-block.
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowgate-fe-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'test']);
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fe', version: '0.0.0' }));
      writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\n");
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'base']);
      // HEAD adds another call — still no served side anywhere.
      writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\naxios.get('/more');\n");
      const out = await evaluateFlowGateForGuardrail({ cwd: dir, mode: refMode });
      expect(out.ran).toBe(false);
      expect(out.skipped).toBe('no-served-truth');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates a frontend against a committed counterpart served.json (cross-repo)', async () => {
    // A frontend repo serving nothing itself, but carrying the backend's
    // committed served.json snapshot. The gate must resolve calls against that
    // snapshot: a new call NOT in it blocks; a call that IS in it does not.
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-flowgate-xrepo-'));
    try {
      git(dir, ['init', '-q', '-b', 'main']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'test']);
      mkdirSync(join(dir, 'web'), { recursive: true });
      mkdirSync(join(dir, '.dxkit', 'flow'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fe', version: '0.0.0' }));
      writeFileSync(
        join(dir, '.dxkit', 'flow', 'served.json'),
        JSON.stringify({
          schemaVersion: 'dxkit-allowlist/v1',
          generatedAt: '',
          side: 'served',
          routes: [{ method: 'GET', path: '/articles', handler: null, via: 'spec' }],
        }),
      );
      writeFileSync(join(dir, 'web', 'List.tsx'), "axios.get('/articles');\n");
      git(dir, ['add', '.']);
      git(dir, ['commit', '-q', '-m', 'base']);
      // HEAD: keep the resolving call, add one the counterpart does NOT serve.
      writeFileSync(
        join(dir, 'web', 'List.tsx'),
        "axios.get('/articles');\naxios.get('/ghost');\n",
      );
      const out = await evaluateFlowGateForGuardrail({ cwd: dir, mode: refMode });
      expect(out.ran).toBe(true);
      expect(out.blocks).toBe(true);
      // /ghost blocks; /articles resolved against the snapshot and did not.
      expect(out.findings.map((f) => f.path)).toEqual(['/ghost']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
