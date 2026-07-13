import { describe, it, expect } from 'vitest';
import { deriveFacts, buildChecklist, CHECKLIST_RULES } from '../../src/pr/checklist';
import type { LanguageSupport } from '../../src/languages/types';

// A minimal fake pack: `allDependencyManifestPatterns` reads only
// `capabilities.depVulns.manifestPatterns`, so this is enough to exercise the
// pack-driven dependency fact without pulling a full LanguageSupport.
const fakePack = {
  capabilities: { depVulns: { manifestPatterns: ['package.json', 'package-lock.json'] } },
} as unknown as LanguageSupport;

function facts(changedFiles: string[], addedLines: string[] = [], packs = [fakePack]) {
  return deriveFacts({ changedFiles, addedLines, packs });
}

describe('deriveFacts', () => {
  it('flags an allowlist file change and an inline annotation', () => {
    expect(facts(['.dxkit/allowlist.json']).allowlistTouched).toBe(true);
    expect(
      facts(['src/a.ts'], ['  const k = secret; // dxkit-allow: secret']).allowlistTouched,
    ).toBe(true);
    expect(facts(['src/a.ts'], ['const x = 1']).allowlistTouched).toBe(false);
  });

  it('flags a dependency-manifest change via the pack patterns', () => {
    expect(facts(['package.json']).dependencyTouched).toBe(true);
    expect(facts(['src/a.ts']).dependencyTouched).toBe(false);
  });

  it('does not flag a dependency change with no active packs', () => {
    expect(facts(['package.json'], [], []).dependencyTouched).toBe(false);
  });

  it('flags a migration / schema change', () => {
    expect(facts(['db/migrations/001_init.ts']).migrationTouched).toBe(true);
    expect(facts(['prisma/schema.prisma']).migrationTouched).toBe(true);
    expect(facts(['api/migrate/0002.sql']).migrationTouched).toBe(true);
    expect(facts(['src/a.ts']).migrationTouched).toBe(false);
  });

  it('flags a public-API change only when a source file added an export', () => {
    expect(facts(['src/a.ts'], ['export function foo() {}']).publicApiChanged).toBe(true);
    expect(facts(['src/a.ts'], ['const internal = 1']).publicApiChanged).toBe(false);
    // an export line with no source file changed does not count
    expect(facts(['README.md'], ['export function foo() {}']).publicApiChanged).toBe(false);
  });

  it('distinguishes source-changed from test-changed', () => {
    const f1 = facts(['src/a.ts']);
    expect(f1.sourceChanged).toBe(true);
    expect(f1.testChanged).toBe(false);

    const f2 = facts(['src/a.ts', 'test/a.test.ts']);
    expect(f2.sourceChanged).toBe(true);
    expect(f2.testChanged).toBe(true);
  });

  it('flags a CI workflow / git hook change', () => {
    expect(facts(['.github/workflows/ci.yml']).ciOrHookTouched).toBe(true);
    expect(facts(['.githooks/pre-push']).ciOrHookTouched).toBe(true);
    expect(facts(['.husky/pre-commit']).ciOrHookTouched).toBe(true);
    expect(facts(['src/a.ts']).ciOrHookTouched).toBe(false);
  });
});

describe('buildChecklist', () => {
  it('always includes the scope + secrets rows', () => {
    const rows = buildChecklist(facts(['README.md']));
    expect(rows.some((r) => /scope is not broader/.test(r))).toBe(true);
    expect(rows.some((r) => /No secrets/.test(r))).toBe(true);
  });

  it('adds a tests row for source changed without a matching test change', () => {
    const rows = buildChecklist(facts(['src/a.ts']));
    expect(rows.some((r) => /Source changed without a matching test/.test(r))).toBe(true);
  });

  it('drops the tests row when a test moved with the source', () => {
    const rows = buildChecklist(facts(['src/a.ts', 'test/a.test.ts']));
    expect(rows.some((r) => /Source changed without a matching test/.test(r))).toBe(false);
  });

  it('adds supply-chain + migration + CI rows only when the diff touches them', () => {
    const rows = buildChecklist(
      facts(['package.json', 'db/migrations/1.sql', '.github/workflows/ci.yml']),
    );
    expect(rows.some((r) => /Supply chain/.test(r))).toBe(true);
    expect(rows.some((r) => /reversible and backward-compatible/.test(r))).toBe(true);
    expect(rows.some((r) => /pipeline-level scrutiny/.test(r))).toBe(true);
  });

  it('renders rows in registry order', () => {
    const rows = buildChecklist(facts(['package.json']));
    const scopeIdx = rows.findIndex((r) => /scope is not broader/.test(r));
    const depIdx = rows.findIndex((r) => /Supply chain/.test(r));
    const secretsIdx = rows.findIndex((r) => /No secrets/.test(r));
    expect(scopeIdx).toBeLessThan(depIdx);
    expect(depIdx).toBeLessThan(secretsIdx);
  });

  it('every rule id is unique', () => {
    const ids = CHECKLIST_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
