import type { DetectedStack } from '../types';
import type {
  ArchitecturalShape,
  CiSetupStep,
  DeepSastSupport,
  HttpFlowSupport,
  LanguageId,
  LanguageSupport,
  ModelSchemaSupport,
} from './types';
import type { CorrectnessProvider } from './capabilities/correctness';
import type { LintGateProvider } from './capabilities/lint-gate';
import { csharp } from './csharp';
import { go } from './go';
import { python } from './python';
import { rust } from './rust';
import { typescript } from './typescript';
import { kotlin } from './kotlin';
import { java } from './java';
import { ruby } from './ruby';

export type {
  ArchitecturalShape,
  HttpFlowSupport,
  LanguageId,
  LanguageSupport,
  LintSeverity,
  ModelSchemaSupport,
} from './types';

export const LANGUAGES: readonly LanguageSupport[] = [
  python,
  typescript,
  csharp,
  go,
  rust,
  kotlin,
  java,
  ruby,
];

export function getLanguage(id: LanguageId): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

export function detectActiveLanguages(cwd: string): LanguageSupport[] {
  return LANGUAGES.filter((l) => l.detect(cwd));
}

/**
 * Map a source-file path to its owning language pack by extension,
 * using each pack's declared `sourceExtensions` (pack-driven per
 * CLAUDE.md Rule 6 — no hardcoded ext→lang table). Returns undefined
 * for files no registered pack claims. Longest-extension-wins so a
 * compound extension (e.g. a future `.d.ts`) beats a shorter one.
 */
export function languageForFile(filePath: string): LanguageSupport | undefined {
  const lower = filePath.toLowerCase();
  let best: LanguageSupport | undefined;
  let bestLen = -1;
  for (const lang of LANGUAGES) {
    for (const ext of lang.sourceExtensions) {
      const e = ext.toLowerCase();
      if (lower.endsWith(e) && e.length > bestLen) {
        best = lang;
        bestLen = e.length;
      }
    }
  }
  return best;
}

/**
 * Map a `DetectedStack` (or `ResolvedConfig`, which extends it) to the
 * set of `LanguageSupport` packs that are active for the project.
 * Pack-driven via `DetectedStack.languages` keyed on `LanguageId` —
 * adding a pack means extending `LanguageId` + registering in
 * `LANGUAGES`; this function never changes.
 */
export function activeLanguagesFromStack(stack: DetectedStack): LanguageSupport[] {
  return activeLanguagesFromFlags(stack.languages);
}

/**
 * Same as `activeLanguagesFromStack`, but for callers who only have
 * the `languages` sub-shape (e.g. `tool-registry.ts:buildRequiredTools`
 * receives `DetectedStack['languages']`, not the full stack).
 */
export function activeLanguagesFromFlags(flags: DetectedStack['languages']): LanguageSupport[] {
  return LANGUAGES.filter((l) => flags[l.id] ?? false);
}

/**
 * All source-file extensions across every registered pack, deduplicated.
 * The pack-driven analog of the pre-LP.3 hardcoded
 * `'.ts .tsx .js .jsx .py .go .rs .cs'` constant in `generic.ts` —
 * grows automatically as new packs land.
 */
export function allSourceExtensions(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.sourceExtensions))];
}

/**
 * Dependency-manifest / lockfile patterns declared by the given packs'
 * `depVulns` capability, deduplicated. Pack-driven (Rule 6): each pack owns its
 * patterns next to the audit they gate; this union grows as packs land.
 */
export function allDependencyManifestPatterns(packs: readonly LanguageSupport[]): string[] {
  return [...new Set(packs.flatMap((l) => l.capabilities?.depVulns?.manifestPatterns ?? []))];
}

/**
 * Does any changed-file path look like a dependency manifest/lockfile for one
 * of the given (active) packs? Drives the incremental ref-based dep-audit skip
 * in `runGuardrailCheck`: a net-new dependency vulnerability requires a
 * manifest/lockfile change, so when this returns false the OSV audit can be
 * skipped on both sides (sound in ref-based mode only — see DepVulnsProvider).
 *
 * Fail-safe: with no patterns to test (no active pack declares any), returns
 * true — we cannot prove the PR is dependency-free, so we run the audit.
 */
export function changedFilesTouchDependencyManifest(
  changedFiles: readonly string[],
  packs: readonly LanguageSupport[],
): boolean {
  const patterns = allDependencyManifestPatterns(packs);
  if (patterns.length === 0) return true;
  return changedFiles.some((f) => patterns.some((p) => matchesManifestPattern(f, p)));
}

/**
 * Match one repo-relative path against one manifest pattern (exported for
 * tests). A multi-segment pattern matches a path equal to it or nested under
 * any directory; a `*` glob matches on the basename; a bare name matches any
 * file with that basename anywhere in the tree.
 */
export function matchesManifestPattern(filePath: string, pattern: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  if (pattern.includes('/')) {
    return norm === pattern || norm.endsWith('/' + pattern);
  }
  if (pattern.includes('*')) {
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return re.test(base);
  }
  return base === pattern;
}

/**
 * The active packs that declare interprocedural deep-SAST support,
 * paired with their declaration (Rule 6). The engine resolver, the
 * CodeQL runner, and the `tools install` applicability guard read the
 * union here instead of branching on language id — so adding a pack (or
 * an engine field) auto-extends every consumer.
 */
export function activeDeepSast(
  flags: DetectedStack['languages'],
): Array<{ id: LanguageId; deepSast: DeepSastSupport }> {
  return activeLanguagesFromFlags(flags)
    .filter((l) => l.deepSast)
    .map((l) => ({ id: l.id, deepSast: l.deepSast as DeepSastSupport }));
}

/**
 * Distinct CodeQL language ids needed to scan the active stack,
 * deduplicated (JS+TS collapse to one `javascript`). Empty when no
 * active pack has a CodeQL extractor — the runner then has nothing to do.
 */
export function codeqlLanguagesFromFlags(flags: DetectedStack['languages']): string[] {
  return [
    ...new Set(
      activeDeepSast(flags)
        .map((d) => d.deepSast.codeqlLanguage)
        .filter((l): l is string => !!l),
    ),
  ];
}

/** True when any active pack expects Snyk Code coverage — gates whether
 *  `ingest --from-snyk` is worth offering for this stack. */
export function anyActivePackSupportsSnykCode(flags: DetectedStack['languages']): boolean {
  return activeDeepSast(flags).some((d) => d.deepSast.snykCode === true);
}

/**
 * Cross-ecosystem test-DIRECTORY conventions. Where tests live is a
 * structural convention shared across languages (Jest's `__tests__/`,
 * the near-universal `test/` / `tests/` / `spec/` / `e2e/`), unlike how
 * test FILES are named (`*Test.java` vs `*_test.go` vs `*.spec.ts`),
 * which genuinely varies per language and stays in each pack's
 * `testFilePatterns`. Declaring the directory conventions once here —
 * rather than copying them into every pack — is why a repo that
 * organizes tests by directory is classified correctly in any language,
 * and why adding a new pack inherits them for free.
 *
 * Path-anchored (each contains `/`), so `splitTestFilePatterns` routes
 * them to the path matcher: `__tests__/**` matches `src/__tests__/a.ts`
 * AND `a/b/__tests__/c.ts` (anywhere in the tree). The walker only
 * evaluates these against files that already passed the source-extension
 * filter, so non-source files under a test dir are never misclassified.
 *
 * `__mocks__/` is intentionally excluded — mocks are test *support*, not
 * tests, and counting them would inflate the test-file ratio.
 */
export const UNIVERSAL_TEST_DIR_PATTERNS: readonly string[] = [
  '__tests__/**',
  'test/**',
  'tests/**',
  'spec/**',
  'e2e/**',
];

/**
 * All test-file patterns: each pack's language-specific filename
 * conventions unioned with the shared cross-ecosystem test-directory
 * conventions (`UNIVERSAL_TEST_DIR_PATTERNS`), deduplicated. Patterns
 * without a slash are basename-style (matched by find `-name`); patterns
 * containing a slash are path-anchored (the test-dir conventions + e.g.
 * Rust's tests-directory glob) and need find `-path` semantics — see
 * `splitTestFilePatterns()`.
 */
export function allTestFilePatterns(): string[] {
  return [
    ...new Set([...LANGUAGES.flatMap((l) => l.testFilePatterns), ...UNIVERSAL_TEST_DIR_PATTERNS]),
  ];
}

/**
 * All auto-generated source-file basename patterns across every
 * registered pack, deduplicated. D028 (2.4.7): consumers (currently
 * `src/analyzers/tools/generic.ts`) build find `-not -name` excludes
 * from this list to keep per-file metrics from being inflated by
 * generated code (designer.cs, *.pb.go, *Generated.java, etc.).
 *
 * Packs that don't declare `autogeneratedSourcePatterns` contribute
 * nothing — the helper returns the union of all declared patterns
 * across active+inactive packs. Conservative by design: a designer.cs
 * file in a polyglot repo with both csharp and go active is still
 * filtered even if the csharp pack happens to be inactive in this
 * cwd's scope.
 */
export function allAutogenSourcePatterns(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.autogeneratedSourcePatterns ?? []))];
}

/**
 * All doc-comment regex patterns across every registered pack,
 * deduplicated. D027 (2.4.7): consumed by `generic.ts` to build a
 * union grep alternation for `docCommentFiles`. Empty array when no
 * pack declares any patterns — caller short-circuits to 0.
 *
 * Scope mirrors `allAutogenSourcePatterns`: union across all packs
 * (active + inactive). A `///` line in a `.cs` file inside a
 * polyglot repo gets counted even if csharp isn't the dominant pack
 * — the false-positive rate across language boundaries is negligible
 * (e.g. `///` doesn't appear in `.py` files).
 */
export function allDocCommentPatterns(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.docCommentPatterns ?? []))];
}

/**
 * All TLS-bypass regex patterns across every registered pack,
 * deduplicated. D034 (2.4.7): consumed by `generic.ts` to build a
 * union grep alternation for `tlsDisabledCount` — a Security-score
 * input that previously matched only Node-shaped idioms.
 *
 * Scope mirrors `allDocCommentPatterns`: union across all packs
 * (active + inactive). A `.cs` file containing
 * `ServerCertificateValidationCallback = ...` in a polyglot repo
 * gets flagged regardless of which pack the customer "primarily" uses
 * — security findings should never be silently scoped out.
 */
export function allTlsBypassPatterns(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.tlsBypassPatterns ?? []))];
}

/**
 * Per-pack exported-symbol detection declarations, with pack identity
 * preserved. Unlike the pattern-union helpers above, consumers need to
 * know which pack contributes which reliability + strategy — the
 * api-surface CLI uses this to print "Excluded: ruby pack (reason: ...)"
 * notes, and the dashboard viz uses it to disable the "exported only"
 * filter for nodes from unreliable packs.
 *
 * Scope mirrors `allTlsBypassPatterns`: union across all packs (active
 * + inactive). Returns one entry per pack that declares the field;
 * packs with no declaration are omitted. Consumers treat omitted packs
 * as effectively `'unreliable'` (per the field's declared semantics).
 */
export interface ExportDetectionDeclaration {
  pack: LanguageId;
  reliability: 'full' | 'partial' | 'unreliable';
  strategy: string;
}

export function allExportDetectionDeclarations(): ExportDetectionDeclaration[] {
  return LANGUAGES.flatMap((l) =>
    l.exportDetection
      ? [
          {
            pack: l.id,
            reliability: l.exportDetection.reliability,
            strategy: l.exportDetection.strategy,
          },
        ]
      : [],
  );
}

/**
 * Cloc language names declared by every pack, deduplicated. D073
 * (2.4.7): consumed by `gatherClocMetrics` to filter cloc's per-
 * language summary + `totalLines` aggregation down to "actual source
 * code" — JSON / XML / CSV / Markdown that cloc emits stay out of the
 * source-line counters that quality's Comment Ratio + health's
 * Documentation derive from. Pre-D073 cloc's `SUM` summed every
 * language including markup/data, deflating the .NET WinForms
 * benchmark's comment ratio (1.6M JSON lines dragged 25%-true C#
 * comment ratio down to
 * 4.3%).
 *
 * Scope mirrors `allAutogenSourcePatterns` — union across active +
 * inactive packs. A `.cs` file in a polyglot repo gets counted even
 * when csharp isn't the detect-time dominant pack, which is fine:
 * cloc names map to languages, not pack-presence signals.
 */
export function allClocLanguageNames(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.clocLanguageNames ?? []))];
}

/**
 * Union of every active pack's `architecturalShape.primaryComponentPaths`,
 * deduplicated. Consumed by `gatherGenericMetrics` to count the
 * primary-component file metric (`HealthMetrics.controllers`) and by
 * the test-gap classifier in `analyzers/tests/gather.ts` to populate
 * the MEDIUM bucket by default.
 *
 * Pre-extension, generic.ts hardcoded `controllers/`, `handlers/`,
 * `views/` and gather.ts hardcoded the same set inline — a pure
 * React frontend or .NET WinForms desktop app matched zero paths
 * and reported empty MEDIUM/HIGH test-gap buckets. Pack-driven
 * union grows automatically as new packs land.
 *
 * Scope is active-only: matching `<dxkit health>` analyzes the
 * project the user is in, not every pack that exists. This keeps
 * Python pack's `views/` from incorrectly matching a Java repo's
 * Spring MVC views layer (cross-pack false positives).
 */
export function allPrimaryComponentPaths(flags: DetectedStack['languages']): string[] {
  return [
    ...new Set(
      activeLanguagesFromFlags(flags).flatMap(
        (l) => l.architecturalShape?.primaryComponentPaths ?? [],
      ),
    ),
  ];
}

/**
 * Union of every active pack's `ciSetup.steps` — the language-runtime setup the
 * CI guardrail workflow needs so a non-Node repo's native dep scanner can
 * install and its correctness floor can run. Deduplicated by `uses` (two active
 * packs on the same toolchain — Java + Kotlin both `setup-java` — set it up
 * once). Consumed by the workflow templater (`ship-installers`) at install time
 * to render the `__DXKIT_CI_RUNTIME_SETUP__` block from the DETECTED stack, so
 * the workflow never carries a per-language setup chain (Rule 6). Node's own
 * setup stays in the template as dxkit's CLI runtime; this adds the project's.
 */
export function allCiSetupSteps(flags: DetectedStack['languages'], cwd?: string): CiSetupStep[] {
  // Dedup by `uses`, but PREFER a step whose version was actually substituted
  // from a DETECTED version — so a Java+Kotlin repo (both `setup-java`) uses the
  // Java pack's detected JDK, not Kotlin's fixed default. Substitute only on a
  // real detection so an undetected repo keeps the declared step byte-for-byte.
  const byUses = new Map<string, { step: CiSetupStep; detected: boolean }>();
  const order: string[] = [];
  for (const l of activeLanguagesFromFlags(flags)) {
    const detected = cwd !== undefined ? l.detectVersion?.(cwd) : undefined;
    for (const step of l.ciSetup?.steps ?? []) {
      const substituted =
        step.versionInput && detected
          ? { ...step, with: { ...step.with, [step.versionInput]: detected } }
          : step;
      const isDetected = Boolean(step.versionInput && detected);
      const existing = byUses.get(step.uses);
      if (!existing) {
        byUses.set(step.uses, { step: substituted, detected: isDetected });
        order.push(step.uses);
      } else if (isDetected && !existing.detected) {
        byUses.set(step.uses, { step: substituted, detected: isDetected });
      }
    }
  }
  return order.map((u) => byUses.get(u)!.step);
}

/**
 * Union of every active pack's `architecturalShape.routePaths`,
 * deduplicated. Consumed by `gatherGenericMetrics` to populate
 * `HealthMetrics.routeHandlerFiles` — the count gating the "Add API
 * documentation" health action. A WinForms desktop app (.NET pack
 * active but no `Controllers/` directory) reports zero here even when
 * `primaryComponentPaths` matches Forms/ViewModels, so the action
 * stays correctly silenced.
 */
export function allRoutePaths(flags: DetectedStack['languages']): string[] {
  return [
    ...new Set(
      activeLanguagesFromFlags(flags).flatMap((l) => l.architecturalShape?.routePaths ?? []),
    ),
  ];
}

/**
 * Union of every active pack's `architecturalShape.nonConsumerRoutePaths`,
 * deduplicated — the routes whose consumer is an external actor
 * (webhook / cron / health / public-API / CLI), so a "no in-repo consumer"
 * reading is EXPECTED, not dead-surface slop. Consumed by the dead-surface
 * analyzer to drop a matching route to the "expected" tier. Pack-driven
 * (Rule 6/8): a new framework declares its convention shapes and inherits the
 * filter, and the arch-check keeps the literals out of analyzers.
 */
export function allNonConsumerRoutePaths(flags: DetectedStack['languages']): string[] {
  return [
    ...new Set(
      activeLanguagesFromFlags(flags).flatMap(
        (l) => l.architecturalShape?.nonConsumerRoutePaths ?? [],
      ),
    ),
  ];
}

/**
 * Union of every active pack's `architecturalShape.modelPaths`,
 * deduplicated. Consumed by `gatherGenericMetrics` to populate
 * `HealthMetrics.models` (the "data model files" count surfaced in
 * Maintainability prose).
 */
export function allModelPaths(flags: DetectedStack['languages']): string[] {
  return [
    ...new Set(
      activeLanguagesFromFlags(flags).flatMap((l) => l.architecturalShape?.modelPaths ?? []),
    ),
  ];
}

/**
 * Active packs' `httpFlow` descriptors (defined-only). Consumed by the
 * cross-cutting flow extractor (`src/analyzers/flow/`): it resolves the
 * per-file descriptor by the file's language and uses this union to decide
 * whether flow extraction applies at all. Per Rule 6 the extractor never
 * branches on language id or hardcodes a framework literal — every HTTP
 * client/route construct it recognizes comes from a pack's descriptor here.
 *
 * `recipe-playbook.test.ts` asserts a synthetic pack's `httpFlow`
 * contribution flows through this helper, codifying "flow extraction is
 * pack-driven, not analyzer-by-analyzer."
 */
export function allHttpFlow(flags: DetectedStack['languages']): HttpFlowSupport[] {
  return activeLanguagesFromFlags(flags)
    .map((l) => l.httpFlow)
    .filter((h): h is HttpFlowSupport => h !== undefined);
}

/**
 * Source-file extensions of packs that can contribute flow — those declaring
 * BOTH an `httpFlow` descriptor and a tree-sitter grammar (extraction needs
 * both). One source of truth (Rule 2) for the flow file walk and the
 * changed-files flow-surface trigger. Pack-driven (Rule 6): a new flow pack
 * auto-extends the set.
 */
/**
 * Active packs that declare a correctness-floor provider, with their id. The
 * correctness runner (`src/analyzers/correctness/`) iterates this union to build
 * each pack's syntax + affected-test commands — never a per-language branch
 * (Rule 6). A pack without a wired toolchain simply doesn't appear.
 */
export function activeCorrectnessProviders(
  packs: readonly LanguageSupport[],
): { id: LanguageId; provider: CorrectnessProvider }[] {
  return packs
    .filter((p) => p.correctness !== undefined)
    .map((p) => ({ id: p.id, provider: p.correctness as CorrectnessProvider }));
}

/**
 * Active packs that declare a lint-GATE provider, for the custom-check runner
 * (Rule 6). Only packs with a `lintGate` are returned; the union drives the
 * `lint:<pack>` built-in checks the guardrail synthesizes when `lint.enabled`.
 */
export function activeLintGateProviders(
  packs: readonly LanguageSupport[],
): { id: LanguageId; provider: LintGateProvider }[] {
  return packs
    .filter((p) => p.lintGate !== undefined)
    .map((p) => ({ id: p.id, provider: p.lintGate as LintGateProvider }));
}

export function allFlowSourceExtensions(packs: readonly LanguageSupport[]): string[] {
  const exts = new Set<string>();
  for (const pack of packs) {
    if (pack.httpFlow && pack.treeSitterGrammars) {
      for (const ext of Object.keys(pack.treeSitterGrammars)) exts.add(ext);
    }
  }
  return [...exts];
}

/**
 * Does any changed-file path touch a flow surface — a source file in a
 * flow-capable pack's extension set, or a configured OpenAPI spec? Drives the
 * incremental flow-gate trigger-skip in `runGuardrailCheck`: a net-new broken
 * integration requires a change to a client call, a route declaration, or a
 * spec, so when this returns false the ref-based gate is skipped entirely.
 *
 * Fail-safe returns false (skip) ONLY when there is genuinely nothing to gate:
 * no flow-capable pack is active. With flow-capable packs present but no
 * matching change, it also returns false — correctly, since the diff cannot
 * have introduced a net-new binding. `specPaths` are repo-relative.
 */
export function changedFilesTouchFlowSurface(
  changedFiles: readonly string[],
  packs: readonly LanguageSupport[],
  specPaths: readonly string[] = [],
  /**
   * Declared contract-artifact paths (`flow.sources[].path`) — exact paths
   * or basename `*` globs. A PR that only edits a Postman collection or a
   * pact MUST NOT skip the gate: the artifact IS flow surface.
   */
  sourcePatterns: readonly string[] = [],
): boolean {
  const exts = allFlowSourceExtensions(packs);
  if (exts.length === 0 && specPaths.length === 0 && sourcePatterns.length === 0) return false;
  const specSet = new Set(specPaths.map((s) => s.replace(/\\/g, '/')));
  const sourceRes = sourcePatterns.map((p) => {
    const norm = p.replace(/\\/g, '/');
    const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
  });
  return changedFiles.some((f) => {
    const norm = f.replace(/\\/g, '/');
    return (
      exts.some((e) => norm.endsWith(e)) ||
      specSet.has(norm) ||
      sourceRes.some((re) => re.test(norm))
    );
  });
}

/**
 * Active packs' `modelSchema` descriptors (defined-only) — the model-schema
 * mirror of `allHttpFlow`. Consumed by the cross-cutting extractor in
 * `src/analyzers/model-schema/`: it resolves the per-file descriptor by the
 * file's language and uses this union to decide whether model extraction
 * applies at all (Rule 6 — no per-language branch, no framework literal in
 * the analyzer). `recipe-playbook.test.ts` asserts a synthetic pack's
 * contribution flows through this helper.
 */
export function allModelSchema(flags: DetectedStack['languages']): ModelSchemaSupport[] {
  return activeLanguagesFromFlags(flags)
    .map((l) => l.modelSchema)
    .filter((m): m is ModelSchemaSupport => m !== undefined);
}

/**
 * Source-file extensions of packs that can contribute models — those
 * declaring BOTH a `modelSchema` descriptor and a tree-sitter grammar
 * (extraction needs both). One source of truth (Rule 2) for the model file
 * walk and the changed-files model-surface trigger; the mirror of
 * `allFlowSourceExtensions`.
 */
export function allModelSchemaSourceExtensions(packs: readonly LanguageSupport[]): string[] {
  const exts = new Set<string>();
  for (const pack of packs) {
    if (pack.modelSchema && pack.treeSitterGrammars) {
      for (const ext of Object.keys(pack.treeSitterGrammars)) exts.add(ext);
    }
  }
  return [...exts];
}

/**
 * Does any changed-file path touch a model surface — a source file in a
 * model-capable pack's extension set, or a configured schema spec? Drives
 * the incremental drift-gate trigger-skip in `runGuardrailCheck`: net-new
 * schema drift requires a change to a model declaration or a spec, so when
 * this returns false the two-ref gate is skipped entirely. Same fail-safe
 * contract as `changedFilesTouchFlowSurface`: false only when nothing could
 * have introduced drift. `specPaths` are repo-relative.
 */
export function changedFilesTouchModelSurface(
  changedFiles: readonly string[],
  packs: readonly LanguageSupport[],
  specPaths: readonly string[] = [],
): boolean {
  const exts = allModelSchemaSourceExtensions(packs);
  const specSet = new Set(specPaths.map((s) => s.replace(/\\/g, '/')));
  if (exts.length === 0 && specSet.size === 0) return false;
  return changedFiles.some((f) => {
    const norm = f.replace(/\\/g, '/');
    return exts.some((e) => norm.endsWith(e)) || specSet.has(norm);
  });
}

/**
 * Per-bucket union of active packs' test-gap path patterns. Empty
 * arrays for any bucket no pack declares. Consumed by
 * `analyzers/tests/gather.ts:classifyRisk` to tier source files into
 * the CRITICAL / HIGH / MEDIUM / LOW buckets.
 *
 * The `medium` bucket defaults to a pack's `primaryComponentPaths`
 * when its `testGapPriority.medium` is omitted — the common case
 * being "any primary component without a matching test is MEDIUM
 * risk at minimum."
 */
export function allTestGapPriorityPaths(flags: DetectedStack['languages']): {
  critical: string[];
  high: string[];
  medium: string[];
} {
  const active = activeLanguagesFromFlags(flags);
  const critical = new Set<string>();
  const high = new Set<string>();
  const medium = new Set<string>();
  for (const pack of active) {
    const shape = pack.architecturalShape;
    if (!shape) continue;
    for (const p of shape.testGapPriority?.critical ?? []) critical.add(p);
    for (const p of shape.testGapPriority?.high ?? []) high.add(p);
    if (shape.testGapPriority?.medium && shape.testGapPriority.medium.length > 0) {
      for (const p of shape.testGapPriority.medium) medium.add(p);
    } else {
      // Default: primary components fall into MEDIUM when no explicit
      // bucket is declared. Lets packs declare just primaryComponentPaths
      // and get a sensible test-gap tiering for free.
      for (const p of shape.primaryComponentPaths ?? []) medium.add(p);
    }
  }
  return { critical: [...critical], high: [...high], medium: [...medium] };
}

/**
 * Pick the dominant vocabulary for prose rendering. When cloc data is
 * available, the pack with the most source lines wins — the
 * source-files-weighted heuristic plan v4 anchored to. When cloc
 * data isn't available, falls back to registry order. Returns null
 * when no active pack provides a vocabulary — callers fall through
 * to generic words ("components", "models", "routes").
 *
 * The cloc weight closes a polyglot-detection edge case: a
 * 3,000-file C# repo with one stray build-output `.py` file would
 * activate both csharp and python packs, and registry-order picked
 * python's vocabulary (first declared) despite csharp dominating by
 * 4 orders of magnitude. Source-line weighting picks the pack the
 * code is actually written in.
 */
export function dominantVocabulary(
  flags: DetectedStack['languages'],
  clocLanguages?: ReadonlyArray<{ name: string; lines: number }>,
): NonNullable<ArchitecturalShape['vocabulary']> | null {
  const active = activeLanguagesFromFlags(flags);
  const ranked =
    clocLanguages && clocLanguages.length > 0
      ? [...active].sort(
          (a, b) => countPackLines(b, clocLanguages) - countPackLines(a, clocLanguages),
        )
      : active;
  for (const pack of ranked) {
    const v = pack.architecturalShape?.vocabulary;
    if (v && (v.components || v.models || v.routes)) return v;
  }
  return null;
}

/**
 * Sum cloc-reported line counts for every language name this pack
 * claims to own. Returns 0 when the pack declares no cloc names or
 * none of them appear in the cloc summary — that pack contributes
 * no signal to the weighting and falls behind packs that did
 * produce real source lines.
 */
function countPackLines(
  pack: LanguageSupport,
  clocLanguages: ReadonlyArray<{ name: string; lines: number }>,
): number {
  const names = pack.clocLanguageNames ?? [];
  if (names.length === 0) return 0;
  let total = 0;
  for (const entry of clocLanguages) {
    if (names.includes(entry.name)) total += entry.lines;
  }
  return total;
}

/**
 * Split test-file patterns into the two shapes find treats differently:
 * basename patterns (matched via `-name`) and path-anchored patterns
 * (matched via `-path`). Pre-LP.3, generic.ts used only `-name` and
 * silently missed Rust's integration tests under the tests directory
 * because that pattern doesn't match a basename.
 */
export function splitTestFilePatterns(patterns: string[] = allTestFilePatterns()): {
  nameOnly: string[];
  pathAnchored: string[];
} {
  return {
    nameOnly: patterns.filter((p) => !p.includes('/')),
    pathAnchored: patterns.filter((p) => p.includes('/')),
  };
}

/**
 * Build the devcontainer `features` block for a given detected stack.
 * Returns a `{ [featureName]: opts }` map ready to serialize as the
 * value of `features` in `.devcontainer/devcontainer.json`.
 *
 * Always-on entries (Node — dxkit's own runtime; GitHub CLI) land
 * regardless of detected stack so the post-create script can run npm
 * and `gh` even on non-Node projects. Per-pack entries layer on top
 * via object-key dedup, so the typescript pack's node feature
 * overrides the always-on default (e.g. with a different version).
 *
 * Pre-Phase-2.5.1 the features block was a static JSON object that
 * unconditionally enabled every toolchain dxkit supports — pure-TS
 * repos still pulled .NET / Ruby / Java / Rust toolchains (~25 min
 * of unused image build). This helper drives a stack-aware generation
 * path that's testable in isolation.
 */
export function buildDevcontainerFeatures(
  flags: DetectedStack['languages'],
  cwd?: string,
): Record<string, Record<string, unknown>> {
  const features: Record<string, Record<string, unknown>> = {
    // Always-on: dxkit's own runtime + the gh CLI used by
    // setup-branch-protection / setup-prebuild / PR review.
    'ghcr.io/devcontainers/features/node:1': { version: '22', nvmVersion: 'latest' },
    'ghcr.io/devcontainers/features/github-cli:1': {},
  };
  for (const lang of activeLanguagesFromFlags(flags)) {
    if (lang.devcontainerFeature) {
      const opts = { ...(lang.devcontainerFeature.opts ?? {}) };
      // Provision the SDK the repo actually targets: override the feature's
      // `version` opt with the DETECTED version (never the default, so an
      // undetected repo keeps the declared opts byte-for-byte).
      const detected = cwd !== undefined ? lang.detectVersion?.(cwd) : undefined;
      if (detected && 'version' in opts) opts.version = detected;
      features[lang.devcontainerFeature.name] = opts;
    }
  }
  return features;
}

/**
 * Union the VSCode extensions across active language packs and the
 * always-on dxkit / GitHub baseline. Companion to
 * `buildDevcontainerFeatures` — features install the toolchain
 * (compiler / runtime); extensions drop the editor support (syntax,
 * lint, debug).
 *
 * Always-on extensions are anthropic.claude-code (Claude Code agent
 * surface — the six dxkit-* skills live under it), GitHub Actions +
 * Pull Requests (workflow + PR review skills target them). Per-pack
 * extensions come from `LanguageSupport.devcontainerExtensions`.
 *
 * Output is order-stable (always-on first, then per-pack in language
 * registration order) and deduplicated — a pack accidentally listing
 * an always-on extension, or two packs sharing one, can't generate
 * a duplicate entry. The renderer relies on stable order so unchanged
 * stacks produce byte-identical devcontainer.json output.
 *
 * Pre-extension the devcontainer.json template hardcoded the extensions
 * list with every language's extension. Pure-TS repos pulled the go,
 * rust, csharp, java, kotlin, ruby extensions on every container start
 * (~6 extensions for stacks that don't use those languages); this
 * helper trims to only the active packs' editor support.
 */
export function buildDevcontainerExtensions(flags: DetectedStack['languages']): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  // Always-on. Order matters here for output stability.
  add('anthropic.claude-code');
  add('github.vscode-github-actions');
  add('github.vscode-pull-request-github');

  for (const lang of activeLanguagesFromFlags(flags)) {
    for (const ext of lang.devcontainerExtensions ?? []) add(ext);
  }
  return out;
}
