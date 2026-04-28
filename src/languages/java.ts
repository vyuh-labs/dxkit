import * as fs from 'fs';
import * as path from 'path';

import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { gatherJaCoCoCoverageResult } from '../analyzers/tools/jacoco';
import { gatherOsvScannerMavenDepVulnsResult } from '../analyzers/tools/osv-scanner-maven';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnResult,
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
function hasJavaSourceWithinDepth(cwd: string, maxDepth = 5): boolean {
  function search(dir: string, depth: number): boolean {
    if (depth > maxDepth) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (
        e.name.startsWith('.') ||
        ['node_modules', 'build', '.gradle', 'target', 'out'].includes(e.name)
      ) {
        continue;
      }
      if (e.isFile() && e.name.endsWith('.java')) return true;
      if (e.isDirectory() && search(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }
  return search(cwd, 0);
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
  return hasJavaSourceWithinDepth(cwd, 5);
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
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f -name "*.java" ${excludes} 2>/dev/null`, cwd);
  if (!raw) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    const rel = p.replace(/^\.\//, '');
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
  if (!fs.existsSync(path.join(cwd, 'src', 'main', 'java')) && !hasJavaSourceWithinDepth(cwd, 5)) {
    return { kind: 'unavailable', reason: 'no java source' };
  }
  const pmd = findTool(TOOL_DEFS.pmd, cwd);
  if (!pmd.available || !pmd.path) {
    return { kind: 'unavailable', reason: 'not installed' };
  }
  const cmd = `${pmd.path} check -d . -R rulesets/java/quickstart.xml -f json 2>/dev/null`;
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

const javaCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'java',
  async gather(cwd) {
    return gatherJaCoCoCoverageResult(cwd);
  },
};

// ─── DepVulns (osv-scanner against Maven — shared with kotlin pack) ────────
//
// Same shape as coverage above — parser + manifest discovery + tool
// invocation + CVSS resolution all live in
// `src/analyzers/tools/osv-scanner-maven.ts` (extracted from kotlin
// pack in 10k.1.4 for SSOT). Java contributes the same Maven manifest
// candidates (pom.xml, gradle.lockfile, gradle/verification-metadata.xml)
// — JVM ecosystem manifests are language-agnostic.

const javaDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'java',
  async gather(cwd) {
    const outcome = await gatherOsvScannerMavenDepVulnsResult(cwd, 'java');
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

// ─── Pack export ────────────────────────────────────────────────────────────

export const java: LanguageSupport = {
  id: 'java',
  displayName: 'Java',

  sourceExtensions: ['.java'],

  // JUnit 4/5, TestNG, Spock all converge on these naming conventions.
  // *IT.java is the Maven Failsafe convention for integration tests.
  testFilePatterns: ['*Test.java', '*Tests.java', '*IT.java'],

  // Build artifact dirs across Maven (target), Gradle (build, .gradle,
  // out). Universal exclusions live in src/analyzers/tools/exclusions.ts.
  extraExcludes: ['target', 'build', '.gradle', 'out'],

  detect: detectJava,

  tools: ['pmd', 'osv-scanner'],

  // Semgrep ships a Java ruleset under p/java.
  semgrepRulesets: ['p/java'],

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

  templateFiles: [],

  // doctor checks the runtime + build tool + linter. `java` is the
  // JVM runtime PMD/JaCoCo wrappers shell into; `mvn` is the dominant
  // build tool; `pmd` is the canonical linter wired in 10k.1.3.
  cliBinaries: ['java', 'mvn', 'pmd'],

  // Java 17 is current LTS as of 2026-04 with very wide deployment.
  defaultVersion: '17',

  projectYamlBlock: ({ config, enabled }) =>
    [
      `  java:`,
      `    enabled: ${enabled}`,
      `    version: "${config.versions['java' as keyof typeof config.versions] ?? '17'}"`,
    ].join('\n'),
};
