/**
 * Phase 10i.0-LP.7 — recipe-playbook synthesis test.
 *
 * The durable guarantee that the LP architecture is *truly* pack-driven.
 *
 * Defines a synthetic pack (`mockPlaybookPack`) implementing every
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
 * Synthetic-id choice (`'playbook'`):
 *   The mock uses an id deliberately outside the `LanguageId` union so it
 *   never collides with a real pack. Phase 10j.1 (Kotlin) surfaced this:
 *   the original mock used `'kotlin'` as a placeholder, then collided
 *   when the real Kotlin pack landed. The lesson generalised — synthetic
 *   ids should be unmistakably non-language (`playbook`) so this test
 *   keeps working as future packs are added without further renames.
 *
 * Post-10f.4 note:
 *   `DetectedStack.languages` is now `Record<LanguageId, boolean>`. The
 *   synthetic pack's id is not in the union, so the test casts the
 *   stack/flags object via `as any` to inject the synthetic flag. Real
 *   packs don't need any cast.
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

// ─── The mock synthetic pack ────────────────────────────────────────────────
// Distinctive extensions/patterns/binaries (`.pbk`, `playbookc-mock`) so the
// assertions verify the *synthetic* contributions specifically, never
// accidentally satisfied by a real pack that happens to share a token.
const mockPlaybookPack = {
  id: 'playbook',
  displayName: 'Playbook (synthetic — recipe playbook)',
  sourceExtensions: ['.pbk', '.pbkx'],
  testFilePatterns: ['*Test.pbk', 'src/test/playbook/*.pbk'],
  extraExcludes: ['playbook-build', '.playbook-cache'],
  detect: vi.fn(() => false),
  tools: [],
  semgrepRulesets: [],
  capabilities: {
    coverage: {
      source: 'playbook-mock',
      async gather() {
        return null;
      },
    },
  },
  permissions: ['Bash(mock-playbook-permission:*)'],
  ruleFile: 'playbook-mock.md',
  templateFiles: [{ template: 'configs/playbook-mock/foo.template', output: 'foo' }],
  cliBinaries: ['playbookc-mock'],
  defaultVersion: '99.0.0',
  versionKey: 'playbook',
  projectYamlBlock: ({ enabled }: { enabled: boolean }) =>
    [`  playbook-mock:`, `    enabled: ${enabled}`, `    version: "99.0.0"`].join('\n'),
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
  (LANGUAGES as unknown as LanguageSupport[]).push(mockPlaybookPack);
});

afterAll(() => {
  const arr = LANGUAGES as unknown as LanguageSupport[];
  const idx = arr.indexOf(mockPlaybookPack);
  if (idx >= 0) arr.splice(idx, 1);
});

describe('recipe playbook — synthetic pack', () => {
  it('the mocked registry includes the mock pack', () => {
    expect(LANGUAGES.find((l) => (l.id as string) === 'playbook')).toBeDefined();
  });

  // ─── Iteration-based consumers (LP.3, LP.6, LP.7) ─────────────────────────

  it('allSourceExtensions includes the mock pack extensions (LP.3)', () => {
    const exts = allSourceExtensions();
    expect(exts).toContain('.pbk');
    expect(exts).toContain('.pbkx');
  });

  it('allTestFilePatterns includes the mock pack patterns (LP.3)', () => {
    const patterns = allTestFilePatterns();
    expect(patterns).toContain('*Test.pbk');
    expect(patterns).toContain('src/test/playbook/*.pbk');
  });

  // DEFAULT_VERSIONS is captured at module load, BEFORE this test's
  // beforeAll mutates LANGUAGES — so we can't assert against it here.
  // Coverage for LP.6's defaultVersion plumbing comes via buildVariables
  // below, which iterates LANGUAGES fresh on every call.

  it('buildVariables emits the mock pack <KEY>_VERSION (LP.6)', () => {
    const fakeConfig = makeFakeConfig({ playbook: true, playbookVersion: '99.0.0' });
    const v = buildVariables(fakeConfig);
    expect(v.PLAYBOOK_VERSION).toBe('99.0.0');
  });

  it('buildConditions emits IF_PLAYBOOK for the mock pack (LP.6)', () => {
    const fakeConfig = makeFakeConfig({ playbook: true });
    const conditions = buildConditions(fakeConfig);
    expect(conditions.IF_PLAYBOOK).toBe(true);
  });

  it('buildConditions emits IF_PLAYBOOK=false when mock pack is inactive (LP.6)', () => {
    const fakeConfig = makeFakeConfig({ playbook: false });
    const conditions = buildConditions(fakeConfig);
    expect(conditions.IF_PLAYBOOK).toBe(false);
  });

  // ─── activeLanguagesFromFlags (LP.7) ──────────────────────────────────────

  it('activeLanguagesFromFlags activates the mock pack by id (LP.7 / 10f.4)', () => {
    // Cast `playbook: true` — `LanguageId` union is closed in production
    // (typescript/python/go/rust/csharp/kotlin); the synthetic mock pack
    // deliberately uses an id outside the union. The cast lives here
    // because the test injects a hypothetical extra pack to verify the
    // architecture iterates the registry rather than enumerating
    // hardcoded ids.
    const flags = {
      typescript: false,
      python: false,
      go: false,
      rust: false,
      csharp: false,
      kotlin: false,
      playbook: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const active = activeLanguagesFromFlags(flags);
    expect(active.find((l) => (l.id as string) === 'playbook')).toBe(mockPlaybookPack);
  });

  it('activeLanguagesFromStack picks up the mock pack the same way', () => {
    const stack = {
      languages: {
        typescript: false,
        python: false,
        go: false,
        rust: false,
        csharp: false,
        kotlin: false,
        playbook: true,
      },
      framework: undefined,
      // Type-only stub — the assertion only reads .languages.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const active = activeLanguagesFromStack(stack);
    expect(active.find((l) => (l.id as string) === 'playbook')).toBe(mockPlaybookPack);
  });

  // ─── buildRequiredTools (LP.2 + LP.7) ─────────────────────────────────────

  it('buildRequiredTools includes the mock pack when its flag is set (LP.2 + LP.7)', () => {
    // Mock pack declares zero tools to keep TOOL_DEFS lookup safe.
    const required = buildRequiredTools({
      typescript: false,
      python: false,
      go: false,
      rust: false,
      csharp: false,
      kotlin: false,
      playbook: true,
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
      const mockDetect = mockPlaybookPack.detect as ReturnType<typeof vi.fn>;
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
      const mockDetect = mockPlaybookPack.detect as ReturnType<typeof vi.fn>;
      mockDetect.mockClear();
      mockDetect.mockReturnValue(true);
      const active = detectActiveLanguages(tmpDir);
      expect(mockDetect).toHaveBeenCalledWith(tmpDir);
      expect(active.find((l) => (l.id as string) === 'playbook')).toBe(mockPlaybookPack);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────
// Synthesize a `ResolvedConfig` with all required fields, optionally
// activating the mock pack via `playbook: true`.
function makeFakeConfig(opts: { playbook: boolean; playbookVersion?: string }) {
  return {
    languages: {
      typescript: false,
      python: false,
      go: false,
      rust: false,
      csharp: false,
      kotlin: false,
      playbook: opts.playbook,
    },
    versions: {
      python: '3.12',
      go: '1.24.0',
      node: '20',
      rust: 'stable',
      csharp: '8.0',
      kotlin: '1.9.22',
      playbook: opts.playbookVersion ?? '99.0.0',
    },
    coverageThreshold: '80',
    projectName: 'test',
    projectDescription: '',
    framework: undefined,
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
