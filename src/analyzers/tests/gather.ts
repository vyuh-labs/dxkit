/**
 * Test gap gathering — find test files, source files, match them, classify risk.
 *
 * Tool responsibilities:
 *   find  → enumerate test files and source files
 *   grep  → check if test files have active assertions (not just comments)
 *   wc    → line counts for risk classification
 */
import * as fs from 'fs';
import { run } from '../tools/runner';
import { getFindExcludeFlags } from '../tools/exclusions';
import { TestFile, SourceFile, RiskTier } from './types';

// EXCLUDE is computed per-cwd inside each gather function to honor
// project-specific .gitignore / .dxkit-ignore entries.

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

export function gatherTestFiles(cwd: string): TestFile[] {
  const EXCLUDE = getFindExcludeFlags(cwd);
  // Find test files by naming convention
  const testPatterns =
    '\\( -name "*.test.*" -o -name "*.spec.*" -o -name "*_test.*" -o -name "test_*" \\)';
  const raw = run(`find . -type f ${testPatterns} ${EXCLUDE} 2>/dev/null`, cwd);
  if (!raw) return [];

  // Also check __tests__/ directories
  const testDirRaw = run(
    `find . -type f -path "*/__tests__/*" -name "*.ts" -o -path "*/__tests__/*" -name "*.js" -o -path "*/__tests__/*" -name "*.py" 2>/dev/null | grep -v node_modules | grep -v dist`,
    cwd,
  );

  const allPaths = new Set<string>();
  for (const line of (raw + '\n' + (testDirRaw || '')).split('\n')) {
    const p = line.trim();
    if (p && !p.includes('node_modules') && !p.includes('/dist/')) {
      allPaths.add(p.replace('./', ''));
    }
  }

  const testFiles: TestFile[] = [];
  for (const p of allPaths) {
    const fullPath = `${cwd}/${p}`;
    const status = classifyTestFile(fullPath);
    const framework = detectTestFramework(fullPath);
    testFiles.push({ path: p, status, framework });
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

export function gatherSourceFiles(cwd: string): SourceFile[] {
  const EXCLUDE = getFindExcludeFlags(cwd);
  const SOURCE_EXTS =
    '\\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" ' +
    '-o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.cs" \\)';

  const raw = run(`find . -type f ${SOURCE_EXTS} ${EXCLUDE} 2>/dev/null`, cwd);
  if (!raw) return [];

  const files: SourceFile[] = [];
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    // Skip test files themselves
    if (
      p.includes('.test.') ||
      p.includes('.spec.') ||
      p.includes('__tests__') ||
      p.includes('_test.') ||
      p.includes('test_')
    )
      continue;
    // Skip type definition files
    if (p.endsWith('.d.ts')) continue;

    const fullPath = `${cwd}/${p.replace('./', '')}`;
    let lines = 0;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      lines = content.split('\n').length;
    } catch {
      continue;
    }

    const cleanPath = p.replace('./', '');
    const type = classifyFileType(cleanPath);
    const risk = classifyRisk(cleanPath, type, lines);

    files.push({
      path: cleanPath,
      lines,
      type,
      risk,
      hasMatchingTest: false, // filled in by matchTestsToSource
    });
  }

  return files;
}

function classifyFileType(filePath: string): SourceFile['type'] {
  const lower = filePath.toLowerCase();
  if (lower.includes('/controllers/') || lower.includes('/handlers/')) return 'controller';
  if (lower.includes('/services/')) return 'service';
  if (lower.includes('/interceptors/') || lower.includes('/middleware/')) return 'interceptor';
  if (lower.includes('/models/')) return 'model';
  if (lower.includes('/repositories/')) return 'repository';
  return 'other';
}

function classifyRisk(filePath: string, type: SourceFile['type'], lines: number): RiskTier {
  const lower = filePath.toLowerCase();

  // Security-critical files are always CRITICAL regardless of size
  if (CRITICAL_PATTERNS.some((p) => p.test(lower))) return 'critical';

  // Large controllers/services are HIGH
  if ((type === 'controller' || type === 'service') && lines > 500) return 'high';

  // Normal controllers/services/interceptors are MEDIUM
  if (type === 'controller' || type === 'service' || type === 'interceptor') return 'medium';

  // Everything else is LOW
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
