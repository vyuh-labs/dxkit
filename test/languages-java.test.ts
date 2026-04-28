/**
 * Java pack — pack-specific tests.
 *
 * RECIPE NOTE: each PARSER OF OPAQUE TOOL OUTPUT (PMD JSON, JaCoCo XML,
 * osv-scanner JSON when 10k.1.2-.4 land) SHOULD be tested against a
 * REAL fixture file under `test/fixtures/raw/java/`, not synthetic
 * input. The C# defect lesson (5 months silent, parsers passed unit
 * tests on synthetic JSON but returned 0 findings on real input —
 * fixed in Phase 10h.6.8) is the reason. Capture commands live in
 * `test/fixtures/raw/java/HARVEST.md`.
 *
 * The tests below cover REGEX-OVER-SOURCE / SUBSTRING-OVER-BUILD-FILE
 * functions only — they're robust to formatter variation and the
 * synthetic-input trap doesn't apply. Real-fixture tests for the
 * remaining parsers ride alongside their providers when capabilities
 * land.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  java,
  extractJavaImportsRaw,
  mapPmdRuleSeverity,
  parsePmdOutput,
} from '../src/languages/java';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'java');
function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('detectJava — strict source-presence check (10k.1.3 regression)', () => {
  // 10k.1.3 surfaced: a permissive `pom.xml` check made detectJava
  // return true on Kotlin's benchmark fixture (which uses pom.xml for
  // osv-scanner), causing both kotlin AND java packs to activate and
  // joint-report `lintTool: 'detekt, pmd'`. Fixed: require either
  // `src/main/java/` path OR `.java` source presence.

  it('does NOT activate on a kotlin Maven project (pom.xml + .kt source, no .java)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-detect-'));
    try {
      fs.writeFileSync(path.join(dir, 'pom.xml'), '<project></project>');
      fs.writeFileSync(path.join(dir, 'Foo.kt'), 'class Foo');
      expect(java.detect(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('activates on src/main/java/ standard Maven/Gradle layout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-detect-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'main', 'java'), { recursive: true });
      expect(java.detect(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('activates on `.java` source within depth 5', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-detect-'));
    try {
      const deep = path.join(dir, 'a', 'b', 'c', 'd');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'Foo.java'), 'class Foo {}');
      expect(java.detect(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('activates on mixed Kotlin+Java project (both packs detect — correct)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-detect-'));
    try {
      fs.writeFileSync(path.join(dir, 'pom.xml'), '<project></project>');
      fs.writeFileSync(path.join(dir, 'Foo.kt'), 'class Foo');
      fs.writeFileSync(path.join(dir, 'Bar.java'), 'class Bar {}');
      expect(java.detect(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('java pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(java.id).toBe('java');
    expect(java.displayName).toBe('Java');
  });

  it('wires all 5 capability providers (10k.1.1-10k.1.4)', () => {
    expect(java.capabilities?.imports).toBeDefined();
    expect(java.capabilities?.imports?.source).toBe('java');
    expect(java.capabilities?.testFramework).toBeDefined();
    expect(java.capabilities?.testFramework?.source).toBe('java');
    expect(java.capabilities?.coverage).toBeDefined();
    expect(java.capabilities?.coverage?.source).toBe('java');
    expect(java.capabilities?.lint).toBeDefined();
    expect(java.capabilities?.lint?.source).toBe('java');
    expect(java.capabilities?.depVulns).toBeDefined();
    expect(java.capabilities?.depVulns?.source).toBe('java');
  });

  it('declares pmd + osv-scanner in tools[] (10k.1.3, 10k.1.4)', () => {
    expect(java.tools).toContain('pmd');
    expect(java.tools).toContain('osv-scanner');
  });
});

describe('extractJavaImportsRaw', () => {
  it('extracts a simple import', () => {
    const src = `package com.example;\n\nimport com.foo.Bar;\n\npublic class X {}\n`;
    expect(extractJavaImportsRaw(src)).toEqual(['com.foo.Bar']);
  });

  it('extracts multiple imports', () => {
    const src = [
      'package com.example;',
      '',
      'import com.foo.Bar;',
      'import com.foo.Baz;',
      'import java.util.List;',
      '',
      'public class X {}',
    ].join('\n');
    expect(extractJavaImportsRaw(src)).toEqual(['com.foo.Bar', 'com.foo.Baz', 'java.util.List']);
  });

  it('handles static imports', () => {
    const src =
      'import static com.foo.Bar.method;\nimport static java.util.Objects.requireNonNull;';
    expect(extractJavaImportsRaw(src)).toEqual([
      'com.foo.Bar.method',
      'java.util.Objects.requireNonNull',
    ]);
  });

  it('handles wildcard imports', () => {
    const src = 'import java.util.*;\nimport static com.foo.Bar.*;';
    expect(extractJavaImportsRaw(src)).toEqual(['java.util.*', 'com.foo.Bar.*']);
  });

  it('strips line comments before matching', () => {
    const src = '// import com.commented.Out;\nimport com.real.One;';
    expect(extractJavaImportsRaw(src)).toEqual(['com.real.One']);
  });

  it('strips block comments before matching', () => {
    const src = '/* import com.in.Block;\nimport com.also.In; */\nimport com.real.One;';
    expect(extractJavaImportsRaw(src)).toEqual(['com.real.One']);
  });

  it('returns empty array when source has no imports', () => {
    expect(extractJavaImportsRaw('public class X {}')).toEqual([]);
  });

  it('does not match imports inside string literals', () => {
    // Imperfect but acceptable: the regex requires `import` at line
    // start with only whitespace before, so a string `"import x;"`
    // mid-line in another statement won't match. Document this here
    // so it's a known property of the extractor.
    const src = 'public class X {\n  String s = "import com.in.String;";\n}';
    expect(extractJavaImportsRaw(src)).toEqual([]);
  });
});

describe('gatherJavaTestFrameworkResult — substring detection', () => {
  // Helper: write a fake project root with a pom.xml or build.gradle
  // and run java.capabilities.testFramework.gather() against it.
  async function gatherFor(buildFiles: Record<string, string>): Promise<unknown> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-tf-'));
    try {
      for (const [name, content] of Object.entries(buildFiles)) {
        fs.writeFileSync(path.join(dir, name), content);
      }
      return await java.capabilities!.testFramework!.gather(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('detects JUnit 5 from junit-jupiter dependency', async () => {
    const result = (await gatherFor({
      'pom.xml': `<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`,
    })) as { name: string };
    expect(result.name).toBe('junit5');
  });

  it('detects Spock from spockframework artifact', async () => {
    const result = (await gatherFor({
      'build.gradle': `dependencies { testImplementation 'org.spockframework:spock-core:2.3-groovy-3.0' }`,
    })) as { name: string };
    expect(result.name).toBe('spock');
  });

  it('detects TestNG from org.testng artifact', async () => {
    const result = (await gatherFor({
      'pom.xml': `<dependency><groupId>org.testng</groupId><artifactId>testng</artifactId></dependency>`,
    })) as { name: string };
    expect(result.name).toBe('testng');
  });

  it('detects JUnit 4 fallback when only `junit` substring is present', async () => {
    const result = (await gatherFor({
      'pom.xml': `<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency>`,
    })) as { name: string };
    expect(result.name).toBe('junit4');
  });

  it('prefers JUnit 5 over JUnit 4 when both are present (mixed-state migration)', async () => {
    const result = (await gatherFor({
      'pom.xml': `<dependency>junit-jupiter</dependency><dependency>junit:junit:4.13.2</dependency>`,
    })) as { name: string };
    expect(result.name).toBe('junit5');
  });

  it('returns null when no build files exist', async () => {
    const result = await gatherFor({});
    expect(result).toBeNull();
  });

  it('returns null when build files exist but mention no test framework', async () => {
    const result = await gatherFor({
      'pom.xml': `<project><dependencies><dependency>commons-lang3</dependency></dependencies></project>`,
    });
    expect(result).toBeNull();
  });

  it('reads build.gradle.kts when present', async () => {
    const result = (await gatherFor({
      'build.gradle.kts': `dependencies { testImplementation("org.junit.jupiter:junit-jupiter:5.10.0") }`,
    })) as { name: string };
    expect(result.name).toBe('junit5');
  });
});

describe('javaCoverageProvider — JaCoCo XML at Maven standard path', () => {
  // Java's JaCoCo coverage reuses the SHARED parser/finder/glue from
  // src/analyzers/tools/jacoco.ts (CLAUDE.md rule #2 — single source of
  // truth). The parser itself is validated extensively in
  // test/languages-kotlin.test.ts against both Kotlin and Java source
  // JaCoCo XML; this test specifically exercises the JAVA PACK's
  // wiring + Maven path discovery (`target/site/jacoco/jacoco.xml`)
  // that was added to the shared finder in 10k.1.2.

  const KOTLIN_FIXTURE = path.join(
    __dirname,
    'fixtures',
    'raw',
    'kotlin',
    'jacoco-java-source.xml',
  );

  it('discovers and parses jacoco.xml at target/site/jacoco/jacoco.xml (Maven default)', async () => {
    if (!fs.existsSync(KOTLIN_FIXTURE)) {
      // Defensive — fixture may have moved. Test fails loudly on real
      // bytes, not fixture-relocation ambiguity.
      throw new Error(
        `Expected JaCoCo Java-source fixture at ${KOTLIN_FIXTURE}; the kotlin pack uses it for the same SSOT validation.`,
      );
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-cov-'));
    try {
      // Lay out a Maven project with the standard JaCoCo report path.
      const reportDir = path.join(dir, 'target', 'site', 'jacoco');
      fs.mkdirSync(reportDir, { recursive: true });
      const xml = fs.readFileSync(KOTLIN_FIXTURE, 'utf-8');
      fs.writeFileSync(path.join(reportDir, 'jacoco.xml'), xml);

      const result = await java.capabilities!.coverage!.gather(dir);
      expect(result).not.toBeNull();
      expect(result!.tool).toBe('coverage:jacoco');
      // The shared parser populates the per-file coverage map; cardinality
      // depends on the fixture but should be > 0.
      expect(result!.coverage.files.size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no JaCoCo report exists under cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-java-cov-empty-'));
    try {
      const result = await java.capabilities!.coverage!.gather(dir);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mapPmdRuleSeverity', () => {
  it('maps priority 1 to critical', () => {
    expect(mapPmdRuleSeverity(1)).toBe('critical');
  });

  it('maps priority 2 to high', () => {
    expect(mapPmdRuleSeverity(2)).toBe('high');
  });

  it('maps priority 3 to medium', () => {
    expect(mapPmdRuleSeverity(3)).toBe('medium');
  });

  it('maps priorities 4 and 5 to low', () => {
    expect(mapPmdRuleSeverity(4)).toBe('low');
    expect(mapPmdRuleSeverity(5)).toBe('low');
  });

  it('defaults unknown / missing priority to medium (defensive)', () => {
    expect(mapPmdRuleSeverity(undefined)).toBe('medium');
    expect(mapPmdRuleSeverity(null)).toBe('medium');
    expect(mapPmdRuleSeverity(0)).toBe('medium');
    expect(mapPmdRuleSeverity(99)).toBe('medium');
  });
});

describe('parsePmdOutput — real PMD 7.24.0 fixture', () => {
  // Real-fixture-driven (the C# defect lesson — synthetic JSON drift
  // silently from real tool output). Captured 2026-04-28 from
  // `pmd check -d test/fixtures/benchmarks/java/BadLint.java -R
  // rulesets/java/quickstart.xml -f json`. See HARVEST.md.

  it('counts violations by tier from real PMD JSON output', () => {
    const raw = readFixture('pmd-output.json');
    const counts = parsePmdOutput(raw);
    // BadLint.java surfaces 3 violations under the quickstart ruleset
    // (UnnecessaryImport priority 4, NoPackage priority 3,
    // UncommentedEmptyMethodBody priority 3). All three are above-zero
    // signal — exact tier counts depend on PMD's per-rule priority
    // assignments, which can drift across PMD versions. Asserting
    // total count + that priorities tier into our 4-tier scheme is
    // the contract the parser owes; finer assertions would brittle
    // against PMD ruleset evolution.
    const total = counts.critical + counts.high + counts.medium + counts.low;
    expect(total).toBe(3);
    // At least one finding tiered as 'medium' (priority 3 — NoPackage,
    // UncommentedEmptyMethodBody) and at least one as 'low' (priority
    // 4 — UnnecessaryImport). Insulates from PMD's exact priority
    // shuffling without losing tier-distribution coverage.
    expect(counts.medium).toBeGreaterThan(0);
    expect(counts.low).toBeGreaterThan(0);
  });

  it('returns empty counts on malformed JSON', () => {
    expect(parsePmdOutput('not json')).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });

  it('returns empty counts when files array is missing', () => {
    expect(parsePmdOutput('{}')).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });

  it('returns empty counts when violations array is empty (clean run)', () => {
    expect(parsePmdOutput('{"files":[{"violations":[]}]}')).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
  });
});

// ─── Parser test stubs — uncomment + fill in once each parser exists ───────
//
// describe('parseJavaDepVulnsOutput', () => { ... })  // 10k.1.4 (osv-scanner)
