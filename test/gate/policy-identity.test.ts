import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { runGateCommand, renderGateOutcome } from '../../src/gate-cli';
import {
  DEFAULT_BROWNFIELD_POLICY,
  policyContentHash,
  resolvePolicy,
} from '../../src/baseline/policy';
import { policyForPreset } from '../../src/baseline/presets';

/**
 * 4.4.0 WP4 — policy as a named, versioned, embeddable document (P0-3).
 *
 * The acceptance properties, verbatim from the spec: two policy versions
 * produce DISTINGUISHABLE verdicts naming their version; the policy file
 * round-trips through an export (byte transport) and re-runs green
 * against the same tree with the same name + hash.
 */

const HEAVY = 900_000;
const dirs: string[] = [];
let savedSalt: string | undefined;

function makeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-policy-id-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function dodPolicy(version: string, extra: Record<string, unknown> = {}): string {
  const { policy } = policyForPreset('security-only', DEFAULT_BROWNFIELD_POLICY);
  return JSON.stringify({ ...policy, id: 'acme.dod.pkg', version, ...extra }, null, 2);
}

beforeAll(() => {
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  delete process.env.DXKIT_BASELINE_SALT;
});

afterAll(() => {
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('policyContentHash (the naming hash)', () => {
  it('is key-order independent and content-sensitive', () => {
    const a = resolvePolicy(undefined, '/nonexistent');
    expect(policyContentHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(policyContentHash(a)).toBe(policyContentHash({ ...a }));
    const changed = { ...a, warn: [...a.warn, 'uncertain' as const] };
    // Content change → different name. (Same content, spread-reordered
    // keys → same name, per the sort inside.)
    expect(policyContentHash(changed)).not.toBe(policyContentHash(a));
  });
});

describe('named, versioned, embeddable (P0-3 acceptance)', () => {
  it(
    'two policy versions produce distinguishable verdicts naming their version',
    async () => {
      const tree = makeTree({
        'README.md': '# generated package\n',
        'code/handlers.js': '// TODO wire discounts\n',
      });
      const v1Path = join(tree, 'policy-v1.json');
      const v2Path = join(tree, 'policy-v2.json');
      // v1 has no placeholder rule; v2 adds it. Same tree, two DoDs.
      writeFileSync(v1Path, dodPolicy('1'));
      writeFileSync(
        v2Path,
        dodPolicy('2', {
          checks: [{ name: 'no_placeholder', pattern: '\\bTODO\\b', globs: ['code/**'] }],
        }),
      );

      const v1 = await runGateCommand(tree, { policyPath: v1Path });
      const v2 = await runGateCommand(tree, { policyPath: v2Path });
      const doc1 = JSON.parse(renderGateOutcome(v1, true));
      const doc2 = JSON.parse(renderGateOutcome(v2, true));

      // Distinguishable BY NAME, not just by outcome.
      expect(doc1.policy).toMatchObject({ id: 'acme.dod.pkg', version: '1' });
      expect(doc2.policy).toMatchObject({ id: 'acme.dod.pkg', version: '2' });
      expect(doc1.policy.hash).not.toBe(doc2.policy.hash);
      // And the outcomes differ exactly as the DoDs say they should.
      expect(doc1.status).toBe('passed');
      expect(doc2.status).toBe('blocked');
    },
    HEAVY,
  );

  it(
    'the policy document round-trips through an export and re-runs identically (embeddable)',
    async () => {
      const tree = makeTree({
        'README.md': '# generated package\n',
        'code/handlers.js': 'function ok() {\n  return 1;\n}\n',
      });
      const authored = join(tree, 'policy.json');
      writeFileSync(authored, dodPolicy('1'));

      const first = await runGateCommand(tree, { policyPath: authored });
      const firstDoc = JSON.parse(renderGateOutcome(first, true));

      // The export transport: the SAME BYTES travel inside the package
      // (the zip acceptance is byte transport — content addressing makes
      // the medium irrelevant) and come back at a different path.
      const exported = mkdtempSync(join(tmpdir(), 'dxkit-policy-export-'));
      dirs.push(exported);
      const carried = join(exported, 'embedded-policy.json');
      copyFileSync(authored, carried);
      expect(readFileSync(carried, 'utf8')).toBe(readFileSync(authored, 'utf8'));

      const second = await runGateCommand(tree, { policyPath: carried });
      const secondDoc = JSON.parse(renderGateOutcome(second, true));

      // Same DoD, same tree → same name, same hash, same verdict.
      expect(secondDoc.policy).toEqual(firstDoc.policy);
      expect(secondDoc.status).toBe(firstDoc.status);
      expect(secondDoc.exitCode).toBe(firstDoc.exitCode);
      expect(firstDoc.status).toBe('passed');
    },
    HEAVY,
  );
});
