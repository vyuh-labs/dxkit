import type { LanguageId } from '../types';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  LicensesProvider,
  LintProvider,
} from './capabilities/provider';
import type { CoverageResult, ImportsResult, TestFrameworkResult } from './capabilities/types';

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
  depVulns?: DepVulnsProvider;
  lint?: LintProvider;
  coverage?: CapabilityProvider<CoverageResult>;
  testFramework?: CapabilityProvider<TestFrameworkResult>;
  imports?: CapabilityProvider<ImportsResult>;
  licenses?: LicensesProvider;
}

/**
 * Architectural-shape contract a language pack may expose. Captures the
 * path conventions and vocabulary a stack uses for its primary
 * architecture so the analyzer + renderer layer can stop hardcoding
 * backend-centric assumptions ("controllers/", "models/").
 *
 * Every field is optional. A pack with no architectural conventions
 * (rust, today) omits the whole field; a pack with vocabulary but no
 * test-gap taxonomy can declare just `vocabulary`.
 */
export interface ArchitecturalShape {
  /**
   * Path patterns identifying "primary architecture" files for this
   * stack — the surfaces a developer would test first. Backend packs
   * declare controllers/handlers/services. Frontend packs declare
   * components/pages/hooks. Desktop packs declare Forms/ViewModels.
   *
   * Patterns are case-insensitive substrings of the source file's
   * relative POSIX path. Slashes are significant (`"/controllers/"`
   * won't match a filename like `controller-host.ts` that lives
   * outside a controllers directory).
   *
   * Feeds the `controllers` metric counter (despite the name — the
   * field is a generic "primary component" count post-extension),
   * the Maintainability prose, and the test-gap MEDIUM bucket
   * default.
   */
  primaryComponentPaths?: string[];

  /**
   * Path patterns specifically for HTTP route handlers / API endpoints.
   * Gates the "Add API documentation" health action: desktop apps with
   * no HTTP surface (matched count = 0) don't get told to document an
   * API they don't expose.
   *
   * Subset of `primaryComponentPaths` for typical backend packs (a
   * `controllers/` directory hosts route handlers). Frontend packs
   * omit it (React `components/` are not HTTP endpoints). Server-side
   * rendering packs (Next.js' `pages/api/`) declare both.
   */
  routePaths?: string[];

  /**
   * Path patterns for data-model files (ORM entities, DTOs, schemas).
   * Powers the Maintainability prose "N <vocabulary.models>" count.
   */
  modelPaths?: string[];

  /**
   * Display words for prose rendering. The dominant active pack
   * contributes vocabulary (first-active-in-registry-order is the
   * tiebreaker today; packs without `vocabulary` fall through to the
   * next active pack). Consumers fall back to the generic words
   * (`"components"`, `"models"`, `"routes"`) when no active pack
   * supplies a label.
   */
  vocabulary?: {
    components?: string;
    models?: string;
    routes?: string;
  };

  /**
   * Per-bucket path patterns for the test-gap risk taxonomy. The
   * canonical security regexes (`/auth/`, `/jwt/`, `/security/`, ...)
   * still apply pack-agnostically to the CRITICAL bucket; packs may
   * extend it with stack-specific surfaces (csharp's `Auth*Form.cs`).
   *
   * `medium` defaults to `primaryComponentPaths` when omitted — the
   * common case is "any primary component without a matching test
   * is at least MEDIUM risk."
   */
  testGapPriority?: {
    critical?: string[];
    high?: string[];
    medium?: string[];
  };
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

  /**
   * D028 (2.4.7): basename glob patterns identifying auto-generated
   * source files that should be EXCLUDED from per-file metrics
   * (source-file counts, files-over-500-lines, largest-file probes,
   * quality/maintainability scoring inputs). Common examples:
   *
   *   csharp: `['*.designer.cs', '*.g.cs', '*.g.i.cs', '*.generated.cs',
   *            '*.AssemblyInfo.cs', '*.AssemblyAttributes.cs']`
   *   go:     `['*.pb.go', '*_string.go']`        (protobuf, stringer)
   *   java:   `['*Generated.java']`               (Lombok, etc.)
   *
   * The .NET WinForms benchmark is the motivating case: Visual Studio's WinForms
   * designer generates `*.designer.cs` files that are typically large
   * (>500 lines), repetitive, and not authored — pre-D028 these
   * inflated Code Quality + Maintainability dimensions for any .NET
   * UI codebase. Each pack declares its own patterns so adding a new
   * pack (or extending an existing pack's patterns) auto-flows
   * through the cross-cutting `gatherGenericMetrics` filter.
   *
   * Optional — packs without canonical autogen conventions omit it.
   */
  autogeneratedSourcePatterns?: string[];

  /**
   * D027 (2.4.7): grep -E regex strings identifying lines that
   * contain a documentation comment in this language. The union of
   * every active pack's patterns drives `docCommentFiles` in
   * `gatherGenericMetrics` (the Documentation score input). Pre-D027
   * the regex was JS-shaped and the grep --include list was hardcoded
   * to TS / Python / Go extensions, so any csharp / kotlin / java /
   * rust / ruby project reported zero doc-comment files. The .NET
   * WinForms benchmark (3,234 .cs files with XML-doc triple-slash)
   * is the motivating case: Documentation score was pinned at 0/100.
   *
   * POSIX-compatible: prefer `[[:space:]]` over `\s`; escape regex
   * metacharacters for grep -E. Each entry is a standalone regex; the
   * registry unions them via a `\n`-separated pattern file (so embedded
   * single/double quotes in patterns don't break the shell).
   *
   * See each pack's `docCommentPatterns` declaration for the
   * canonical shape (csharp XML-doc, JSDoc/TSDoc, Python docstrings,
   * godoc, rustdoc, KDoc, Javadoc, YARD-style).
   *
   * Optional — packs without canonical doc-comment conventions omit it.
   */
  docCommentPatterns?: string[];

  /**
   * D034 (2.4.7): grep -E regex strings identifying TLS / certificate-
   * validation bypass idioms specific to this language's HTTP / network
   * stacks. The union of every pack's patterns drives `tlsDisabledCount`
   * in `gatherGenericMetrics` — surfaced through the Security score as
   * a `high`-severity code finding.
   *
   * Pre-D034 the regex only matched Node-shaped idioms
   * (`NODE_TLS_REJECT_UNAUTHORIZED`, `rejectUnauthorized: false`,
   * `VERIFY_SSL`) on `*.ts / *.js / *.py` includes. csharp's
   * `ServerCertificateValidationCallback`, go's `InsecureSkipVerify`,
   * rust's `danger_accept_invalid_certs`, java's `TrustAllX509TrustManager`,
   * ruby's `OpenSSL::SSL::VERIFY_NONE`, etc. were never detected. Each
   * pack now declares its own ecosystem-specific idioms.
   *
   * Same POSIX-grep rules as `docCommentPatterns`. Same union-via-
   * pattern-file mechanism in `generic.ts` (avoids shell escaping for
   * patterns containing `::`, quotes, etc.). False positives across
   * languages are negligible — `InsecureSkipVerify` doesn't appear in
   * `.py` files, etc.
   *
   * Optional — packs without canonical TLS-bypass idioms omit it.
   */
  tlsBypassPatterns?: string[];

  /**
   * G_v4_4 (2.4.7): build the per-ecosystem package upgrade command
   * surfaced under "Remediation Commands" in the standalone vuln scan.
   * Each pack owns its own template (`dotnet add package`, `npm install`,
   * `pip install`, `cargo update`, `go get`, edit-pom-and-rebuild for
   * gradle/maven, edit-Gemfile-and-bundle for ruby).
   *
   * Pre-G_v4_4 the dispatch lived in `buildUpgradeCommand`
   * (security/index.ts) as a hardcoded switch on the `tool` field —
   * which violates CLAUDE.md rule 6 (no language-specific branching in
   * non-pack code) and broke when generic tool names (`osv-scanner`,
   * via `osv-scanner-deps.ts`) didn't match the pack-aliased switch
   * keys (`osv-scanner-nuget-direct`). Findings then shipped as bare
   * comments instead of actionable commands. D062 is the .NET WinForms
   * benchmark manifestation.
   *
   * Contract: receives the vulnerable package name and the patched
   * version (caller short-circuits on missing fixedVersion). Returns
   * a single line of shell to run, OR a `#`-prefixed prose hint when
   * the ecosystem requires a manifest edit (gradle/maven/gemfile).
   * Returning `null` is reserved for "this pack genuinely cannot
   * remediate" — caller falls back to generic prose. Implementations
   * should be pure (no side effects, no cwd lookups).
   *
   * Optional — packs without a depVulns capability omit it.
   */
  upgradeCommand?(name: string, version: string): string | null;

  /**
   * Per-stack architectural vocabulary + path conventions. Drives the
   * test-gap risk taxonomy, the Maintainability prose ("controllers"
   * vs "components" vs "Forms"), and the gate on the "Add API
   * documentation" recommendation.
   *
   * Pre-extension these path patterns + words lived inline in
   * `src/analyzers/tests/gather.ts` and `src/analyzers/tools/generic.ts`
   * as hardcoded backend-centric paths (`controllers/`, `handlers/`,
   * `views/`, `models/`). A pure React frontend (`src/components/`,
   * `src/pages/`) matched none of them and reported 0/0/0 across
   * CRITICAL/HIGH/MEDIUM test-gap buckets; a .NET WinForms desktop
   * app (`Forms/`, `Services/`) likewise reported zero primary-
   * architecture files and its Maintainability prose still read
   * "0 controllers/handlers, 0 models" — accurate but unhelpful.
   *
   * Each pack now declares its own conventions. The cross-cutting
   * gather + render code unions/picks across active packs via the
   * helpers in `src/languages/index.ts` (`allPrimaryComponentPaths`,
   * `allRoutePaths`, `allModelPaths`, `allTestGapPriorityPaths`,
   * `dominantVocabulary`).
   *
   * All path patterns are case-insensitive substrings of the source
   * file's relative POSIX path (e.g. `"/controllers/"`, `"/Forms/"`).
   * Slashes are significant — they keep `services` from matching a
   * filename like `service-host.ts` outside a services directory.
   *
   * Optional — packs without canonical architectural conventions omit
   * it (today: rust, where `main.rs` / `lib.rs` are the entire
   * convention and no controllers/components vocabulary maps).
   */
  architecturalShape?: ArchitecturalShape;

  /**
   * D073 (2.4.7): language names cloc emits in its `--json` output
   * for this pack. cloc's per-language keys are NOT 1:1 with file
   * extensions — `.ts` and `.tsx` both report as `"TypeScript"`,
   * `.kt` and `.kts` both as `"Kotlin"`, etc. The full canonical list
   * lives at https://github.com/AlDanial/cloc; each pack declares the
   * names relevant to its own ecosystem.
   *
   * `gatherClocMetrics` filters its language summary + `totalLines`
   * aggregation to the union of every active pack's declarations.
   * Pre-D073 the cloc result included markup/data formats (JSON, XML,
   * CSV, YAML) in the `totalLines` denominator, deflating the quality
   * report's "Comment Ratio" (1.6M JSON lines on the .NET WinForms benchmark dragged
   * the C# comment ratio from ~25% down to 4.3%). Filter lets cloc
   * stay the authoritative line counter for actual source code while
   * data files stop polluting source metrics.
   *
   * Optional — packs without a meaningful cloc representation omit it
   * (rare; every shipped pack today has at least one cloc name).
   */
  clocLanguageNames?: string[];

  detect(cwd: string): boolean;

  tools: string[];
  semgrepRulesets: string[];

  /**
   * Tier a lint rule code into a severity bucket. Accepts `string | null |
   * undefined` because real lint output occasionally emits `ruleId: null`
   * (eslint with rule-disabled diagnostics) or omits the field entirely
   * (golangci-lint's "unknown linter" path). Implementations short-circuit
   * to `'low'` for non-string input — both `mapEslintRuleSeverity` and the
   * golangci-lint mapping rely on this contract for defensive parsing.
   */
  mapLintSeverity?(code: string | null | undefined): LintSeverity;

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
   * External CLI binaries `vyuh-dxkit doctor` checks for when this pack
   * is active. Today this is the per-language toolchain (e.g. python +
   * ruff for python; dotnet for csharp). Surfacing missing binaries to
   * users is the doctor command's primary job.
   */
  cliBinaries?: string[];

  /**
   * Default language version surfaced in `DEFAULT_VERSIONS` (e.g. '3.12'
   * for Python, '20' for Node). Plumbed into template variables as
   * `<KEY>_VERSION` (uppercased `versionKey`).
   */
  defaultVersion?: string;

  /**
   * Per-pack devcontainer feature declaration. Drives the per-stack
   * `features` block in `src-templates/.devcontainer/devcontainer.json`:
   * only active packs' features land in the generated container, so a
   * pure-TypeScript repo no longer pulls .NET / Ruby / Java / Rust /
   * etc. toolchains (~25 min of unused image build).
   *
   * `name` is the canonical ghcr.io feature key (e.g.
   * `ghcr.io/devcontainers/features/python:1`); `opts` is forwarded
   * verbatim as the feature's value (version pins, install flags, etc.).
   *
   * Two packs may declare the same feature key (e.g. java and kotlin
   * both need a JDK). Object-key dedup handles the union — the last
   * pack's opts win. For features with branching opts, factor the
   * declarations so all consumers agree on the shape.
   *
   * Always-on features (Node — dxkit's own runtime; GitHub CLI) are
   * declared by the installer, not per-pack, so a non-Node project
   * still gets the dxkit runtime container.
   *
   * Optional — packs without a canonical ghcr.io feature omit it
   * (today: rare; every shipped pack has one).
   */
  devcontainerFeature?: {
    name: string;
    opts?: Record<string, unknown>;
  };

  /**
   * VSCode extension IDs to install in the generated devcontainer when
   * this pack is active. Companion to `devcontainerFeature` — the
   * feature installs the toolchain (compiler / runtime); the
   * extension(s) drop the editor support (syntax, lint, debug).
   *
   * Mirrors Rule 6 (CLAUDE.md): each pack contributes its own
   * extensions; the installer unions across active packs only. Pre-
   * extension the hardcoded extensions list installed every language's
   * extension on every container (~7 extensions for stacks that don't
   * use those languages), bloating editor startup and download time on
   * Codespaces.
   *
   * Always-on extensions (anthropic.claude-code, github.vscode-github-
   * actions, github.vscode-pull-request-github) are declared by the
   * installer, not per-pack, since they're orthogonal to the language.
   *
   * Optional — packs without canonical editor support omit it.
   */
  devcontainerExtensions?: string[];

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
