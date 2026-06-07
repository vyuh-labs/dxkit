import * as fs from 'fs';
import * as path from 'path';

import { walkPaths } from '../analyzers/tools/walk-paths';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { gatherJaCoCoCoverageResult } from '../analyzers/tools/jacoco';
import { gatherOsvScannerDepVulnsResult } from '../analyzers/tools/osv-scanner-deps';
import { fileExists, run } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
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
 * Walk the project tree looking for a `.java` source file. Java's
 * standard layout (`src/main/java/com/example/...`) is much deeper
 * than Kotlin's `src/main/kotlin/`, so this walk uses a deeper bound
 * than the kotlin pack's depth-3 — package hierarchies of 4-5
 * segments are common in real-world Java projects. Stops short of
 * a full filesystem scan (build/, target/, .gradle/, node_modules/
 * are pruned).
 */
function hasJavaSource(cwd: string): boolean {
  // Depth-unlimited via the canonical walker. The previous depth-5
  // cap missed deep monorepos with multi-module Maven/Gradle layouts.
  return walkPaths(cwd, { extensions: ['.java'] }).length > 0;
}

/**
 * Java pack detection. Strict: requires evidence of actual Java SOURCE,
 * not just a JVM build manifest. `pom.xml` alone is NOT a Java signal —
 * Kotlin (incl. our own `test/fixtures/benchmarks/kotlin/pom.xml` for
 * osv-scanner) and Scala projects also ship Maven POMs. The two
 * unambiguous signals:
 *
 *   1. `src/main/java/` directory exists — the path itself is the
 *      Maven/Gradle convention for Java sources.
 *   2. A `.java` file lives within depth 5 of cwd (Java package
 *      hierarchies are routinely 4-5 segments under `src/`).
 *
 * Mixed Kotlin+Java projects (legacy Android migrations, polyglot
 * monorepos) activate BOTH packs — correct, the project genuinely is
 * both. Pure Kotlin/Scala/Groovy projects with `pom.xml` but no
 * `.java` source no longer false-trigger Java (10k.1.3 fix).
 */
function detectJava(cwd: string): boolean {
  // Standard Maven/Gradle Java layout — directory name is the signal.
  if (fs.existsSync(path.join(cwd, 'src', 'main', 'java'))) return true;
  // Otherwise require actual `.java` source presence.
  return hasJavaSource(cwd);
}

// ─── Imports (regex extraction, no resolver) ───────────────────────────────

/**
 * Extract `import com.foo.Bar;` paths from a Java source string. Handles:
 *   - regular imports:   `import com.foo.Bar;`
 *   - static imports:    `import static com.foo.Bar.method;`
 *   - wildcard imports:  `import com.foo.*;`
 * Strips line + block comments first so commented-out imports don't
 * false-match.
 *
 * Exported for unit tests; consumed by `gatherJavaImportsResult`.
 */
export function extractJavaImportsRaw(content: string): string[] {
  const out: string[] = [];
  // Strip block comments first (they may span multiple lines and contain
  // `import` text), then line comments.
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Match `import` at line start (after optional whitespace), optionally
  // `static`, then a dotted path with optional trailing `*`, then `;`.
  // The `as` aliasing Kotlin allows isn't valid Java syntax.
  const re = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Enumerate `.java` files under cwd and capture per-file imports. Java
 * package paths don't 1:1 map to filesystem paths in all build layouts
 * (a single package can span `src/main/java/com/foo/` *and*
 * `src/test/java/com/foo/`, plus IDE-generated extras), so we don't
 * produce `edges` — the resolution would be heuristic. Mirrors the
 * kotlin/rust pack choice.
 */
function gatherJavaImportsResult(cwd: string): ImportsResult | null {
  const files = walkSourceFiles(cwd, {
    extensions: ['.java'],
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
    extracted.set(rel, extractJavaImportsRaw(content));
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'java-imports',
    sourceExtensions: ['.java'],
    extracted,
    edges: new Map(),
  };
}

const javaImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'java',
  async gather(cwd) {
    return gatherJavaImportsResult(cwd);
  },
};

// ─── Test framework detection (build-file substring scan) ──────────────────

/**
 * Detect which test framework a Java project uses by scanning Maven and
 * Gradle build files for the canonical artifact substrings. Order of
 * preference matches what coexisting projects most likely standardize
 * on:
 *   - JUnit 5 (Jupiter) — modern default; `junit-jupiter` artifact
 *   - Spock — `org.spockframework` / `spock-core`
 *   - TestNG — `org.testng` / `:testng:`
 *   - JUnit 4 — `junit:junit` or any other `junit` mention as last
 *     resort, since `junit-jupiter` already matched JUnit 5
 *
 * Substring matching is intentional — same approach as the kotlin pack.
 * Robust to syntactic variation across pom.xml (XML <artifactId>) and
 * build.gradle{,.kts} (Groovy/Kotlin DSL string literals).
 */
function gatherJavaTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  const buildFiles = ['pom.xml', 'build.gradle.kts', 'build.gradle'];
  let combined = '';
  for (const rel of buildFiles) {
    if (!fileExists(cwd, rel)) continue;
    try {
      combined += fs.readFileSync(path.join(cwd, rel), 'utf-8') + '\n';
    } catch {
      /* ignore unreadable */
    }
  }
  if (!combined) return null;
  if (combined.includes('junit-jupiter')) {
    return { schemaVersion: 1, tool: 'java', name: 'junit5' };
  }
  if (combined.includes('org.spockframework') || combined.includes('spock-core')) {
    return { schemaVersion: 1, tool: 'java', name: 'spock' };
  }
  if (combined.includes('org.testng') || combined.includes(':testng:')) {
    return { schemaVersion: 1, tool: 'java', name: 'testng' };
  }
  if (combined.toLowerCase().includes('junit')) {
    return { schemaVersion: 1, tool: 'java', name: 'junit4' };
  }
  return null;
}

const javaTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'java',
  async gather(cwd) {
    return gatherJavaTestFrameworkResult(cwd);
  },
};

// ─── Lint (PMD JSON output) ────────────────────────────────────────────────

/**
 * Map PMD's 1-5 priority scale to dxkit's 4-tier severity. PMD's
 * priority semantics (per official docs):
 *   1 = High         → critical
 *   2 = Medium High  → high
 *   3 = Medium       → medium
 *   4 = Medium Low   → low
 *   5 = Low          → low
 *
 * Defensive: unknown / missing priorities tier as 'medium' — visibility
 * tilts toward "developer sees it" rather than "silently dropped". Same
 * defensive-default approach as detekt / mapDetektSeverity.
 *
 * Exported for unit tests.
 */
export function mapPmdRuleSeverity(priority: number | undefined | null): LintSeverity {
  if (priority === 1) return 'critical';
  if (priority === 2) return 'high';
  if (priority === 3) return 'medium';
  if (priority === 4 || priority === 5) return 'low';
  return 'medium';
}

/**
 * Parse PMD 7.x JSON output (`pmd check -f json`) into a tiered
 * SeverityCounts. Shape:
 *
 *   {
 *     "formatVersion": 0,
 *     "pmdVersion": "7.24.0",
 *     "files": [
 *       {
 *         "filename": "<path>",
 *         "violations": [
 *           {
 *             "beginline": N, "begincolumn": N,
 *             "endline": N, "endcolumn": N,
 *             "description": "...",
 *             "rule": "<ruleName>",
 *             "ruleset": "<rulesetCategory>",
 *             "priority": 1-5,
 *             "externalInfoUrl": "..."
 *           }
 *         ]
 *       }
 *     ],
 *     "suppressedViolations": [],
 *     "processingErrors": [],
 *     "configurationErrors": []
 *   }
 *
 * Tolerates malformed JSON (returns empty counts) and missing
 * `files`/`violations` arrays. Real-fixture tests live in
 * `test/languages-java.test.ts` against
 * `test/fixtures/raw/java/pmd-output.json`.
 *
 * Exported for unit tests; consumed by `gatherJavaLintResult`.
 */
export function parsePmdOutput(raw: string): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  let parsed: { files?: Array<{ violations?: Array<{ priority?: number }> }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return counts;
  }
  for (const file of parsed.files ?? []) {
    for (const v of file.violations ?? []) {
      counts[mapPmdRuleSeverity(v.priority)]++;
    }
  }
  return counts;
}

/**
 * Single source of truth for the java pack's lint gathering. Consumed
 * by `javaLintProvider`.
 *
 * PMD 7.x switched to subcommand syntax (`pmd check -d <dir> -R
 * <ruleset> -f <format>`). We use the built-in
 * `rulesets/java/quickstart.xml` — the curated subset PMD recommends
 * for general scanning across rule categories (Best Practices, Code
 * Style, Design, Documentation, Error Prone, Multithreading,
 * Performance, Security). Projects that ship their own
 * `pmd-ruleset.xml` aren't honored yet — Recipe v3 candidate if
 * customer-need surfaces.
 *
 * Exit codes: PMD exits 0 (no violations), 4 (violations found),
 * other (error). Our `run` helper captures stdout regardless of exit
 * code, so violations-found doesn't block parsing.
 */
function gatherJavaLintResult(cwd: string): LintGatherOutcome {
  // Activation gate — match detectJava (no pom.xml-alone trigger).
  if (!fs.existsSync(path.join(cwd, 'src', 'main', 'java')) && !hasJavaSource(cwd)) {
    return { kind: 'unavailable', reason: 'no java source' };
  }
  const pmd = findTool(TOOL_DEFS.pmd, cwd);
  if (!pmd.available || !pmd.path) {
    return { kind: 'unavailable', reason: 'not installed' };
  }
  const cmd = `${pmd.path} check -d . -R rulesets/java/quickstart.xml -f json`;
  const raw = run(cmd, cwd, 120000);
  if (!raw) return { kind: 'unavailable', reason: 'no pmd output' };
  const counts = parsePmdOutput(raw);
  const envelope: LintResult = { schemaVersion: 1, tool: 'pmd', counts };
  return { kind: 'success', envelope };
}

const javaLintProvider: CapabilityProvider<LintResult> = {
  source: 'java',
  async gather(cwd) {
    const outcome = gatherJavaLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

// ─── Coverage (JaCoCo XML — shared with kotlin pack) ───────────────────────
//
// Per CLAUDE.md rule #2 ("Each tool has ONE gather function"), the
// JaCoCo parser + locator + gather glue all live in
// `src/analyzers/tools/jacoco.ts`. Both kotlin and java packs delegate.
// Java's Maven paths (`target/site/jacoco/jacoco.xml`) and Gradle paths
// share the same candidate list because they're mutually exclusive on
// any given project root.

/**
 * Locate the JaCoCo XML report after a test run (D021). Same shape as
 * the kotlin pack's helper — Java codebases lean Maven-first, Kotlin
 * codebases Gradle-first, but the candidate paths are the same.
 */
function findJacocoXmlArtifact(cwd: string): string | null {
  const candidates = [
    'target/site/jacoco/jacoco.xml',
    'target/site/jacoco-aggregate/jacoco.xml',
    'build/reports/jacoco/test/jacocoTestReport.xml',
  ];
  for (const c of candidates) {
    if (fileExists(cwd, c)) return c;
  }
  return null;
}

/**
 * Run the JVM build tool's "test + JaCoCo report" cycle from cwd (D021).
 *
 * Picks the command by build manifest, preferring Maven when both are
 * present (Java codebases lean Maven-first; the Gradle path is here for
 * the increasingly common Java-on-Gradle projects):
 *
 *   - `pom.xml`                          → `mvn test jacoco:report`
 *   - `gradlew` or `build.gradle{,.kts}` → `./gradlew jacocoTestReport`
 *
 * Preflight + artifact discovery identical to the kotlin pack's shape.
 * The JaCoCo plugin must be wired into the build for the XML to be
 * emitted; without it the command succeeds but no artifact is produced
 * and the helper classifies as `failed`.
 */
function runJavaTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'java',
      cmd: (() => {
        if (fileExists(cwd, 'pom.xml')) {
          return 'mvn test jacoco:report';
        }
        const gradle = fileExists(cwd, 'gradlew') ? './gradlew' : 'gradle';
        return `${gradle} jacocoTestReport`;
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

const javaCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'java',
  async gather(cwd) {
    return gatherJaCoCoCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runJavaTestsWithCoverage(cwd);
  },
};

// ─── DepVulns (osv-scanner against Maven — shared with kotlin pack) ────────
//
// Same shape as coverage above — parser + manifest discovery + tool
// invocation + CVSS resolution all live in
// `src/analyzers/tools/osv-scanner-deps.ts` (extracted from kotlin
// pack in 10k.1.4 for SSOT, generalized to all ecosystems in 10k.2.6a).
// Java contributes the same Maven manifest candidates as kotlin:
// pom.xml, gradle.lockfile, gradle/verification-metadata.xml. Both
// packs pass the `'Maven'` ecosystem string for the OSV filter.

const JAVA_DEP_MANIFESTS = ['gradle.lockfile', 'pom.xml', 'gradle/verification-metadata.xml'];

const javaDepVulnsProvider: DepVulnsProvider = {
  source: 'java',
  async gather(cwd) {
    const outcome = await gatherOsvScannerDepVulnsResult(cwd, 'java', 'Maven', JAVA_DEP_MANIFESTS);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherOsvScannerDepVulnsResult(cwd, 'java', 'Maven', JAVA_DEP_MANIFESTS);
  },
};

// ─── Pack export ────────────────────────────────────────────────────────────

export const java: LanguageSupport = {
  id: 'java',
  displayName: 'Java',
  commentSyntax: { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' },

  sourceExtensions: ['.java'],

  // JUnit 4/5, TestNG, Spock all converge on these naming conventions.
  // *IT.java is the Maven Failsafe convention for integration tests.
  testFilePatterns: ['*Test.java', '*Tests.java', '*IT.java'],

  // Build artifact dirs across Maven (target), Gradle (build, .gradle,
  // out). Universal exclusions live in src/analyzers/tools/exclusions.ts.
  extraExcludes: ['target', 'build', '.gradle', 'out'],

  exportDetection: {
    reliability: 'full',
    strategy: '`public` access modifier on type and member declarations',
  },

  // D027 (2.4.7): Javadoc uses the `/**` block opener.
  docCommentPatterns: ['/\\*\\*'],

  // D034 (2.4.7): JVM TLS-bypass idioms (same set as the kotlin pack
  // — both share the underlying javax.net.ssl APIs). The tokens are
  // class/method names that exist solely for permissive variants;
  // false-positive rate is negligible.
  tlsBypassPatterns: [
    'TrustAllX509TrustManager',
    'NaiveTrustManager',
    'NoopHostnameVerifier',
    'ALLOW_ALL_HOSTNAME_VERIFIER',
  ],

  upgradeCommand(name, version) {
    return `# Edit pom.xml: bump ${name} <version>${version}</version>, then \`mvn install\``;
  },

  // Spring MVC / Spring Boot, JEE, Dropwizard, Micronaut, and the
  // classic Maven project layout (`src/main/java/<...>/controllers/`,
  // `src/main/java/<...>/services/`) converge on the same vocabulary —
  // controllers / services / repositories for backend, dao/daos for
  // legacy persistence layers, resources for JAX-RS REST endpoints.
  architecturalShape: {
    primaryComponentPaths: [
      '/controllers/',
      '/services/',
      '/repositories/',
      '/handlers/',
      '/dao/',
      '/daos/',
      '/resources/',
    ],
    routePaths: ['/controllers/', '/endpoints/', '/resources/', '/handlers/'],
    modelPaths: ['/models/', '/entities/', '/dto/', '/dtos/', '/domain/'],
    vocabulary: {
      components: 'controllers/services',
      models: 'entities',
      routes: 'endpoints',
    },
    testGapPriority: {
      high: ['/controllers/', '/services/', '/handlers/', '/resources/'],
      medium: ['/repositories/', '/dao/', '/daos/'],
    },
  },

  clocLanguageNames: ['Java'],

  detect: detectJava,

  tools: ['pmd', 'osv-scanner'],

  // Semgrep ships a Java ruleset under p/java.
  semgrepRulesets: ['p/java'],
  // CodeQL `java` extractor needs a build; Snyk Code supports Java.
  deepSast: { codeqlLanguage: 'java', codeqlBuildRequired: true, snykCode: true },

  capabilities: {
    imports: javaImportsProvider,
    testFramework: javaTestFrameworkProvider,
    coverage: javaCoverageProvider,
    lint: javaLintProvider,
    depVulns: javaDepVulnsProvider,
  },

  // ─── LP-recipe metadata ────────────────────────────────────────────────

  permissions: [
    'Bash(mvn:*)',
    'Bash(./gradlew:*)',
    'Bash(gradle:*)',
    'Bash(java:*)',
    'Bash(javac:*)',
  ],

  ruleFile: 'java.md',

  // doctor checks the runtime + build tool + linter. `java` is the
  // JVM runtime PMD/JaCoCo wrappers shell into; `mvn` is the dominant
  // build tool; `pmd` is the canonical linter wired in 10k.1.3.
  cliBinaries: ['java', 'mvn', 'pmd'],

  // Java 17 is current LTS as of 2026-04 with very wide deployment.
  defaultVersion: '17',
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/java:1',
    opts: { version: '17', installGradle: true },
  },
  devcontainerExtensions: ['redhat.java'],
};
