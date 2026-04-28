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
import { java, extractJavaImportsRaw } from '../src/languages/java';

describe('java pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(java.id).toBe('java');
    expect(java.displayName).toBe('Java');
  });

  it('wires imports + testFramework providers (10k.1.1)', () => {
    expect(java.capabilities?.imports).toBeDefined();
    expect(java.capabilities?.imports?.source).toBe('java');
    expect(java.capabilities?.testFramework).toBeDefined();
    expect(java.capabilities?.testFramework?.source).toBe('java');
  });

  it('does not yet wire depVulns/lint/coverage (10k.1.2-10k.1.4)', () => {
    // Capabilities are genuinely optional (Recipe v3 / G2). Asserting
    // these are undefined documents the staged-rollout intent — when
    // the corresponding 10k.1.x commit lands, this test flips.
    expect(java.capabilities?.depVulns).toBeUndefined();
    expect(java.capabilities?.lint).toBeUndefined();
    expect(java.capabilities?.coverage).toBeUndefined();
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

// ─── Parser test stubs — uncomment + fill in once each parser exists ───────
//
// describe('mapJavaSeverity', () => { ... })  // 10k.1.3 (PMD)
// describe('parseJavaLintOutput', () => { ... })  // 10k.1.3 (PMD JSON)
// describe('parseJavaCoverageOutput', () => { ... })  // 10k.1.2 (JaCoCo reuse)
// describe('parseJavaDepVulnsOutput', () => { ... })  // 10k.1.4 (osv-scanner)
