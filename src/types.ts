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
export type LanguageId =
  | 'typescript'
  | 'python'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'kotlin'
  | 'java'
  | 'ruby';

/** Tool required for analysis — consumed by devstack for devcontainer packaging. */
export interface ToolRequirement {
  name: string;
  description: string;
  install: string;
  check: string;
  for: string;
  layer: 'universal' | 'language' | 'optional';
  /**
   * Where the tool gets installed. `global` = system-level binary
   * (brew, pipx, apt, go install, cargo install, npm -g). `project-
   * local` = lives in the consuming project's dependency manifest
   * (`npm install --save-dev`, `bundle add`, gem inside Gemfile.lock).
   *
   * Drives the F-UX-3 fix to `tools list`: project-local missing
   * tools shouldn't hint "run `vyuh-dxkit tools install`" — they're
   * already declared in the consumer's package.json/Gemfile and just
   * need `npm ci` / `bundle install`. dxkit shouldn't try to install
   * project deps on the consumer's behalf.
   *
   * Defaults to `global` when omitted — keeps the JSON-shape stable
   * for the existing definitions.
   */
  installScope?: 'global' | 'project-local';
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
  /**
   * How dxkit related to this path at install time:
   *   - `created`     — dxkit wrote the file (it did not exist before).
   *   - `overwritten` — dxkit replaced a pre-existing file (only with --force).
   *   - `skipped`     — the file already existed and dxkit kept the user's
   *                     version. The user OWNS it; dxkit must never delete it,
   *                     and `hash` is null (dxkit doesn't know its content).
   * Optional — absent on manifests written before 2.27; uninstall falls back to
   * the pre-provenance behavior (treat any entry as dxkit's) for those.
   */
  provenance?: 'created' | 'overwritten' | 'skipped';
}

/**
 * Optional ship-installer surfaces the customer landed at init time.
 * Drives `vyuh-dxkit update` so we refresh exactly the surfaces the
 * customer installed and don't regenerate ones they opted out of.
 *
 * Persisted in `manifest.installFlags`. Manifests written before this
 * field existed (pre-2.5.2) don't carry it; `update` falls back to
 * workspace detection and self-migrates by writing the detected
 * flags back on first run.
 */
export interface ManifestInstallFlags {
  withDxkitAgents: boolean;
  withHooks: boolean;
  withPrecommit: boolean;
  withDevcontainer: boolean;
  withCiGuardrails: boolean;
  withBaselineRefresh: boolean;
  withPrReview: boolean;
  /** Loop pack — Stop-gate hook in .claude/settings.json + CLAUDE.md loop
   *  norm + .dxkit/policy.json loop.preset. Optional: absent on manifests
   *  written before the loop pack existed (treated as not-installed). */
  withClaudeLoop?: boolean;
  /** Opt-in `push:[default-branch]` trigger on the guardrails workflow (a
   *  post-hoc verdict for trunk-based/no-PR repos). Optional; absent = off. */
  withCiPushTrigger?: boolean;
  /** Deep-SAST refresh workflow (Snyk/CodeQL ingest; opt-in). Optional: absent
   *  on manifests written before the flag existed — such installs are cleaned
   *  up by presence detection (the workflow's `dxkit-` filename), and update
   *  refreshes them once the flag is stamped on the next init/update. */
  withDeepSastRefresh?: boolean;
}

/** A dependency `vyuh-dxkit tools install` added to the repo on dxkit's behalf
 *  (e.g. a coverage scanner). Recorded so uninstall can OWN it — a dxkit-driven
 *  install whose artifact dxkit then disowns would break the "exact pre-dxkit
 *  state" guarantee. `ecosystem` drives how uninstall removes it. */
export interface ManifestToolDep {
  /** Package/coordinate name (e.g. `@vitest/coverage-v8`). */
  package: string;
  /** Which ecosystem's manifest it landed in (`node` → package.json devDeps). */
  ecosystem: 'node';
}

export interface Manifest {
  version: string;
  mode: GenerationMode;
  generatedAt: string;
  config: ResolvedConfig;
  files: Record<string, ManifestFileEntry>;
  /** Tools `tools install` added on dxkit's behalf. Optional — absent until a
   *  tool is installed, or on manifests written before 2.27. */
  toolDeps?: ManifestToolDep[];
  /**
   * Optional — present on manifests written by dxkit 2.5.2 or later.
   * Older manifests fall back to workspace detection in `update`.
   */
  installFlags?: ManifestInstallFlags;
}

export interface InitOptions {
  mode: GenerationMode;
  force: boolean;
  yes: boolean;
  detect: boolean;
  name?: string;
}

export type WriteResult = 'created' | 'skipped' | 'overwritten';
