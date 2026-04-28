/**
 * Canonical pack identifier set. Lives here (rather than in
 * `src/languages/types.ts`) because `DetectedStack.languages` is keyed
 * on it — putting it in the languages module would create a circular
 * import (languages/types.ts already imports `ResolvedConfig` from this
 * file). `src/languages/index.ts` re-exports `LanguageId` for callers
 * that prefer importing from the languages barrel.
 *
 * Adding a 6th pack: extend this union AND register the pack in
 * `src/languages/index.ts` LANGUAGES. The scaffolder
 * (`scripts/scaffold-language.js`) automates both.
 */
export type LanguageId = 'typescript' | 'python' | 'go' | 'rust' | 'csharp' | 'kotlin';

/** Tool required for analysis — consumed by devstack for devcontainer packaging. */
export interface ToolRequirement {
  name: string;
  description: string;
  install: string;
  check: string;
  for: string;
  layer: 'universal' | 'language' | 'optional';
}

export interface DetectedStack {
  /**
   * Per-pack activation flags, keyed on `LanguageId`. Truthy values
   * mean the pack is active for this project. Phase 10f.4 refactored
   * this from the legacy fixed-shape `{ python, go, node, nextjs, rust,
   * csharp }` interface so adding a 6th pack only requires extending
   * the `LanguageId` union — no shape edit here.
   *
   * `nextjs` is no longer a separate flag; nextjs projects activate
   * `typescript: true` (since the typescript pack matches any
   * package.json) and the framework signal `framework: 'nextjs'` is
   * surfaced via the top-level `framework` field below.
   */
  languages: Record<LanguageId, boolean>;
  infrastructure: {
    docker: boolean;
    postgres: boolean;
    redis: boolean;
  };
  tools: {
    gcloud: boolean;
    pulumi: boolean;
    infisical: boolean;
    ghCli: boolean;
  };
  projectName: string;
  projectDescription: string;
  /**
   * Per-pack version strings. Keys match each pack's `versionKey ?? id`
   * — typescript pack uses `versionKey: 'node'` for legacy template-
   * variable compat (`NODE_VERSION`), so the key for the typescript
   * pack here is `node`, not `typescript`. Other packs default to
   * their `id`.
   *
   * Pack-driven shape (Recipe v2, Phase 10j.1): `Partial<Record<...>>`
   * over `LanguageId | 'node'` so adding a new pack only extends
   * `LanguageId` — this field auto-grows. The `'node'` carve-out
   * preserves the legacy template-variable compat without forcing a
   * breaking template rename (deferred to a future major when the
   * `NODE_VERSION` → `TYPESCRIPT_VERSION` template migration ships).
   */
  versions: Partial<Record<LanguageId | 'node', string>>;
  testRunner?: {
    command: string; // e.g., "npx jest", "npx mocha", "npm test"
    framework: string; // e.g., "jest", "mocha", "vitest", "pytest"
    coverageCommand?: string; // e.g., "npx jest --coverage", "npx c8 npm test"
  };
  /** Framework signal — e.g. "nextjs", "loopback", "express", "fastapi", "gin". */
  framework?: string;
  requiredTools: ToolRequirement[];
}

export interface ResolvedConfig extends DetectedStack {
  coverageThreshold: string;
  precommit: boolean;
  qualityChecks: boolean;
  aiSessions: boolean;
  aiPrompts: boolean;
  claudeCode: boolean;
}

export type GenerationMode = 'dx-only' | 'full';

export interface FileEntry {
  templatePath: string;
  outputPath: string;
  mode: GenerationMode;
  isTemplate: boolean;
  evolving: boolean;
  condition?: string;
  executable?: boolean;
}

export interface ManifestFileEntry {
  hash: string | null;
  evolving: boolean;
}

export interface Manifest {
  version: string;
  mode: GenerationMode;
  generatedAt: string;
  config: ResolvedConfig;
  files: Record<string, ManifestFileEntry>;
}

export interface InitOptions {
  mode: GenerationMode;
  force: boolean;
  yes: boolean;
  detect: boolean;
  name?: string;
}

export type WriteResult = 'created' | 'skipped' | 'overwritten';
