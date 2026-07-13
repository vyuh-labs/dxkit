import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gatherDescribeInput } from '../../src/describe/gather';
import { buildRepoCard } from '../../src/describe/repo-card';

/**
 * End-to-end proof that `describe` is a ZERO-WRITE trial: gathering a repo
 * card leaves the staged fixture byte-identical (git status stays clean),
 * and the card is well-formed on a real flow-capable stack. Mirrors the
 * staging discipline of `fixtures-analysis.test.ts`.
 */
const FIXTURES = join(__dirname, '..', 'fixtures', 'analysis');
const MATERIALIZE = [
  { marker: 'env.example', target: '.env.example' },
  { marker: 'dxkit-policy.json', target: '.dxkit/policy.json' },
];

function stageFixture(stack: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dxkit-describe-${stack}-`));
  cpSync(join(FIXTURES, stack), dir, { recursive: true });
  for (const { marker, target } of MATERIALIZE) {
    const from = join(dir, marker);
    if (existsSync(from)) {
      mkdirSync(dirname(join(dir, target)), { recursive: true });
      renameSync(from, join(dir, target));
    }
  }
  const git = (...a: string[]) =>
    execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function gitDirty(dir: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
}

const STACKS = ['ts-webapp', 'go-svc'] as const;
const staged: Record<string, string> = {};

beforeAll(() => {
  for (const s of STACKS) staged[s] = stageFixture(s);
});
afterAll(() => {
  for (const d of Object.values(staged)) rmSync(d, { recursive: true, force: true });
});

describe('describe gather — zero-write + well-formed card', () => {
  for (const stack of STACKS) {
    it(`${stack}: produces a labeled card and writes nothing`, async () => {
      const input = await gatherDescribeInput(staged[stack]);
      const card = buildRepoCard(input);

      // Zero-write: the committed fixture is untouched after the gather.
      expect(gitDirty(staged[stack]), 'describe must not write to the repo').toBe('');

      expect(card.schema).toBe('dxkit.repo-card.v1');
      expect(card.zeroWrite).toBe(true);

      // Labeled counts are internally consistent for every section.
      for (const section of [
        card.flow.routes,
        card.flow.calls,
        card.flow.bindings,
        card.models.models,
      ]) {
        expect(section.observed + section.derived + section.inferred + section.unknown).toBe(
          section.total,
        );
      }
      // A flow-capable stack sees at least one call OR route (not a blank card).
      expect(card.flow.routes.total + card.flow.calls.total).toBeGreaterThan(0);
    });
  }
});
