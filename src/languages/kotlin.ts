import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { gatherJaCoCoCoverageResult } from '../analyzers/tools/jacoco';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import {
  classifyOsvSeverity,
  extractOsvCvssScore,
  resolveCvssScores,
  type OsvVuln,
} from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnFinding,
  DepVulnGatherOutcome,
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
 * Walk the project tree (bounded depth) looking for a `.kt` or `.kts`
 * source file. Catches Kotlin projects that haven't yet adopted Gradle
 * (rare but possible for libraries vendored as plain `src/` trees) and
 * mixed JVM monorepos where Kotlin sits beside Java/Scala.
 */
function hasKotlinSourceWithinDepth(cwd: string, maxDepth = 3): boolean {
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
        ['node_modules', 'build', '.gradle', 'target'].includes(e.name)
      ) {
        continue;
      }
      if (e.isFile() && (e.name.endsWith('.kt') || e.name.endsWith('.kts'))) return true;
      if (e.isDirectory() && search(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }
  return search(cwd, 0);
}

function detectKotlin(cwd: string): boolean {
  return (
    fileExists(cwd, 'build.gradle.kts') ||
    fileExists(cwd, 'settings.gradle.kts') ||
    fileExists(cwd, 'build.gradle') ||
    fileExists(cwd, 'settings.gradle') ||
    fileExists(cwd, 'gradlew') ||
    hasKotlinSourceWithinDepth(cwd, 3)
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
  if (!hasKotlinBuildManifest(cwd) && !hasKotlinSourceWithinDepth(cwd, 3)) {
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
    run(`${detekt.path} --input . --report xml:${tmpFile} 2>/dev/null`, cwd, 120000);
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

const kotlinCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'kotlin',
  async gather(cwd) {
    return gatherJaCoCoCoverageResult(cwd);
  },
};

// ─── DepVulns (osv-scanner against Maven manifests) ─────────────────────────

/** Per-package shape from osv-scanner v2.x JSON output. */
interface OsvScannerPackage {
  package: { name?: string; version?: string; ecosystem?: string };
  vulnerabilities?: OsvVuln[];
}

interface OsvScannerResult {
  source?: { path?: string; type?: string };
  packages?: OsvScannerPackage[];
}

interface OsvScannerOutput {
  results?: OsvScannerResult[];
}

/**
 * Pure parser for osv-scanner v2.x JSON output, scoped to Maven
 * findings only. Other ecosystems (npm, PyPI, Go) are filtered out so
 * polyglot repos don't double-count: the typescript pack handles npm,
 * the python pack handles PyPI, etc. The kotlin pack owns Maven.
 *
 * Returns counts + findings + the raw OSV vuln records for downstream
 * CVSS resolution. Exported for unit tests.
 */
export function parseOsvScannerMavenFindings(raw: string): {
  counts: SeverityCounts;
  findings: DepVulnFinding[];
  vulnsForCvss: Array<{ primaryId: string; embeddedCvss: number | null; aliases: string[] }>;
} {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings: DepVulnFinding[] = [];
  const vulnsForCvss: Array<{
    primaryId: string;
    embeddedCvss: number | null;
    aliases: string[];
  }> = [];
  let data: OsvScannerOutput;
  try {
    data = JSON.parse(raw) as OsvScannerOutput;
  } catch {
    return { counts, findings, vulnsForCvss };
  }
  // Dedup at the source: osv-scanner can list the same advisory twice
  // when a transitive dep is reachable through multiple top-level deps.
  // Same (package, version, id) → same fingerprint, so collapse here.
  const seen = new Set<string>();
  for (const result of data.results ?? []) {
    for (const pkg of result.packages ?? []) {
      if (pkg.package?.ecosystem !== 'Maven') continue;
      const pkgName = pkg.package.name ?? 'unknown';
      const pkgVersion = pkg.package.version;
      for (const vuln of pkg.vulnerabilities ?? []) {
        if (!vuln.id) continue;
        const dedupKey = `${pkgName}\0${pkgVersion ?? ''}\0${vuln.id}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const sev = classifyOsvSeverity(vuln);
        const tier: keyof SeverityCounts =
          sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low'
            ? sev
            : 'medium';
        counts[tier]++;

        const cvss = extractOsvCvssScore(vuln);
        const aliases = (vuln.aliases ?? []).filter((a) => a && a.length > 0);
        const finding: DepVulnFinding = {
          id: vuln.id,
          package: pkgName,
          installedVersion: pkgVersion,
          tool: 'osv-scanner',
          severity: tier,
        };
        if (cvss !== null) finding.cvssScore = cvss;
        if (aliases.length > 0) finding.aliases = aliases;
        if (vuln.summary) finding.summary = vuln.summary;
        // OSV.dev hosts a canonical page per id — synthesize when the
        // record's `references[]` is empty, otherwise keep the
        // tool-supplied URLs.
        const refUrls = (vuln.references ?? []).map((r) => r.url).filter((u): u is string => !!u);
        finding.references =
          refUrls.length > 0 ? refUrls : [`https://osv.dev/vulnerability/${vuln.id}`];
        findings.push(finding);

        vulnsForCvss.push({
          primaryId: vuln.id,
          embeddedCvss: cvss,
          aliases,
        });
      }
    }
  }
  return { counts, findings, vulnsForCvss };
}

/**
 * Single source of truth for the kotlin pack's dep-vuln gathering.
 * Consumed by `kotlinDepVulnsProvider` (capability dispatcher).
 *
 * Tool choice: osv-scanner is the established multi-ecosystem scanner;
 * no Tier-1 native equivalent exists for Maven/Gradle (CLAUDE.md rule
 * #5). osv-scanner-fix.ts in the typescript pack uses the `fix`
 * subcommand for upgrade planning — different mode, no shared logic.
 *
 * Manifest gating: osv-scanner reads `pom.xml`, `gradle.lockfile`,
 * `gradle/verification-metadata.xml`, and (limited) `build.gradle`. Bare
 * `build.gradle.kts` is NOT a reliable input — gradle.lockfile is
 * preferred. Without any of these, return `tool-missing` (matches
 * python/csharp's manifest-gating pattern).
 */
async function gatherKotlinDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  // Find the most reliable manifest. Order matters: lockfile > pom.xml
  // > verification-metadata. We pass it explicitly via --lockfile so
  // osv-scanner doesn't fall back to its (unreliable) build.gradle.kts
  // parser. Multi-module Android projects with per-module lockfiles
  // are not yet handled — first-module-found is the v1 behaviour;
  // future enhancement scoped to 10j.x recipe-gap.
  const manifestCandidates = ['gradle.lockfile', 'pom.xml', 'gradle/verification-metadata.xml'];
  let manifest: string | null = null;
  for (const rel of manifestCandidates) {
    if (fileExists(cwd, rel)) {
      manifest = rel;
      break;
    }
  }
  if (!manifest) return { kind: 'tool-missing' };

  const scanner = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!scanner.available || !scanner.path) return { kind: 'tool-missing' };

  // `scan source --lockfile <path>` is the v2.x form. JSON output to
  // stdout. Exit code is non-zero when findings exist — we ignore the
  // exit code and parse the JSON regardless (run() already swallows
  // non-zero exits cleanly via execSync's catch).
  const raw = run(
    `${scanner.path} scan source --lockfile ${manifest} --format json 2>/dev/null`,
    cwd,
    180000,
  );
  if (!raw) return { kind: 'no-output' };

  const { counts, findings, vulnsForCvss } = parseOsvScannerMavenFindings(raw);

  // CVSS alias-fallback: osv-scanner ships CVSS vectors when present,
  // but Maven advisories are inconsistent — some carry only
  // database_specific.severity strings. resolveCvssScores looks up via
  // CVE alias when the primary record lacks a vector.
  if (findings.length > 0) {
    const resolved = await resolveCvssScores(vulnsForCvss);
    for (const f of findings) {
      const score = resolved.get(f.id);
      if (score !== null && score !== undefined) f.cvssScore = score;
    }
  }

  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool: 'osv-scanner',
    enrichment: 'osv.dev',
    counts,
    findings,
  };
  return { kind: 'success', envelope };
}

const kotlinDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'kotlin',
  async gather(cwd) {
    const outcome = await gatherKotlinDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
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
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(
    `find . -type f \\( -name "*.kt" -o -name "*.kts" \\) ${excludes} 2>/dev/null`,
    cwd,
  );
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

// ─── Pack export ────────────────────────────────────────────────────────────

export const kotlin: LanguageSupport = {
  id: 'kotlin',
  displayName: 'Kotlin (Android)',

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

  detect: detectKotlin,

  tools: ['detekt', 'osv-scanner'],

  // Semgrep's Kotlin ruleset (`p/kotlin`) is sparse compared to Python/JS
  // — skipping for now until coverage matures, mirroring the csharp pack.
  semgrepRulesets: [],

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
  templateFiles: [],
  cliBinaries: ['gradle', 'detekt'],
  defaultVersion: '2.0.21',

  projectYamlBlock: ({ config, enabled }) =>
    [
      `  kotlin:`,
      `    enabled: ${enabled}`,
      `    version: "${config.versions.kotlin ?? ''}"`,
      `    quality:`,
      `      coverage: ${config.coverageThreshold}`,
      `      lint: true`,
      `      typecheck: true`,
      `      format: true`,
    ].join('\n'),
};
