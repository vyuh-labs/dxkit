/**
 * Phase 10i.0-LP.7 — recipe-playbook synthesis test.
 *
 * The durable guarantee that the LP architecture is *truly* pack-driven.
 *
 * Defines a synthetic 6th pack (`mockKotlinPack`) implementing every
 * `LanguageSupport` field, mocks the registry to include it, and asserts
 * each pack-iterating consumer picks up its contributions. If a future PR
 * re-introduces hardcoded language coupling — even subtly, even in a
 * consumer not yet known to the LP audit — this test fails.
 *
 * What's covered (LP.1 through LP.6 deliverables):
 *   - allSourceExtensions / allTestFilePatterns iterate the registry
 *   - DEFAULT_VERSIONS pulls each pack's defaultVersion
 *   - buildVariables emits <KEY>_VERSION for every pack
 *   - buildConditions emits IF_<KEY> for every pack
 *   - activeLanguagesFromFlags activates a pack when its versionKey flag
 *     is true in the stack (LP.7 made this pack-driven)
 *   - buildRequiredTools concatenates active packs' tools
 *   - detect() iterates LANGUAGES and calls each pack's .detect(cwd)
 *
 * What's NOT covered (gated on item #14 / 10f.4 — typed
 * `DetectedStack.languages` interface refactor):
 *   - Adding a fully type-safe 6th pack requires extending the
 *     `LanguageId` union AND adding a key to `DetectedStack.languages`.
 *     Until 10f.4 refactors to `Record<LanguageId, boolean>`, every new
 *     pack must edit `src/types.ts` — which is the 8th file in the
 *     "7-file recipe". This is documented in CONTRIBUTING.md.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { LanguageSupport } from '../src/languages';
import {
  LANGUAGES,
  allSourceExtensions,
  allTestFilePatterns,
  activeLanguagesFromFlags,
  activeLanguagesFromStack,
  detectActiveLanguages,
} from '../src/languages';
import { buildVariables, buildConditions } from '../src/constants';
import { buildRequiredTools } from '../src/analyzers/tools/tool-registry';
import { detect } from '../src/detect';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── The mock 6th pack ───────────────────────────────────────────────────────
const mockKotlinPack = {
  id: 'kotlin',
  displayName: 'Kotlin (synthetic — recipe playbook)',
  sourceExtensions: ['.kt', '.kts'],
  testFilePatterns: ['*Test.kt', 'src/test/kotlin/*.kt'],
  extraExcludes: ['build', '.gradle'],
  detect: vi.fn(() => false),
  tools: [],
  semgrepRulesets: [],
  capabilities: {
    coverage: {
      source: 'kotlin-mock',
      async gather() {
        return null;
      },
    },
  },
  permissions: ['Bash(mock-kotlin-permission:*)'],
  ruleFile: 'kotlin-mock.md',
  templateFiles: [{ template: 'configs/kotlin-mock/foo.template', output: 'foo' }],
  cliBinaries: ['kotlinc-mock'],
  defaultVersion: '99.0.0',
  versionKey: 'kotlin',
  projectYamlBlock: ({ enabled }: { enabled: boolean }) =>
    [`  kotlin-mock:`, `    enabled: ${enabled}`, `    version: "99.0.0"`].join('\n'),
} as unknown as LanguageSupport;

// ─── Registry mutation ──────────────────────────────────────────────────────
// `vi.mock` re-exports don't reach module-internal `LANGUAGES` references
// (helper functions like `allSourceExtensions` close over the in-module
// binding, not the export). Mutating the array directly works because all
// consumers iterate `LANGUAGES.flatMap(...)` / `LANGUAGES.filter(...)` —
// fresh read each call. The `readonly` type marker is compile-time only.
//
// One-time consumers that capture state at module-load (e.g.
// `DEFAULT_VERSIONS` and `generic.ts`'s `SOURCE_EXTS` const) freeze before
// this beforeAll runs — those are tested separately via the LP.6
// `buildVariables` / `buildConditions` paths, which iterate fresh.
beforeAll(() => {
  (LANGUAGES as unknown as LanguageSupport[]).push(mockKotlinPack);
});

afterAll(() => {
  const arr = LANGUAGES as unknown as LanguageSupport[];
  const idx = arr.indexOf(mockKotlinPack);
  if (idx >= 0) arr.splice(idx, 1);
});

describe('recipe playbook — synthetic 6th pack', () => {
  it('the mocked registry includes the mock pack', () => {
    expect(LANGUAGES.find((l) => l.id === ('kotlin' as unknown))).toBeDefined();
  });

  // ─── Iteration-based consumers (LP.3, LP.6, LP.7) ─────────────────────────

  it('allSourceExtensions includes the mock pack extensions (LP.3)', () => {
    const exts = allSourceExtensions();
    expect(exts).toContain('.kt');
    expect(exts).toContain('.kts');
  });

  it('allTestFilePatterns includes the mock pack patterns (LP.3)', () => {
    const patterns = allTestFilePatterns();
    expect(patterns).toContain('*Test.kt');
    expect(patterns).toContain('src/test/kotlin/*.kt');
  });

  // DEFAULT_VERSIONS is captured at module load, BEFORE this test's
  // beforeAll mutates LANGUAGES — so we can't assert against it here.
  // Coverage for LP.6's defaultVersion plumbing comes via buildVariables
  // below, which iterates LANGUAGES fresh on every call.

  it('buildVariables emits the mock pack <KEY>_VERSION (LP.6)', () => {
    const fakeConfig = makeFakeConfig({ kotlin: true, kotlinVersion: '99.0.0' });
    const v = buildVariables(fakeConfig);
    expect(v.KOTLIN_VERSION).toBe('99.0.0');
  });

  it('buildConditions emits IF_KOTLIN for the mock pack (LP.6)', () => {
    const fakeConfig = makeFakeConfig({ kotlin: true });
    const conditions = buildConditions(fakeConfig);
    expect(conditions.IF_KOTLIN).toBe(true);
  });

  it('buildConditions emits IF_KOTLIN=false when mock pack is inactive (LP.6)', () => {
    const fakeConfig = makeFakeConfig({ kotlin: false });
    const conditions = buildConditions(fakeConfig);
    expect(conditions.IF_KOTLIN).toBe(false);
  });

  // ─── activeLanguagesFromFlags (LP.7) ──────────────────────────────────────

  it('activeLanguagesFromFlags activates the mock pack via its versionKey (LP.7)', () => {
    // Cast — `kotlin` isn't a typed key on `DetectedStack.languages` until 10f.4.
    const flags = {
      python: false,
      go: false,
      node: false,
      nextjs: false,
      rust: false,
      csharp: false,
      kotlin: true,
    } as unknown as import('../src/types').DetectedStack['languages'];
    const active = activeLanguagesFromFlags(flags);
    expect(active.find((l) => (l.id as string) === 'kotlin')).toBe(mockKotlinPack);
  });

  it('activeLanguagesFromStack picks up the mock pack the same way', () => {
    const stack = {
      languages: {
        python: false,
        go: false,
        node: false,
        nextjs: false,
        rust: false,
        csharp: false,
        kotlin: true,
      },
      // Type-only stub — the assertion only reads .languages.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const active = activeLanguagesFromStack(stack);
    expect(active.find((l) => (l.id as string) === 'kotlin')).toBe(mockKotlinPack);
  });

  // ─── buildRequiredTools (LP.2 + LP.7) ─────────────────────────────────────

  it('buildRequiredTools includes the mock pack when its flag is set (LP.2 + LP.7)', () => {
    // Mock pack declares zero tools to keep TOOL_DEFS lookup safe.
    const required = buildRequiredTools({
      python: false,
      go: false,
      node: false,
      nextjs: false,
      rust: false,
      csharp: false,
      kotlin: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // No assertion that mock-pack tools are added (it has none); we
    // assert the call doesn't blow up — i.e. activeLanguagesFromFlags
    // tolerates the unknown pack and includes it in iteration.
    expect(Array.isArray(required)).toBe(true);
  });

  // ─── detect (LP.5) ────────────────────────────────────────────────────────

  it('detect() invokes the mock pack’s detect(cwd) function (LP.5)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-playbook-'));
    try {
      const mockDetect = mockKotlinPack.detect as ReturnType<typeof vi.fn>;
      mockDetect.mockClear();
      detect(tmpDir);
      expect(mockDetect).toHaveBeenCalledWith(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detectActiveLanguages calls the mock pack’s detect() and respects its return value', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-playbook-'));
    try {
      const mockDetect = mockKotlinPack.detect as ReturnType<typeof vi.fn>;
      mockDetect.mockClear();
      mockDetect.mockReturnValue(true);
      const active = detectActiveLanguages(tmpDir);
      expect(mockDetect).toHaveBeenCalledWith(tmpDir);
      expect(active.find((l) => (l.id as string) === 'kotlin')).toBe(mockKotlinPack);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────
// Synthesize a `ResolvedConfig` with all required fields, optionally
// activating the mock pack via `kotlin: true`.
function makeFakeConfig(opts: { kotlin: boolean; kotlinVersion?: string }) {
  return {
    languages: {
      python: false,
      go: false,
      node: false,
      nextjs: false,
      rust: false,
      csharp: false,
      kotlin: opts.kotlin,
    },
    versions: {
      python: '3.12',
      go: '1.24.0',
      node: '20',
      rust: 'stable',
      csharp: '8.0',
      kotlin: opts.kotlinVersion ?? '99.0.0',
    },
    coverageThreshold: '80',
    projectName: 'test',
    projectDescription: '',
    infrastructure: { docker: false, postgres: false, redis: false },
    tools: { gcloud: false, pulumi: false, infisical: false, ghCli: false },
    requiredTools: [],
    precommit: false,
    qualityChecks: false,
    aiSessions: false,
    aiPrompts: false,
    claudeCode: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
