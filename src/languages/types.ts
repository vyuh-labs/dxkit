import type { LanguageId, ResolvedConfig } from '../types';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnResult,
  ImportsResult,
  LicensesResult,
  LintResult,
  TestFrameworkResult,
} from './capabilities/types';

// `LanguageId` lives in `src/types.ts` (where `DetectedStack.languages`
// references it) to avoid circular imports. Re-exported here for
// callers that import from the languages barrel.
export type { LanguageId } from '../types';

export type LintSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Capability providers a language pack may expose. Every data-producing
 * surface lives here after Phase 10e.C.5 — the legacy `gatherMetrics`
 * channel is gone, and the capability dispatcher is the only route from
 * a language pack to the analyzer layer. Each provider is optional so a
 * pack can ship incrementally as underlying tool support lands.
 */
export interface LanguagePackCapabilities {
  depVulns?: CapabilityProvider<DepVulnResult>;
  lint?: CapabilityProvider<LintResult>;
  coverage?: CapabilityProvider<CoverageResult>;
  testFramework?: CapabilityProvider<TestFrameworkResult>;
  imports?: CapabilityProvider<ImportsResult>;
  licenses?: CapabilityProvider<LicensesResult>;
}

/**
 * Everything dxkit needs to know about a language lives in one implementation
 * of this interface. See `src/languages/index.ts` for the registry.
 *
 * Optional methods mean "feature not supported yet" — dispatchers should
 * tolerate their absence.
 */
export interface LanguageSupport {
  id: LanguageId;
  displayName: string;

  sourceExtensions: string[];
  testFilePatterns: string[];
  extraExcludes?: string[];

  detect(cwd: string): boolean;

  tools: string[];
  semgrepRulesets: string[];

  mapLintSeverity?(code: string): LintSeverity;

  /** Capability providers for the dispatcher channel. */
  capabilities?: LanguagePackCapabilities;

  /**
   * Bash-permission entries added to `.claude/settings.json` when this
   * pack is active in the project. `vyuh-dxkit init`/`update` iterates
   * `activeLanguagesFromStack(config)` and concatenates each pack's
   * permissions onto the base permission list.
   */
  permissions?: string[];

  /**
   * Filename under `src-templates/.claude/rules/` to copy to
   * `.claude/rules/<file>` when this pack is active. Frameworks like
   * `nextjs.md`, `loopback.md`, `express.md` are NOT pack-owned — they
   * stay hardcoded in `generator.ts` because they're framework-scoped,
   * not language-scoped.
   */
  ruleFile?: string;

  /**
   * Per-pack template→output pairs scaffolded by `vyuh-dxkit init` when
   * this pack is active. Templates live under
   * `src-templates/configs/<lang>/`. Skipped silently if the output
   * already exists (so `update` doesn't clobber user-customized
   * configs).
   */
  templateFiles?: { template: string; output: string }[];

  /**
   * External CLI binaries `vyuh-dxkit doctor` checks for when this pack
   * is active. Today this is the per-language toolchain (e.g. python +
   * ruff for python; dotnet for csharp). Surfacing missing binaries to
   * users is the doctor command's primary job.
   */
  cliBinaries?: string[];

  /**
   * Renders this pack's section under `languages:` in `.project.yaml`.
   * Receives the resolved project config + an `enabled` flag the
   * registry computes (since the YAML emits `enabled: false` for
   * inactive packs too — the section is iterated over ALL packs, not
   * just active ones). Returning a multi-line string (lines joined by
   * "\n") is conventional.
   */
  projectYamlBlock?: (ctx: ProjectYamlContext) => string;

  /**
   * Default language version surfaced in `DEFAULT_VERSIONS` (e.g. '3.12'
   * for Python, '20' for Node). Plumbed into template variables as
   * `<KEY>_VERSION` (uppercased `versionKey`) and into `.project.yaml`'s
   * `version:` field for inactive packs.
   */
  defaultVersion?: string;

  /**
   * Key under `DetectedStack.versions` where this pack's version lives —
   * AND the lowercase prefix used to derive template-variable + condition
   * names (`NODE_VERSION`, `IF_NODE`). Defaults to `id` when omitted.
   *
   * Necessary because the typescript pack uses `versionKey: 'node'` —
   * legacy template / condition naming predates the pack abstraction.
   * Removing this indirection requires renaming the templates'
   * `NODE_VERSION` / `IF_NODE` references to `TYPESCRIPT_VERSION` /
   * `IF_TYPESCRIPT`, which is a breaking template change tracked
   * alongside D009/D010 in 10f.4.
   */
  versionKey?: keyof import('../types').DetectedStack['versions'];
}

/** Context passed to `LanguageSupport.projectYamlBlock`. */
export interface ProjectYamlContext {
  config: ResolvedConfig;
  enabled: boolean;
}
