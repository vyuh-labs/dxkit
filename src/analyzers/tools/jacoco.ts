/**
 * JaCoCo XML report parser + standard-location finder. Shared across
 * JVM-language packs (kotlin, java) — single source of truth per
 * CLAUDE.md rule #2 ("Each tool has ONE gather function … if another
 * module needs that tool's output, it MUST call the existing
 * function").
 *
 * Extracted from `src/languages/kotlin.ts` in 10k.1.2 (Phase 10k.1
 * SSOT validation) — when the Java pack needed JaCoCo coverage, the
 * parser was already generic (kotlin's own tests cover it against
 * Java source, see test/languages-kotlin.test.ts). Forking would
 * have been the architectural violation; relocating to a shared
 * tool module is the correct outcome.
 */
import * as fs from 'fs';
import * as path from 'path';

import { type Coverage, type FileCoverage, round1 } from './coverage';
import type { CoverageResult } from '../../languages/capabilities/types';

/**
 * Pure parser for JaCoCo's XML report (DTD: `report.dtd`). The structure:
 *
 *   <report name="...">
 *     <package name="com/example">
 *       <class name="com/example/Foo" sourcefilename="Foo.kt">...</class>
 *       <sourcefile name="Foo.kt">
 *         <line nr="N" mi="..." ci="..." mb="..." cb="..."/>
 *         <counter type="LINE" missed="X" covered="Y"/>
 *       </sourcefile>
 *       <counter type="LINE" missed="X" covered="Y"/>
 *     </package>
 *     <counter type="LINE" missed="X" covered="Y"/>
 *   </report>
 *
 * Per-file coverage comes from `<sourcefile>` blocks: their LINE counter
 * holds the file's missed/covered totals. Project-level total comes from
 * the top-level `<counter type="LINE">` (last in the document).
 *
 * Path attribution joins `<package name>` (forward-slashed, JVM-style)
 * with `<sourcefile name>` to produce the canonical relative path the
 * downstream consumers expect (`com/example/Foo.kt` or
 * `com/example/Foo.java`). JVM bytecode namespacing isn't 1:1 with
 * on-disk source paths in multi-module projects — accepted limitation
 * (matches C#'s cobertura attribution).
 *
 * Returns null when no `<counter type="LINE">` exists at the top level
 * — that's JaCoCo's "no coverage data" signal, distinct from "0%
 * coverage" (where the counter exists with covered=0).
 *
 * Language-agnostic: works for Kotlin (.kt), Java (.java), and any
 * other JVM language whose JaCoCo output respects the `<package>` /
 * `<sourcefile>` shape — `<sourcefile name>` carries the on-disk
 * filename verbatim so the parser doesn't need to know the language.
 */
export function parseJaCoCoXml(raw: string, sourceFile: string, _cwd: string): Coverage | null {
  const files = new Map<string, FileCoverage>();
  // Iterate <package> blocks. Each block contains <sourcefile> children
  // we tally and aggregate counters we can ignore (they're sums of the
  // children, redundant given we sum the children ourselves).
  const packageRe = /<package\s+name="([^"]+)">([\s\S]*?)<\/package>/g;
  let pm: RegExpExecArray | null;
  while ((pm = packageRe.exec(raw)) !== null) {
    const pkgPath = pm[1].replace(/\\/g, '/'); // JVM uses forward-slashes already; defensive
    const pkgInner = pm[2];
    // Within a <package>, <sourcefile> blocks own per-file counters.
    const sourceFileRe = /<sourcefile\s+name="([^"]+)">([\s\S]*?)<\/sourcefile>/g;
    let sm: RegExpExecArray | null;
    while ((sm = sourceFileRe.exec(pkgInner)) !== null) {
      const fileName = sm[1];
      const sourceInner = sm[2];
      // The LAST <counter type="LINE"> in <sourcefile> is the
      // file-level aggregate; earlier ones are per-method. We pick the
      // last to get the full-file roll-up.
      const counterRe = /<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g;
      let lastMissed = 0;
      let lastCovered = 0;
      let cm: RegExpExecArray | null;
      while ((cm = counterRe.exec(sourceInner)) !== null) {
        lastMissed = parseInt(cm[1], 10);
        lastCovered = parseInt(cm[2], 10);
      }
      const total = lastMissed + lastCovered;
      const rel = pkgPath ? `${pkgPath}/${fileName}` : fileName;
      files.set(rel, {
        path: rel,
        covered: lastCovered,
        total,
        pct: round1(total > 0 ? (lastCovered / total) * 100 : 0),
      });
    }
  }

  // Top-level project-wide LINE counter — JaCoCo emits it after the
  // last </package>. Use a non-greedy match against the document tail
  // to avoid grabbing per-package counters as project-level.
  const tailMatch = raw.match(
    /<\/package>\s*<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>\s*<\/report>/,
  );
  let totalMissed = 0;
  let totalCovered = 0;
  if (tailMatch) {
    totalMissed = parseInt(tailMatch[1], 10);
    totalCovered = parseInt(tailMatch[2], 10);
  } else {
    // No project-level counter (degenerate report — single package, no
    // explicit roll-up). Sum the per-file totals as the linePercent
    // basis.
    for (const f of files.values()) {
      totalCovered += f.covered;
      totalMissed += f.total - f.covered;
    }
  }
  const grandTotal = totalCovered + totalMissed;
  if (grandTotal === 0 && files.size === 0) return null;

  return {
    source: 'jacoco',
    sourceFile,
    linePercent: round1(grandTotal > 0 ? (totalCovered / grandTotal) * 100 : 0),
    files,
  };
}

/**
 * Standard JaCoCo report locations across JVM build tools and project
 * layouts:
 *
 *   GRADLE (kotlin + java):
 *   - app/build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml
 *     (Android default — `app` module, `jacocoTestReport` task)
 *   - build/reports/jacoco/test/jacocoTestReport.xml
 *     (plain JVM via the `jacoco` plugin's default `test` task)
 *   - build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml
 *     (multi-module aggregate; many builds rename the task)
 *
 *   MAVEN (java):
 *   - target/site/jacoco/jacoco.xml
 *     (default Maven JaCoCo plugin — single-module Java)
 *   - target/site/jacoco-aggregate/jacoco.xml
 *     (Maven multi-module aggregate via jacoco-maven-plugin's
 *     `report-aggregate` goal)
 *
 *   FALLBACKS:
 *   - jacocoTestReport.xml (top-level — fixture / direct path)
 *   - jacoco.xml (top-level — Maven fixture / direct path)
 *
 * Returns the first existing path, relative to cwd. Conservative
 * priority: most specific build-tool conventions first, root
 * fallbacks last.
 */
export function findJaCoCoReport(cwd: string): string | null {
  const candidates = [
    // Gradle (Android + plain JVM)
    'app/build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml',
    'build/reports/jacoco/test/jacocoTestReport.xml',
    'build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml',
    // Maven (single-module + multi-module aggregate)
    'target/site/jacoco/jacoco.xml',
    'target/site/jacoco-aggregate/jacoco.xml',
    // Direct-path fallbacks (fixture / hand-placed)
    'jacocoTestReport.xml',
    'jacoco.xml',
  ];
  for (const rel of candidates) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) return rel;
  }
  return null;
}

/**
 * Locate + parse the JaCoCo XML report under cwd, wrap the result in a
 * `CoverageResult` envelope. Identical glue across JVM packs (kotlin,
 * java) — no language-specific dispatch needed because JaCoCo's
 * `<sourcefile name>` carries the on-disk filename verbatim and the
 * file extension survives intact through the parser. Both packs'
 * `coverageProvider.gather` should delegate here.
 */
export function gatherJaCoCoCoverageResult(cwd: string): CoverageResult | null {
  const reportRel = findJaCoCoReport(cwd);
  if (!reportRel) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, reportRel), 'utf-8');
  } catch {
    return null;
  }
  const coverage = parseJaCoCoXml(raw, reportRel, cwd);
  if (!coverage) return null;
  return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
}
