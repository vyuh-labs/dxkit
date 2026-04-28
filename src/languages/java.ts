import * as fs from 'fs';
import * as path from 'path';

import { fileExists } from '../analyzers/tools/runner';
import type { CapabilityProvider } from './capabilities/provider';
import type { DepVulnResult } from './capabilities/types';
import type { LanguageSupport } from './types';

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
 * Java pack detection. Conservative on Gradle (build.gradle.kts is
 * Kotlin DSL — typically Kotlin projects), aggressive on Maven and
 * the canonical `src/main/java/` layout. Mixed Kotlin+Java projects
 * activate both packs (correct — the project genuinely is both).
 */
function detectJava(cwd: string): boolean {
  // Maven manifest — unambiguously Java.
  if (fileExists(cwd, 'pom.xml')) return true;
  // Standard Maven/Gradle layout marker.
  if (fs.existsSync(path.join(cwd, 'src', 'main', 'java'))) return true;
  // Bare source — walk for `.java` files. We don't activate purely on
  // build.gradle / build.gradle.kts because Kotlin projects share
  // those manifests; presence of a `.java` file is the disambiguator.
  return hasJavaSourceWithinDepth(cwd, 5);
}

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

  // TODO(10k.1.x): tools and capabilities land in subsequent commits
  // as PMD lint, JaCoCo coverage (reusing kotlin's parser), osv-scanner
  // Maven dep-vuln, JUnit/TestNG test-framework detection are wired in.
  tools: [],

  // Semgrep ships a Java ruleset under p/java.
  semgrepRulesets: ['p/java'],

  // Stub depVulns provider — preserves the "every pack has a depVulns
  // provider" invariant asserted by `capabilities-contract.test.ts`
  // until the real osv-scanner Maven implementation lands in 10k.1.x.
  // Returns null until then; harmless on real projects (no findings
  // attributed to Java) and avoids a contract-test break for the
  // intermediate scaffold commit.
  capabilities: {
    depVulns: {
      source: 'java',
      async gather() {
        return null;
      },
    } as CapabilityProvider<DepVulnResult>,
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

  // doctor checks both build tools' presence; either is sufficient for
  // a real Java workflow.
  cliBinaries: ['java', 'mvn'],

  // Java 17 is current LTS as of 2026-04 with very wide deployment.
  defaultVersion: '17',

  projectYamlBlock: ({ config, enabled }) =>
    [
      `  java:`,
      `    enabled: ${enabled}`,
      `    version: "${config.versions['java' as keyof typeof config.versions] ?? '17'}"`,
    ].join('\n'),
};
