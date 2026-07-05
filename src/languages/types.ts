import type { LanguageId } from '../types';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  LicensesProvider,
  LintProvider,
} from './capabilities/provider';
import type { CoverageResult, ImportsResult, TestFrameworkResult } from './capabilities/types';
import type { CorrectnessProvider } from './capabilities/correctness';

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
 * Per-pack interprocedural deep-SAST engine support. Declared by each
 * language pack (Rule 6) and consumed through the registry helpers in
 * `src/languages/index.ts`; the cross-cutting ingest/resolver code never
 * branches on language id.
 */
export interface DeepSastSupport {
  /** CodeQL language id for this pack (as `codeql resolve languages`
   *  reports). undefined ⇒ CodeQL has no extractor here. JavaScript and
   *  TypeScript share the single `javascript` extractor. */
  codeqlLanguage?: string;
  /** CodeQL query suite; defaults to the language's security-extended
   *  suite when omitted. */
  codeqlQuerySuite?: string;
  /** CodeQL DB creation requires building the project (compiled
   *  languages: Java/Kotlin/C#/Go). Source extractors (JS/TS, Python,
   *  Ruby) leave this false. */
  codeqlBuildRequired?: boolean;
  /** CodeQL extractor maturity is beta for this pack (Kotlin via the
   *  java extractor; Rust) — surfaced so callers can warn. */
  codeqlBeta?: boolean;
  /** Snyk Code (SAST) supports this language, so `ingest --from-snyk`
   *  is expected to return findings for it. */
  snykCode?: boolean;
}

/**
 * Per-pack HTTP-flow descriptors: how this language's source expresses
 * outbound HTTP calls (the CONSUMED side) and inbound route declarations
 * (the SERVED side). Declared by each language pack (Rule 6) and consumed
 * through `allHttpFlow` in `src/languages/index.ts`; the cross-cutting flow
 * extractor (`src/analyzers/flow/`) reads the active-pack union and never
 * branches on language id or hardcodes framework literals (`fetch`,
 * `@get`, `router.post`).
 *
 * These are SEMANTIC descriptors matched against the tree-sitter AST — not
 * regexes over text (Rule 5). The extractor finds call expressions /
 * decorators whose callee matches a descriptor, then reads the argument
 * nodes for the method + URL. The descriptors say WHICH constructs are HTTP;
 * the engine reads them structurally.
 *
 * URL normalization (host-helper stripping, `:id`/`{id}`/`${x}` → `{var}`,
 * query stripping) is deliberately NOT here: host helpers are per-APP config
 * (`flow.stripUrlPrefixes`), and param-form canonicalization is uniform
 * across frameworks, so both live in the shared normalizer rather than in a
 * per-language descriptor.
 *
 * These fields are exactly what is needed to extract axios + custom-wrapper
 * client calls from a React frontend and LoopBack `@get`/`@post` + Express
 * `router.<method>` routes — the union that, on a real axios → LoopBack stack,
 * matched-or-beat a hand-tuned regex tool at higher precision.
 *
 * Optional — a pack with no HTTP surface (or none modeled yet) omits it,
 * and the flow extractor sees the empty union for that language.
 */
/**
 * File-convention routing: how a pack's framework serves a route from a file's
 * LOCATION on disk rather than an in-source decorator or router call. Next.js
 * App Router (`app/**` `/route.ts` exporting `GET`/`POST`), SvelteKit
 * (`src/routes/**` `/+server.ts`), and Next.js Pages Router (`pages/api/**`)
 * all fit this shape — the served URL is derived from the directory path and
 * the HTTP verb is an exported symbol's name.
 *
 * The pack declares only what is genuinely framework-specific — the handler
 * filename, the routing base directories, an optional fixed URL prefix, and the
 * verb-named exports. The uniform "file-route path algebra" (route groups,
 * `[param]` / `[[...catch-all]]` dynamics, private `_`-segments, parallel
 * `@`-slots) lives centrally in `src/analyzers/flow/file-routes.ts`, the same
 * Rule 6 boundary the URL normalizer draws — those conventions are shared
 * across every file-route framework, so they are not a per-pack fact.
 */
export interface FileRouteSupport {
  /**
   * Basename (without extension) of a route-handler file — Next.js App Router
   * `'route'`, SvelteKit `'+server'`. Use `'*'` when EVERY file under a base
   * serves a route (Next.js Pages Router `pages/api`, where the filename itself
   * becomes the last path segment and `index` collapses to its directory).
   * Matched against the file's basename with its extension removed.
   */
  handlerFile: string;

  /**
   * Repo-relative directory prefixes under which routing begins; the URL path
   * is derived from the segments AFTER the matched base. The longest (most
   * specific) matching base wins, so `['src/app', 'app']` prefers `src/app`.
   */
  baseDirs: string[];

  /**
   * Fixed URL prefix prepended to every derived path — for a base whose own
   * name is part of the served URL (`pages/api` serves under `/api`). Optional;
   * App Router / SvelteKit omit it because the base directory is not served.
   */
  urlPrefix?: string;

  /**
   * Named exports whose name IS an HTTP verb (`GET`, `POST`, `PUT`, `PATCH`,
   * `DELETE`, `HEAD`, `OPTIONS`). The export's name is the method. Matched
   * against `export function GET`, `export const GET =`, and `export { GET }`.
   */
  methodExports: string[];
}

export interface HttpFlowSupport {
  /**
   * Bare-callee identifiers that initiate an outbound HTTP request with the
   * URL as the first argument. The canonical case is the Fetch API
   * `fetch(url, opts)`. Method comes from the `opts.method` option (default
   * GET). Matched on a `call_expression` whose `function` is an identifier
   * in this list.
   */
  clientCallees?: string[];

  /**
   * Member-method client calls of the form `<base>.<method>(url, ...)`.
   * `methods` are the property names that map to HTTP verbs
   * (`get`/`post`/`put`/`delete`/`patch`); the verb is the method name.
   * `bases`, when present, restricts which receiver identifiers count
   * (`axios`, `http`, `api`, `client`, `request`, ...). When `bases` is
   * omitted, any receiver whose `.<method>(...)` first argument is a
   * path-like literal is treated as a client call — this covers
   * app-specific wrappers (`requests.get('/x')`, `agent.Articles.del(...)`)
   * that no fixed allowlist can enumerate; the path-like-literal filter
   * keeps non-HTTP `.get`/`.delete` (lodash, Maps) out.
   */
  clientMethodCallees?: { methods: string[]; bases?: string[] };

  /**
   * Decorator-style route declarations: `@<name>('/path')` on a handler
   * method (LoopBack `@get`, NestJS `@Post`). `<name>` maps to the HTTP
   * verb; the first string/template argument is the route path. Matched on
   * `decorator` nodes whose call callee is an identifier in this list.
   */
  routeDecorators?: string[];

  /**
   * Router-style route declarations: `<base>.<method>('/path', handler)`
   * (Express `app.get(...)`, `router.post(...)`). `methods` map to verbs;
   * `bases` are the receiver identifiers (`app`, `router`).
   */
  routeRouterCallees?: { methods: string[]; bases: string[] };

  /**
   * Canonicalize a matched method token to an uppercase HTTP verb where the
   * token differs from the verb. The motivating alias is LoopBack's `del` →
   * `DELETE`. Tokens absent from the map default to upper-casing
   * (`get` → `GET`). Keys are lowercase method tokens.
   */
  methodAliases?: Record<string, string>;

  /**
   * File-convention routing (Next.js App Router / SvelteKit / Pages Router):
   * routes served by a handler file's LOCATION, not an in-source decorator or
   * router call. The extractor derives the served URL from the file's directory
   * and reads verb-named exports for the methods. See {@link FileRouteSupport}.
   *
   * Optional — a pack whose frameworks route only in-source omits it.
   */
  fileRoutes?: FileRouteSupport;
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
   * Reliability of this pack's exported-symbol detection in the
   * graphify symbol-extension pipeline. Drives the `exported` field
   * on per-node graph entries (`true` / `false` / absent per the
   * graph JSON schema's "absent = unknown" convention).
   *
   * - `'full'`: both top-level and member exports detected reliably
   *   (TypeScript `export`, Go capitalization, Rust `pub`, C# `public`,
   *   Java/Kotlin public default modifier).
   * - `'partial'`: top-level reliable, member-level imperfect or
   *   specific edge cases miss (Python `__all__` + public-name
   *   heuristic; metaclass tricks may escape).
   * - `'unreliable'`: static analysis cannot answer reliably for
   *   this pack (Ruby metaprogramming + `define_method`); the
   *   `api-surface` query excludes the pack with an explanatory
   *   note, the dashboard "exported only" filter is disabled for
   *   nodes from this pack.
   *
   * `strategy` is a human-readable single-line description of HOW
   * this pack determines exported state, surfaced in CLI / dashboard
   * help text when explaining exclusion or partial coverage.
   *
   * Detection itself is implemented in the Python graphify-symbols
   * extension (`src/analyzers/tools/graphify-graph.ts`) — AST-based
   * per-language patterns living next to the tree-sitter language
   * dispatch. Packs declare the reliability promise here; the script
   * keeps the per-language detection code organized.
   *
   * Optional — packs without graphify symbol-extension coverage omit
   * the field. Consumers treat absent as `'unreliable'`.
   */
  exportDetection?: {
    reliability: 'full' | 'partial' | 'unreliable';
    strategy: string;
  };

  /**
   * How much to trust graphify's `calls`-edge extraction for this
   * language — i.e. whether a node's caller count (its "blast radius")
   * is meaningful. graphify resolves calls by tree-sitter name-matching
   * within the project; that works for languages whose call targets are
   * locally resolvable, but breaks where resolution needs cross-module
   * type information the extractor doesn't have.
   *
   * The motivating case is C#: graphify can't follow `using` directives
   * across assemblies, so most `.cs` files look like orphans (zero
   * callers) even when heavily used. A consumer that reads "0 callers"
   * as "safe to change" would be actively misled — so blast radius must
   * be suppressed (not shown as 0) for `'unreliable'` packs.
   *
   * Optional — absent is treated as `'full'` (graphify's name-matching
   * resolves call targets within the project for this language; same-
   * name conflation still applies everywhere, but a 0 means 0).
   */
  callGraphReliability?: 'full' | 'partial' | 'unreliable';

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
   * HTTP-flow descriptors for this pack: how its source expresses outbound
   * HTTP calls + inbound route declarations. Consumed through `allHttpFlow`
   * in `src/languages/index.ts` by the cross-cutting flow extractor
   * (`src/analyzers/flow/`) — never a per-language branch and never a
   * hardcoded framework literal in the analyzer (Rule 6 + Rule 5).
   *
   * Optional — a pack with no modeled HTTP surface omits it; the extractor
   * sees the empty union for that language. See `HttpFlowSupport`.
   */
  httpFlow?: HttpFlowSupport;

  /**
   * Tree-sitter grammars this pack's source files parse with, keyed by file
   * extension (with leading dot). Consumed by the canonical AST layer
   * (`src/ast/`) — the platform's in-process, graphify-independent parser —
   * which maps each LOGICAL grammar name to a concrete grammar artifact. Keep
   * the names logical (`'typescript'`, `'tsx'`, `'javascript'`), not paths, so
   * the AST engine stays swappable behind `src/ast/` without touching packs
   * (Rule 6 + the same swap discipline graphify sits behind).
   *
   * One language can need several grammars by extension: a TypeScript project
   * mixes `.ts` (typescript), `.tsx` (tsx), and `.js`/`.jsx` (javascript).
   *
   * Optional — a pack omits it until its grammar is wired; AST-based features
   * (flow extraction, future graph building) simply skip that language's files
   * until present. See `src/ast/` for the name → artifact resolution.
   */
  treeSitterGrammars?: Record<string, string>;

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
   * Interprocedural deep-SAST engine support for this pack.
   *
   * dxkit's bundled semgrep tier is intraprocedural; the interprocedural
   * taint class is covered by external engines (CodeQL, Snyk Code) run
   * or ingested via `src/ingest`. This is the single place a language's
   * deep-SAST facts live (Rule 6): the engine resolver, the CodeQL
   * runner, and the `tools install` applicability guard read it through
   * the registry helpers — never a per-language branch.
   *
   * Optional: a pack with no interprocedural engine support omits it,
   * and consumers see the empty union (falling back to the bundled
   * intraprocedural tier).
   */
  deepSast?: DeepSastSupport;

  /**
   * The correctness-floor provider for this pack: how to compile/typecheck a
   * change and run the tests it affects. Consumed by the correctness runner
   * (`src/analyzers/correctness/`) through the registry helper
   * `activeCorrectnessProviders` — never a per-language branch (Rule 6). The
   * floor asks "does this still build + do affected tests pass?", a liveness
   * question prior to the finding gate, and is default-on for the loop
   * Stop-gate surface (an agent must not Stop on non-compiling / test-failing
   * code).
   *
   * REQUIRED. The capability shipped optional (TS/JS + Python first) and
   * tightened to required once all eight built-in packs declared it — the same
   * optional-then-required arc `depVulns.manifestPatterns` followed. A new pack
   * that omits it fails to COMPILE here (not just at test time). A pack whose
   * toolchain has no meaningful floor still supplies a provider whose builders
   * return null (a dormant, no-op floor) rather than dropping the field — so the
   * capability is always wired and the omission class of bug cannot recur.
   */
  correctness: CorrectnessProvider;

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
   * Per-language comment syntax. The allowlist feature uses this to
   * generate inline annotations
   * (`// dxkit-allow:<category> reason="..."`) in the right form for
   * the file's language. Without it, the inline-annotation path
   * would either hardcode `//` everywhere (broken in Python / Ruby /
   * shell) or grow a per-language branch in the allowlist module
   * (a Rule 6 violation).
   *
   * `lineComment` is required for any pack that supports allowlist
   * inline annotations (every pack today). `blockCommentStart` /
   * `blockCommentEnd` are reserved for future formats where line
   * comments are unavailable (e.g., HTML/XML config files that
   * occasionally show up in scanned configs).
   *
   * Examples:
   *   python  / ruby / shell  → `lineComment: '#'`
   *   typescript / go / rust  → `lineComment: '//'`
   *   csharp / kotlin / java  → `lineComment: '//'`
   */
  commentSyntax?: {
    lineComment: string;
    blockCommentStart?: string;
    blockCommentEnd?: string;
  };

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
