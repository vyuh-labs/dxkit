/**
 * Integration tests for src/baseline/schema-drift-gate-check.ts — the
 * additive, fail-open drift-gate pass over a real ref-based comparison.
 * Fixtures use the SPEC bridge (policy `schema.specs` + a committed OpenAPI
 * document), which exercises the full wiring — opt-in gating, trigger-skip,
 * ref-worktree base gather, no-models self-skip, posture, allowlist, and
 * fail-open — with zero pack extraction, proving the language-independent
 * path end-to-end. Pack extraction is pinned by the extraction tests and the
 * pack-declaration wave.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { evaluateSchemaDriftGateForGuardrail } from '../../src/baseline/schema-drift-gate-check';
import { computeModelSchemaDriftFingerprint } from '../../src/analyzers/tools/fingerprint';
import type { AllowlistFile } from '../../src/allowlist/file';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function specDoc(userProps: Record<string, unknown>, required: string[]): string {
  return JSON.stringify({
    openapi: '3.0.0',
    components: {
      schemas: { User: { type: 'object', required, properties: userProps } },
    },
  });
}

const BASE_SPEC = specDoc(
  { id: { type: 'integer' }, email: { type: 'string' }, nick: { type: 'string' } },
  ['id', 'email'],
);

/** A repo whose models come from a committed OpenAPI spec, with the schema
 *  gate configured ON in block mode. Committed on `main` as the base. */
function makeSchemaRepo(mode: 'block' | 'warn' = 'block'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-schemagate-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(
    join(dir, '.dxkit', 'policy.json'),
    JSON.stringify({ schema: { mode, specs: ['openapi.json'] } }),
  );
  writeFileSync(join(dir, 'openapi.json'), BASE_SPEC);
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

describe('evaluateSchemaDriftGateForGuardrail — opt-in + skip paths', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips as off with no schema policy — and an override never activates it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-schemagate-'));
    git(dir, ['init', '-q', '-b', 'main']);
    const out = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main' });
    expect(out.skipped).toBe('off');
    // The loop preset's warn must NOT switch on an unconfigured gate.
    const overridden = await evaluateSchemaDriftGateForGuardrail({
      cwd: dir,
      baseRef: 'main',
      modeOverride: 'warn',
    });
    expect(overridden.skipped).toBe('off');
  });

  it('skips when no base commit is resolvable', async () => {
    dir = makeSchemaRepo();
    const out = await evaluateSchemaDriftGateForGuardrail({ cwd: dir });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('no-base-ref');
  });

  it('trigger-skips a diff that touches no model surface', async () => {
    dir = makeSchemaRepo();
    writeFileSync(join(dir, 'README.md'), 'docs-only change\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'docs']);
    const out = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main~1' });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('no-model-surface-change');
  });

  it('fails open (error skip) on a bogus ref', async () => {
    dir = makeSchemaRepo();
    const out = await evaluateSchemaDriftGateForGuardrail({
      cwd: dir,
      baseRef: 'no-such-ref-anywhere',
    });
    expect(out.ran).toBe(false);
    expect(out.skipped).toBe('error');
    expect(out.blocks).toBe(false);
  });
});

describe('evaluateSchemaDriftGateForGuardrail — real ref-based gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeSchemaRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('blocks a field removal and a required tightening; disclosures ride along', async () => {
    // Working tree: email removed, nick becomes required, org added optional.
    writeFileSync(
      join(dir, 'openapi.json'),
      specDoc({ id: { type: 'integer' }, nick: { type: 'string' }, org: { type: 'string' } }, [
        'id',
        'nick',
      ]),
    );
    const out = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main' });
    expect(out.ran).toBe(true);
    expect(out.blocks).toBe(true);
    const byClass = new Map(out.findings.map((f) => [`${f.changeClass}:${f.field}`, f]));
    expect(byClass.get('field-removed:email')?.verdict).toBe('block');
    expect(byClass.get('field-required-added:nick')?.verdict).toBe('block');
    expect(byClass.get('field-added:org')?.verdict).toBe('info');
  });

  it('warn mode demotes blocks; verdict warns instead', async () => {
    rmSync(dir, { recursive: true, force: true });
    dir = makeSchemaRepo('warn');
    writeFileSync(join(dir, 'openapi.json'), specDoc({ id: { type: 'integer' } }, ['id']));
    const out = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main' });
    expect(out.ran).toBe(true);
    expect(out.blocks).toBe(false);
    expect(out.warns).toBe(true);
    expect(out.findings.every((f) => f.verdict !== 'block')).toBe(true);
  });

  it('an active accepted-risk allowlist entry waives the block, disclosed', async () => {
    writeFileSync(
      join(dir, 'openapi.json'),
      specDoc({ id: { type: 'integer' }, nick: { type: 'string' } }, ['id']),
    );
    const fp = computeModelSchemaDriftFingerprint('User', 'email', 'field-removed');
    const allowlist: AllowlistFile = {
      version: 1,
      entries: [
        {
          fingerprint: fp,
          kind: 'model-schema-drift',
          category: 'accepted-risk',
          reason: 'v2 migration removes email; clients updated',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    } as unknown as AllowlistFile;
    const out = await evaluateSchemaDriftGateForGuardrail({
      cwd: dir,
      baseRef: 'main',
      allowlist,
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(out.blocks).toBe(false);
    expect(out.suppressed).toHaveLength(1);
    expect(out.suppressed[0].fingerprint).toBe(fp);
  });

  it('a pure spec-file rename-equivalent (unchanged content) produces no findings', async () => {
    // Touch the spec with byte-identical model content but reordered JSON —
    // extraction sees the same models, the gate stays silent.
    writeFileSync(
      join(dir, 'openapi.json'),
      JSON.stringify(JSON.parse(BASE_SPEC)), // re-serialized, same content
    );
    const out = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main' });
    // Either trigger-skipped (no diff at all) or ran with zero findings.
    expect(out.blocks).toBe(false);
    expect(out.findings).toHaveLength(0);
  });
});
