/**
 * Parity net: `schema diff` (the developer preview) and the guardrail's
 * drift gate are two CONSUMERS of one drift concept. The lossy-projection
 * lesson (the flow gate-vs-join class) says two consumers holding different
 * shapes of one concept WILL diverge unless a test runs both on shared
 * fixtures and asserts they agree — so this does exactly that: one real git
 * repo, one mutation, both surfaces, identical finding sets (ids, classes,
 * verdicts).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSchemaDiff } from '../src/schema-cli';
import { evaluateSchemaDriftGateForGuardrail } from '../src/baseline/schema-drift-gate-check';

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** A repo with BOTH model sources: a TS entity (code extraction) and an
 *  OpenAPI spec (the language-independent bridge), gate on in block mode. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-schemaparity-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, '.dxkit', 'policy.json'),
    JSON.stringify({ schema: { mode: 'block', specs: ['openapi.json'] } }),
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  writeFileSync(
    join(dir, 'src', 'user.entity.ts'),
    `@Entity()\nexport class User {\n  email!: string;\n  nick?: string;\n}\n`,
  );
  writeFileSync(
    join(dir, 'openapi.json'),
    JSON.stringify({
      openapi: '3.0.0',
      components: {
        schemas: {
          Invoice: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'integer' }, total: { type: 'number' } },
          },
        },
      },
    }),
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

describe('schema diff ↔ guardrail gate parity', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('both surfaces produce the identical finding set on a mixed mutation', async () => {
    dir = makeRepo();
    // Mutate BOTH sources: the entity loses a field and tightens one; the
    // spec changes a type.
    writeFileSync(
      join(dir, 'src', 'user.entity.ts'),
      `@Entity()\nexport class User {\n  nick!: string;\n}\n`,
    );
    writeFileSync(
      join(dir, 'openapi.json'),
      JSON.stringify({
        openapi: '3.0.0',
        components: {
          schemas: {
            Invoice: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, total: { type: 'number' } },
            },
          },
        },
      }),
    );

    // Surface 1: the guardrail gate.
    const gate = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main' });
    expect(gate.ran).toBe(true);
    expect(gate.findings.length).toBeGreaterThan(0);

    // Surface 2: the CLI preview (--json), stdout captured.
    let captured = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });
    await runSchemaDiff(dir, { ref: 'main', json: true });
    vi.restoreAllMocks();
    const cli = JSON.parse(captured) as {
      findings: Array<{ id: string; changeClass: string; verdict: string }>;
    };

    const key = (f: { id: string; changeClass: string; verdict: string }): string =>
      `${f.id}:${f.changeClass}:${f.verdict}`;
    expect(cli.findings.map(key).sort()).toEqual(gate.findings.map(key).sort());
    // And the set is the expected one: entity email removed + nick tightened
    // (? removed) + spec id type change — every class from both sources.
    const classes = gate.findings.map((f) => `${f.model}.${f.field}:${f.changeClass}`).sort();
    expect(classes).toEqual([
      'Invoice.id:field-type-changed',
      'User.email:field-removed',
      'User.nick:field-required-added',
    ]);
  });

  it('both surfaces are silent on a pure model-file move', async () => {
    dir = makeRepo();
    git(dir, ['mv', 'src/user.entity.ts', 'src/moved-user.entity.ts']);
    git(dir, ['commit', '-q', '-m', 'move']);

    const gate = await evaluateSchemaDriftGateForGuardrail({ cwd: dir, baseRef: 'main~1' });
    // Ran (the diff touched a model-capable file) but found nothing.
    expect(gate.ran).toBe(true);
    expect(gate.findings).toHaveLength(0);
    expect(gate.blocks).toBe(false);

    let captured = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });
    await runSchemaDiff(dir, { ref: 'main~1', json: true });
    vi.restoreAllMocks();
    const cli = JSON.parse(captured) as { findings: unknown[] };
    expect(cli.findings).toHaveLength(0);
  });
});
