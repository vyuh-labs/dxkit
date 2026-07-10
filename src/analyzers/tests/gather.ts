/**
 * Test gap gathering — find test files, source files, match them, classify risk.
 *
 * Tool responsibilities:
 *   find  → enumerate test files and source files
 *   grep  → check if test files have active assertions (not just comments)
 *   wc    → line counts for risk classification
 */
import * as fs from 'fs';
import * as path from 'path';
import { walkSourceFiles } from '../tools/walk-source-files';
import { allModelPaths, allPrimaryComponentPaths, allTestGapPriorityPaths } from '../../languages';
import type { DetectedStack } from '../../types';
import { TestFile, SourceFile, RiskTier } from './types';

// G_v4_7 (2.4.7): both gatherTestFiles and gatherSourceFiles route
// through walkSourceFiles. Pre-migration each had its own find
// composition with subtly different test-pattern matching, exclusion
// handling, and autogen filtering. ONE walker, ONE definition of
// "what counts as a source file" — closes D075 for the test-gaps
// gather path.

// Patterns for security-critical files (CRITICAL risk)
const CRITICAL_PATTERNS = [
  /auth/i,
  /jwt/i,
  /password/i,
  /rbac/i,
  /crypto/i,
  /encrypt/i,
  /sanitiz/i,
  /validat/i,
  /security/i,
  /session/i,
  /token/i,
  /oauth/i,
  /saml/i,
  /keycloak/i,
  /ldap/i,
  /permission/i,
];

// ─── Test file discovery ────────────────────────────────────────────────────

/**
 * A file under a fixtures / mocks / snapshots / testdata directory is test
 * SUPPORT — sample input, factory data, recorded output — NOT a test file. It
 * has no assertions by design, so a test-dir glob that swept it in would
 * classify it as a "degraded" test file (a false positive: dxkit's own analyzer
 * fixtures, and any user's `test/fixtures/**`, are not degraded tests). Matched
 * as a path SEGMENT (`.../fixtures/...`), covering the tool-recognized fixture
 * conventions across ecosystems: `__fixtures__` / `__mocks__` / `__snapshots__`
 * (jest) and `testdata/` (the Go toolchain itself ignores a `testdata` dir).
 */
const FIXTURE_SUPPORT_DIR = /(^|\/)(__)?(fixtures?|mocks?|snapshots?|testdata)(__)?\//i;
export function isFixtureSupportPath(relPath: string): boolean {
  return FIXTURE_SUPPORT_DIR.test(relPath.replace(/\\/g, '/'));
}

export function gatherTestFiles(cwd: string): TestFile[] {
  // Walker computes test-files as (includeTests:true SET) MINUS
  // (includeTests:false SET). Test-pattern derivation is pack-driven
  // via `allTestFilePatterns()`, so adding a new pack auto-extends.
  const allFiles = new Set(walkSourceFiles(cwd, { includeTests: true }));
  const nonTestFiles = new Set(walkSourceFiles(cwd));
  const testFiles: TestFile[] = [];
  for (const p of allFiles) {
    if (nonTestFiles.has(p)) continue;
    if (isFixtureSupportPath(p)) continue; // fixtures/mocks/snapshots are support, not tests
    const fullPath = path.join(cwd, p);
    testFiles.push({
      path: p,
      status: classifyTestFile(fullPath),
      framework: detectTestFramework(fullPath),
    });
  }
  return testFiles;
}

function classifyTestFile(fullPath: string): TestFile['status'] {
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return 'empty';
  }

  if (content.trim().length === 0) return 'empty';

  const lines = content.split('\n');
  const codeLines = lines.filter((l) => {
    const t = l.trim();
    return (
      t.length > 0 &&
      !t.startsWith('//') &&
      !t.startsWith('/*') &&
      !t.startsWith('*') &&
      !t.startsWith('#')
    );
  });

  // If >80% of non-empty lines are comments, it's commented out
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0 && codeLines.length / nonEmpty.length < 0.2) {
    return 'commented-out';
  }

  // Check for actual test assertions
  const hasAssertions =
    content.includes('describe(') ||
    content.includes('it(') ||
    content.includes('test(') ||
    content.includes('expect(') ||
    content.includes('assert') ||
    content.includes('def test_') ||
    content.includes('func Test');

  if (!hasAssertions) {
    // Could be a schema/type file named .spec.ts
    if (content.includes('export const') || content.includes('export interface')) {
      return 'schema-only';
    }
    return 'empty';
  }

  return 'active';
}

function detectTestFramework(fullPath: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8').slice(0, 2000); // first 2KB
  } catch {
    return null;
  }

  if (content.includes('vitest') || content.includes("from 'vitest'")) return 'vitest';
  if (content.includes('jest') || content.includes("from '@jest'")) return 'jest';
  if (content.includes('mocha') || content.includes("from '@loopback/testlab'")) return 'mocha';
  if (content.includes('pytest') || content.includes('def test_')) return 'pytest';
  if (content.includes('testing.T')) return 'go-test';
  return null;
}

// ─── Source file discovery + risk classification ────────────────────────────

/**
 * Convert an architectural-shape path pattern to a column-friendly
 * role label. `/Controllers/` → `"Controllers"`; `/app/controllers/`
 * → `"controllers"`; `/handlers/` → `"handlers"`. The last non-empty
 * path segment carries the role name across every shipped pack
 * contribution.
 */
function patternToLabel(pat: string): string {
  const parts = pat.split('/').filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? pat;
}

export function gatherSourceFiles(
  cwd: string,
  languageFlags?: DetectedStack['languages'],
): SourceFile[] {
  // Walker default opts apply all the filters the pre-migration
  // inline code did (and more):
  //   - exclusions via .gitignore + .dxkit-ignore + bundled defaults
  //     (covers node_modules, dist, *.d.ts, *.min.js)
  //   - autogen basename globs (*.designer.cs etc. — D028)
  //   - autogen header markers (<auto-generated>/@generated/DO NOT EDIT)
  //   - test files excluded (pack-driven test patterns — supersedes
  //     the old crude substring matchers .test/.spec/__tests__/_test/test_)
  //
  // The pre-migration inline `.swp/.pyc/.lic/.pem` filter is redundant
  // — none are source extensions, so the walker's extension filter
  // already drops them.
  const sources = walkSourceFiles(cwd);
  const flags = languageFlags ?? ({} as DetectedStack['languages']);
  const primaryPaths = allPrimaryComponentPaths(flags);
  const modelPaths = allModelPaths(flags);
  const taxonomy = allTestGapPriorityPaths(flags);

  const files: SourceFile[] = [];
  for (const p of sources) {
    const fullPath = path.join(cwd, p);
    let lines = 0;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      lines = content.split('\n').length;
    } catch {
      continue;
    }
    const type = classifyFileType(p, primaryPaths, modelPaths);
    const risk = classifyRisk(p, lines, taxonomy);
    files.push({
      path: p,
      lines,
      type,
      risk,
      hasMatchingTest: false, // filled in by matchTestsToSource
    });
  }
  return files;
}

/**
 * Tag a source file with a role label drawn from the first
 * architectural-shape pattern it matches. The matching uses a
 * leading-slash-anchored substring check so `"/controllers/"`
 * matches a directory boundary rather than any file whose name
 * happens to contain the word.
 *
 * Pre-extension this function held a hardcoded enum of backend
 * roles (`'controller' | 'service' | 'interceptor' | 'model' |
 * 'repository'`); a React component or .NET Form fell through to
 * `'other'` and lost its architectural context in the markdown
 * report. The label now comes from the matched pack pattern,
 * preserving stack-specific vocabulary in the rendered output.
 */
function classifyFileType(filePath: string, primaryPaths: string[], modelPaths: string[]): string {
  const anchored = ('/' + filePath).toLowerCase();
  for (const p of primaryPaths) {
    if (anchored.includes(p.toLowerCase())) return patternToLabel(p);
  }
  for (const p of modelPaths) {
    if (anchored.includes(p.toLowerCase())) return patternToLabel(p);
  }
  return 'other';
}

/**
 * Path prefixes for "meta-tools" — files that analyze security rather than
 * implement it. A file in `src/analyzers/security/` matches CRITICAL_PATTERNS
 * on name ("security") but it's an analyzer module, not app security code.
 * Downgrade these to their structural tier (usually LOW).
 */
const META_TOOL_PATH_PREFIXES = [/^src\/analyzers\//, /^tmp\//, /^scripts\//];

function classifyRisk(
  filePath: string,
  lines: number,
  taxonomy: { critical: string[]; high: string[]; medium: string[] },
): RiskTier {
  const lower = filePath.toLowerCase();
  const anchored = '/' + lower;

  // Meta-tool exception: security analyzer code matches CRITICAL_PATTERNS by
  // name alone (e.g. src/analyzers/security/gather.ts), but it's tooling, not
  // application security. Skip the pattern check so it falls through to the
  // size/type tiering below. Relative-path match — deliberately strict so we
  // don't accidentally downgrade real app code in an `analyzers` module.
  const isMetaTool = META_TOOL_PATH_PREFIXES.some((p) => p.test(filePath));

  // CRITICAL — pack-agnostic security regexes (auth/jwt/crypto/...) and
  // any pack-specific critical path the active stack declared.
  if (!isMetaTool && CRITICAL_PATTERNS.some((p) => p.test(lower))) return 'critical';
  if (!isMetaTool && taxonomy.critical.some((p) => anchored.includes(p.toLowerCase()))) {
    return 'critical';
  }

  // HIGH — large files sitting in a pack's high-priority path (typical
  // backend rule: large controllers/services). A small file in the same
  // directory falls through to MEDIUM, preserving the pre-extension
  // semantic that risk scales with file size for high-impact surfaces.
  const matchesHigh = taxonomy.high.some((p) => anchored.includes(p.toLowerCase()));
  if (matchesHigh && lines > 500) return 'high';
  if (matchesHigh) return 'medium';

  // MEDIUM — pack's medium-priority path (defaults to primaryComponentPaths
  // when the pack omits `testGapPriority.medium`).
  if (taxonomy.medium.some((p) => anchored.includes(p.toLowerCase()))) return 'medium';

  return 'low';
}

// ─── Match tests to source files ────────────────────────────────────────────

export function matchTestsToSource(testFiles: TestFile[], sourceFiles: SourceFile[]): void {
  // Build a set of tested source file basenames
  // e.g., "user.controller.acceptance.ts" → matches "user.controller.ts"
  const testedPatterns: string[] = [];
  for (const tf of testFiles) {
    if (tf.status !== 'active') continue;
    // Extract the base component name from the test file path
    const basename = tf.path.split('/').pop() || '';
    // Remove test markers to get the source name
    const sourceName = basename
      .replace('.test.', '.')
      .replace('.spec.', '.')
      .replace('.acceptance.', '.')
      .replace('_test.', '.')
      .replace('test_', '');
    testedPatterns.push(sourceName.toLowerCase());
  }

  for (const sf of sourceFiles) {
    const basename = (sf.path.split('/').pop() || '').toLowerCase();
    sf.hasMatchingTest = testedPatterns.some(
      (tp) =>
        basename.includes(tp.replace(/\.[^.]+$/, '')) ||
        tp.includes(basename.replace(/\.[^.]+$/, '')),
    );
  }
}
