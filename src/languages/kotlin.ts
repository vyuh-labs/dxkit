import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { gatherJaCoCoCoverageResult } from '../analyzers/tools/jacoco';
import { gatherOsvScannerDepVulnsResult } from '../analyzers/tools/osv-scanner-deps';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { fileExists, run } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { isAndroidGradleBuild, jvmCorrectnessProvider } from './jvm-build';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  RunTestsOutcome,
} from './capabilities/provider';
import type {
  CoverageResult,
  ImportsResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
  TestFrameworkResult,
} from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Walk the project tree (bounded depth) looking for a `.kt` or `.kts`
 * source file. Catches Kotlin projects that haven't yet adopted Gradle
 * (rare but possible for libraries vendored as plain `src/` trees) and
 * mixed JVM monorepos where Kotlin sits beside Java/Scala.
 */
function hasKotlinSource(cwd: string): boolean {
  // Depth-unlimited via the canonical walker. The previous depth-3
  // cap missed deep mixed-JVM monorepos. Honors `.gitignore` +
  // bundled excludes (`build`, `.gradle`, `target`, …).
  return walkPaths(cwd, { extensions: ['.kt', '.kts'] }).length > 0;
}

function detectKotlin(cwd: string): boolean {
  return (
    fileExists(cwd, 'build.gradle.kts') ||
    fileExists(cwd, 'settings.gradle.kts') ||
    fileExists(cwd, 'build.gradle') ||
    fileExists(cwd, 'settings.gradle') ||
    fileExists(cwd, 'gradlew') ||
    hasKotlinSource(cwd)
  );
}

/**
 * Manifest gate for capability providers. detectKotlin() activates the
 * pack on bare `.kt` source dirs too (no build manifest), but several
 * capabilities (depVulns, coverage) need a build-tool manifest to do
 * anything useful. This helper is the second-line check inside each
 * gather function — independent of detect() so providers fail cleanly
 * even if D010 (inactive-pack pollution) is later closed by stack-aware
 * `providersFor()`.
 */
function hasKotlinBuildManifest(cwd: string): boolean {
  return (
    fileExists(cwd, 'build.gradle.kts') ||
    fileExists(cwd, 'build.gradle') ||
    fileExists(cwd, 'settings.gradle.kts') ||
    fileExists(cwd, 'settings.gradle') ||
    fileExists(cwd, 'pom.xml') ||
    fileExists(cwd, 'gradle.lockfile')
  );
}

// ─── Lint (detekt) ──────────────────────────────────────────────────────────

/**
 * Map detekt's lowercased Severity enum to dxkit's four-tier scheme.
 * detekt 1.23+ emits `error|warning|info` (the `dev.detekt.api.Severity`
 * enum lowercased — see CheckstyleOutputReportSpec in detekt's repo).
 *
 * Tiering rationale (no source-of-truth from detekt — they don't tier):
 *   - error   → high     (detekt's authors classify as a real defect)
 *   - warning → medium   (style/maintainability concerns)
 *   - info    → low      (informational signals)
 *   - unknown → medium   (defensive default — never trust an empty string)
 *
 * detekt's older `Defect`/`Style`/`Maintainability`/etc. taxonomy was
 * collapsed in 1.23; we only need to recognise the lowercased modern
 * names. Any future taxonomy change shows up here as an unknown bucket
 * rather than silently miscounting.
 */
export function mapDetektSeverity(severity: string): LintSeverity {
  const s = severity.toLowerCase();
  if (s === 'error') return 'high';
  if (s === 'warning') return 'medium';
  if (s === 'info') return 'low';
  return 'medium';
}

/**
 * Pure parser for detekt's Checkstyle XML report. The format is fixed
 * (detekt's CheckstyleOutputReport renders verbatim per its 1.23 spec):
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <checkstyle version="4.3">
 *   <file name="src/main/Sample1.kt">
 *   <TAB><error line="11" column="1" severity="error" message="..." source="detekt.style/MagicNumber" />
 *   ...
 *   </file>
 *   </checkstyle>
 *
 * We tally `<error severity="...">` attribute values; we don't need the
 * full file/line index because the lint envelope only carries
 * SeverityCounts. Future enrichment (per-finding paths) would extend
 * the parser without breaking this signature.
 *
 * Exported for unit tests; consumed by `gatherKotlinLintResult`.
 */
export function parseDetektCheckstyleXml(raw: string): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  // Match each <error ...> element's severity attribute. `severity="X"`
  // is mandatory in detekt's renderer; we still default to 'medium' for
  // forward compat with hypothetical future detekt versions.
  const re = /<error\s+[^>]*severity="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    counts[mapDetektSeverity(m[1])]++;
  }
  return counts;
}

/**
 * Single source of truth for the kotlin pack's lint gathering.
 * Consumed by `kotlinLintProvider` (capability dispatcher).
 *
 * detekt is invoked with `--input <cwd>` to scan the whole project, and
 * `--report xml:<tmp>` to produce a parseable Checkstyle XML. Default
 * config is implicit; we don't pass `--build-upon-default-config` because
 * 1) it's the default since detekt 1.23, and 2) projects that ship a
 * `detekt.yml` get their own config respected automatically.
 *
 * Exit code: detekt exits 1 when issues are found and 2 on internal
 * errors. We tolerate any non-fatal exit by reading the XML regardless;
 * a missing/unparseable XML is treated as `unavailable`.
 */
function gatherKotlinLintResult(cwd: string): LintGatherOutcome {
  if (!hasKotlinBuildManifest(cwd) && !hasKotlinSource(cwd)) {
    return { kind: 'unavailable', reason: 'no kotlin source' };
  }
  const detekt = findTool(TOOL_DEFS.detekt, cwd);
  if (!detekt.available || !detekt.path) {
    return { kind: 'unavailable', reason: 'not installed' };
  }

  // detekt v1.23 cli supports `--report xml:<path>` only — no stdout
  // form. Use a process-unique temp file so concurrent dxkit runs don't
  // race on the same path.
  const tmpFile = path.join(os.tmpdir(), `dxkit-detekt-${process.pid}-${Date.now()}.xml`);
  try {
    run(`${detekt.path} --input . --report xml:${tmpFile}`, cwd, 120000);
    let raw: string;
    try {
      raw = fs.readFileSync(tmpFile, 'utf-8');
    } catch {
      return { kind: 'unavailable', reason: 'no detekt output' };
    }
    const counts = parseDetektCheckstyleXml(raw);
    const envelope: LintResult = { schemaVersion: 1, tool: 'detekt', counts };
    return { kind: 'success', envelope };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best-effort cleanup */
    }
  }
}

const kotlinLintProvider: CapabilityProvider<LintResult> = {
  source: 'kotlin',
  async gather(cwd) {
    const outcome = gatherKotlinLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

// ─── Coverage (JaCoCo XML) ──────────────────────────────────────────────────
//
// Parser, finder, and gather glue all live in `src/analyzers/tools/jacoco.ts`
// — language-agnostic SSOT (CLAUDE.md rule #2). The kotlin pack just
// declares its provider and delegates. Java pack does the same.

/**
 * Locate the JaCoCo XML report after a test run (D021). Gradle's
 * default emits to `build/reports/jacoco/test/jacocoTestReport.xml`,
 * Maven's to `target/site/jacoco/jacoco.xml`. The function-form
 * `artifact` param lets us check both; whichever path the build tool
 * wrote to is the one `gatherJaCoCoCoverageResult` will pick up on
 * the next dispatcher pass (it already knows both candidate paths).
 */
function findJacocoXmlArtifact(cwd: string): string | null {
  const candidates = [
    'build/reports/jacoco/test/jacocoTestReport.xml',
    'target/site/jacoco/jacoco.xml',
    'target/site/jacoco-aggregate/jacoco.xml',
  ];
  for (const c of candidates) {
    if (fileExists(cwd, c)) return c;
  }
  return null;
}

/**
 * Run the JVM build tool's "test + JaCoCo report" cycle from cwd (D021).
 *
 * Picks the command by build manifest, preferring Gradle when both are
 * present (modern Kotlin projects are Gradle-first; the Maven path is
 * here for fixture parity with the java pack and for the rare Kotlin-
 * on-Maven layouts seen in older codebases):
 *
 *   - `gradlew` or `build.gradle{,.kts}` → `./gradlew jacocoTestReport`
 *   - `pom.xml`                          → `mvn test jacoco:report`
 *
 * Preflight: require at least one of the above. Without a build
 * manifest, there's no canonical command to run.
 *
 * The JaCoCo plugin must be wired into the build (`apply plugin: 'jacoco'`
 * for Gradle, the `jacoco-maven-plugin` in `pom.xml` for Maven). When
 * it isn't, the command succeeds but no XML is produced — that surfaces
 * as `failed` with the helper's "tests succeeded but no coverage
 * artifact was produced" framing, which is the right hint.
 */
function runKotlinTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'kotlin',
      cmd: (() => {
        if (
          fileExists(cwd, 'gradlew') ||
          fileExists(cwd, 'build.gradle.kts') ||
          fileExists(cwd, 'build.gradle')
        ) {
          const gradle = fileExists(cwd, 'gradlew') ? './gradlew' : 'gradle';
          return `${gradle} jacocoTestReport`;
        }
        return 'mvn test jacoco:report';
      })(),
      cwd,
      artifact: (cwd) => findJacocoXmlArtifact(cwd),
      preflight: (cwd) => {
        const hasGradle =
          fileExists(cwd, 'build.gradle') ||
          fileExists(cwd, 'build.gradle.kts') ||
          fileExists(cwd, 'gradlew');
        const hasMaven = fileExists(cwd, 'pom.xml');
        if (!hasGradle && !hasMaven) {
          return 'no Gradle/Maven build manifest — cannot run JaCoCo coverage';
        }
        return null;
      },
    }),
  );
}

const kotlinCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'kotlin',
  async gather(cwd) {
    return gatherJaCoCoCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runKotlinTestsWithCoverage(cwd);
  },
};

// ─── DepVulns (osv-scanner against Maven manifests) ─────────────────────────
//
// Parser + gather glue live in `src/analyzers/tools/osv-scanner-deps.ts`
// — language-agnostic SSOT (CLAUDE.md rule #2). Kotlin/Java/Ruby packs
// all delegate to the same module, parameterized by ecosystem string +
// manifest candidate list. parseOsvScannerFindings is exported there
// for unit tests.

const KOTLIN_DEP_MANIFESTS = ['gradle.lockfile', 'pom.xml', 'gradle/verification-metadata.xml'];

const kotlinDepVulnsProvider: DepVulnsProvider = {
  source: 'kotlin',
  // The osv-scanner audit keys off KOTLIN_DEP_MANIFESTS, but a Gradle
  // dependency change shows up in the build scripts too — include them so the
  // incremental skip never misses a dep edit.
  manifestPatterns: [
    ...KOTLIN_DEP_MANIFESTS,
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
  ],
  async gather(cwd) {
    const outcome = await gatherOsvScannerDepVulnsResult(
      cwd,
      'kotlin',
      'Maven',
      KOTLIN_DEP_MANIFESTS,
    );
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherOsvScannerDepVulnsResult(cwd, 'kotlin', 'Maven', KOTLIN_DEP_MANIFESTS);
  },
};

// ─── Imports (regex extraction, no resolver) ────────────────────────────────

/**
 * Capture Kotlin import specifiers from source text. Handles both
 * `import com.foo.Bar` (single) and `import com.foo.*` (wildcard) plus
 * the `import com.foo.Bar as Baz` alias form. Comments are stripped
 * conservatively — single-line `//` and inline `/* ... *\/`. Multi-line
 * `/* ... *\/` blocks containing `import` statements are not extracted
 * (acceptable: comment-out-import is intentional non-use).
 *
 * Exported for unit tests; consumed by `gatherKotlinImportsResult`.
 */
export function extractKotlinImportsRaw(content: string): string[] {
  const out: string[] = [];
  // Strip line comments first so `// import foo` doesn't false-match.
  const stripped = content.replace(/\/\/[^\n]*/g, '');
  // `import` must start a statement (preceded only by whitespace at line
  // start). Trailing `as Alias` is captured but discarded.
  const re = /^\s*import\s+([A-Za-z_][\w.*]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Enumerate `.kt` / `.kts` files under cwd and capture per-file imports.
 * Kotlin packages don't 1:1 map to file paths (a package `com.foo` can
 * span many files in many directories), so we don't produce `edges` —
 * the resolution would be heuristic and is best left to graphify if
 * downstream consumers need it. Mirrors the rust pack's choice.
 */
function gatherKotlinImportsResult(cwd: string): ImportsResult | null {
  const files = walkSourceFiles(cwd, {
    extensions: ['.kt', '.kts'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    extracted.set(rel, extractKotlinImportsRaw(content));
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'kotlin-imports',
    sourceExtensions: ['.kt', '.kts'],
    extracted,
    edges: new Map(),
  };
}

const kotlinImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'kotlin',
  async gather(cwd) {
    return gatherKotlinImportsResult(cwd);
  },
};

// ─── Test framework (gradle dependency text scan) ───────────────────────────

/**
 * Detect the test framework by scanning gradle build files for known
 * dependency coordinates. Order of precedence: Kotest → Spek → JUnit
 * (Kotest/Spek typically sit alongside JUnit, and the more specific
 * framework is the "primary" runner).
 *
 * Returns null when no gradle file exists or no known runner is
 * declared — a polyglot Maven-only Kotlin project would skip this
 * cleanly (no false positive on `pom.xml` lookups, until a Kotlin/Maven
 * customer surfaces).
 */
function gatherKotlinTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  const gradleFiles = ['build.gradle.kts', 'build.gradle'];
  let combinedText = '';
  for (const rel of gradleFiles) {
    if (!fileExists(cwd, rel)) continue;
    try {
      combinedText += fs.readFileSync(path.join(cwd, rel), 'utf-8') + '\n';
    } catch {
      /* ignore unreadable */
    }
  }
  if (!combinedText) return null;
  if (combinedText.includes('io.kotest:')) {
    return { schemaVersion: 1, tool: 'kotlin', name: 'kotest' };
  }
  if (combinedText.includes('org.spekframework:') || combinedText.includes('spek-')) {
    return { schemaVersion: 1, tool: 'kotlin', name: 'spek' };
  }
  if (combinedText.includes('junit') || combinedText.includes('JUnit')) {
    return { schemaVersion: 1, tool: 'kotlin', name: 'junit' };
  }
  return null;
}

const kotlinTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'kotlin',
  async gather(cwd) {
    return gatherKotlinTestFrameworkResult(cwd);
  },
};

// ─── Correctness floor (Maven/Gradle compile + module-affected tests) ──────
//
// Shared with the java pack via `jvmCorrectnessProvider` (CLAUDE.md Rule 2).
// Kotlin contributes both source extensions (`.kt` for sources, `.kts` for
// build/scratch scripts). An Android Gradle build declines — its variant-
// specific `testDebugUnitTest` / `compileDebugKotlin` tasks aren't the standard
// `test`/`testClasses` the shared commands run, so CI (variant-aware) backstops.

const kotlinCorrectnessProvider = jvmCorrectnessProvider({
  sourceExtensions: ['.kt', '.kts'],
  declineWhen: isAndroidGradleBuild,
});

// ─── Pack export ────────────────────────────────────────────────────────────

export const kotlin: LanguageSupport = {
  id: 'kotlin',
  displayName: 'Kotlin (Android)',
  commentSyntax: { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' },

  // `.kts` covers both Gradle build scripts and Kotlin scratch files; the
  // dxkit analyzers treat them as first-class source so coverage and lint
  // reach build logic too. Java files in mixed Kotlin/Java codebases are
  // handled by the Java pack (when added) — not co-mingled here, to keep
  // attribution clean.
  sourceExtensions: ['.kt', '.kts'],

  // JUnit-style (*Test/*Tests) plus Spek/Kotest's `*Spec.kt` convention.
  testFilePatterns: ['*Test.kt', '*Tests.kt', '*Spec.kt'],

  // `build` = Gradle build output (per-project + per-module),
  // `.gradle` = Gradle daemon/cache state,
  // `out` = IntelliJ IDE build output.
  extraExcludes: ['build', '.gradle', 'out'],

  exportDetection: {
    reliability: 'full',
    strategy:
      'Public-by-default modifier semantics (no `private` / `internal` / `protected` keyword)',
  },

  // D027 (2.4.7): KDoc uses the JSDoc-style `/**` block opener.
  docCommentPatterns: ['/\\*\\*'],

  // D034 (2.4.7): JVM TLS-bypass idioms. Shared with the java pack
  // since Kotlin uses the same SSL APIs. Tokens are class/method
  // names that exist solely for permissive/insecure variants:
  //   - TrustAllX509TrustManager / NaiveTrustManager — custom
  //     "trust everything" implementations
  //   - NoopHostnameVerifier — Apache HttpClient's no-op verifier
  //   - ALLOW_ALL_HOSTNAME_VERIFIER — legacy SSLConnectionSocketFactory
  //     constant for accepting any hostname
  tlsBypassPatterns: [
    'TrustAllX509TrustManager',
    'NaiveTrustManager',
    'NoopHostnameVerifier',
    'ALLOW_ALL_HOSTNAME_VERIFIER',
  ],

  upgradeCommand(name, version) {
    return `# Edit build.gradle(.kts): bump ${name} to ${version}, then \`./gradlew build\``;
  },

  // Kotlin spans Spring Boot / Ktor server-side (controllers,
  // services, repositories) and Android client (activities,
  // fragments, viewmodels, screens). Both are first-class — an
  // Android app's primary surface IS its Activity / Fragment /
  // ViewModel layer, regardless of whether HTTP route handlers exist
  // anywhere in the codebase. routePaths narrows so the "Add API
  // documentation" action stays silent on a pure-Android project.
  architecturalShape: {
    primaryComponentPaths: [
      '/controllers/',
      '/services/',
      '/repositories/',
      '/handlers/',
      '/activities/',
      '/fragments/',
      '/viewmodels/',
      '/screens/',
      '/usecases/',
    ],
    routePaths: ['/controllers/', '/handlers/', '/routes/'],
    modelPaths: ['/models/', '/entities/', '/dto/', '/dtos/', '/data/'],
    vocabulary: {
      components: 'controllers/activities',
      models: 'models',
      routes: 'routes',
    },
    testGapPriority: {
      high: ['/controllers/', '/services/', '/handlers/', '/usecases/'],
      medium: ['/repositories/', '/activities/', '/fragments/', '/viewmodels/', '/screens/'],
    },
  },

  clocLanguageNames: ['Kotlin'],

  detect: detectKotlin,

  tools: ['detekt', 'osv-scanner'],

  // Semgrep's Kotlin ruleset (`p/kotlin`) is sparse compared to Python/JS
  // — skipping for now until coverage matures, mirroring the csharp pack.
  semgrepRulesets: [],
  // Kotlin uses CodeQL's `java` extractor (needs a build) and is beta
  // there; Snyk Code supports Kotlin.
  deepSast: {
    codeqlLanguage: 'java',
    codeqlBuildRequired: true,
    codeqlBeta: true,
    snykCode: true,
  },

  correctness: kotlinCorrectnessProvider,

  capabilities: {
    depVulns: kotlinDepVulnsProvider,
    lint: kotlinLintProvider,
    coverage: kotlinCoverageProvider,
    imports: kotlinImportsProvider,
    testFramework: kotlinTestFrameworkProvider,
    // licenses: deliberately omitted. No canonical CLI license tool for
    // Maven/Gradle equivalent to pip-licenses or cargo-license. Gradle
    // plugins (jk1.dependency-license-report) require modifying user's
    // build.gradle.kts which violates pack non-intrusiveness. Re-evaluate
    // if a customer surfaces the need.
  },

  mapLintSeverity: mapDetektSeverity,

  // ─── LP-recipe metadata ────────────────────────────────────────────────

  permissions: ['Bash(./gradlew:*)', 'Bash(gradle:*)', 'Bash(detekt:*)'],
  ruleFile: 'kotlin.md',
  cliBinaries: ['gradle', 'detekt'],
  defaultVersion: '2.0.21',
  // No first-party Kotlin devcontainer feature on ghcr.io/devcontainers
  // — the canonical Android/JVM tooling for a Kotlin project is a JDK
  // + Gradle, which the java feature provides. detekt installs via
  // TOOL_DEFS at post-create. When both java and kotlin packs are
  // active, object-key dedup unions cleanly (same feature key).
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/java:1',
    opts: { version: '17', installGradle: true },
  },
  devcontainerExtensions: ['fwcd.kotlin'],
};
