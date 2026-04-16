/**
 * Integration tests for the 5 analyzer entry points.
 *
 * Creates a minimal but realistic temp repo and runs each analyzer against
 * it. This exercises the full pipeline (detect → gather → score → format)
 * and gives coverage across many modules in a single pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

let tmp: string;

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmp, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-integ-'));

  // Init a real git repo (some analyzers need git)
  execSync('git init && git config user.email "test@test" && git config user.name "Test"', {
    cwd: tmp,
    stdio: 'pipe',
  });

  // package.json
  writeFile(
    'package.json',
    JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      scripts: { test: 'vitest', build: 'tsc', lint: 'eslint .' },
    }),
  );

  // Source files of varying size/type
  writeFile(
    'src/controllers/user.ts',
    `export class UserController {\n${Array(100).fill('  handle() { return "ok"; }').join('\n')}\n}\n`,
  );
  writeFile(
    'src/services/auth.ts',
    `export function verifyToken(t: string): boolean {\n  return t.length > 0;\n}\n`,
  );
  writeFile('src/models/user.ts', 'export interface User { id: number; name: string; }\n');
  writeFile('src/index.ts', 'export { UserController } from "./controllers/user";\n');
  writeFile(
    'src/utils/helpers.ts',
    `export function add(a: number, b: number) {\n  return a + b;\n}\n`,
  );

  // A large file (>500 lines) for maintainability scoring
  writeFile('src/big-file.ts', Array(600).fill('export const x = 1;').join('\n') + '\n');

  // Test files
  writeFile(
    'test/user.test.ts',
    'import { describe, it, expect } from "vitest";\ndescribe("user", () => { it("exists", () => { expect(true).toBe(true); }); });\n',
  );
  writeFile(
    'test/auth.test.ts',
    'import { describe, it } from "vitest";\ndescribe("auth", () => { it("works", () => {}); });\n',
  );

  // README
  writeFile('README.md', '# Test Project\n\nA test project.\n');

  // CI config
  writeFile(
    '.github/workflows/ci.yml',
    'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
  );

  // Docker
  writeFile('Dockerfile', 'FROM node:20\nCOPY . .\n');

  // .env.example
  writeFile('.env.example', 'DATABASE_URL=postgres://...\n');

  // Makefile
  writeFile('Makefile', 'build:\n\tnpm run build\n');

  // Initial commit so git log works
  execSync('git add -A && git commit -m "init"', { cwd: tmp, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('analyzeHealth', () => {
  it('produces a complete health report', async () => {
    const { analyzeHealth } = await import('../../src/analyzers/health');
    const report = analyzeHealth(tmp);

    expect(report.summary.overallScore).toBeGreaterThan(0);
    expect(report.summary.overallScore).toBeLessThanOrEqual(100);
    expect(report.summary.grade).toMatch(/^[A-F]$/);

    expect(report.dimensions.testing).toBeDefined();
    expect(report.dimensions.quality).toBeDefined();
    expect(report.dimensions.documentation).toBeDefined();
    expect(report.dimensions.security).toBeDefined();
    expect(report.dimensions.maintainability).toBeDefined();
    expect(report.dimensions.developerExperience).toBeDefined();

    for (const dim of Object.values(report.dimensions)) {
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
      expect(dim.status).toBeTruthy();
    }

    expect(report.toolsUsed.length).toBeGreaterThan(0);
    expect(report.toolsUsed).toContain('grep');
    expect(report.toolsUsed).toContain('find');
  });

  it('produces health report with metrics for --detailed', async () => {
    const { analyzeHealthWithMetrics } = await import('../../src/analyzers/health');
    const { report, metrics } = analyzeHealthWithMetrics(tmp);
    expect(report.summary.overallScore).toBeGreaterThan(0);
    expect(metrics).toBeDefined();
    expect(metrics!.sourceFiles).toBeGreaterThan(0);
    expect(metrics!.testFiles).toBeGreaterThan(0);
    expect(metrics!.readmeExists).toBe(true);
  });
});

describe('analyzeTestGaps', () => {
  it('produces a test gaps report', async () => {
    const { analyzeTestGaps } = await import('../../src/analyzers/tests');
    const report = analyzeTestGaps(tmp);

    expect(report.summary.sourceFiles).toBeGreaterThan(0);
    expect(report.summary.testFiles).toBeGreaterThan(0);
    expect(report.summary.activeTestFiles).toBeGreaterThan(0);
    expect(report.summary.effectiveCoverage).toBeGreaterThanOrEqual(0);
    expect(report.summary.effectiveCoverage).toBeLessThanOrEqual(100);
    expect(report.summary.coverageSource).toBeTruthy();
    expect(report.testFiles.length).toBeGreaterThan(0);
    expect(report.toolsUsed).toContain('find');
  });
});

describe('analyzeSecurity', () => {
  it('produces a security report', async () => {
    const { analyzeSecurity } = await import('../../src/analyzers/security');
    const report = analyzeSecurity(tmp);

    expect(report.summary).toBeDefined();
    expect(report.summary.findings).toBeDefined();
    expect(typeof report.summary.findings.total).toBe('number');
    expect(report.toolsUsed.length).toBeGreaterThan(0);
    expect(report.toolsUsed).toContain('find');
  });
});

describe('analyzeQuality', () => {
  it('produces a quality report with slop score', async () => {
    const { analyzeQuality } = await import('../../src/analyzers/quality');
    const report = analyzeQuality(tmp);

    expect(report.slopScore).toBeGreaterThanOrEqual(0);
    expect(report.slopScore).toBeLessThanOrEqual(100);
    expect(report.metrics).toBeDefined();
    expect(typeof report.metrics.lintErrors).toBe('number');
    expect(typeof report.metrics.consoleLogCount).toBe('number'); // slop-ok: testing console counting
    expect(report.toolsUsed.length).toBeGreaterThan(0);
  });
});

describe('analyzeDevActivity', () => {
  it('produces a developer activity report', async () => {
    const { analyzeDevActivity } = await import('../../src/analyzers/developer');
    const report = analyzeDevActivity(tmp);

    expect(report.summary.totalCommits).toBeGreaterThan(0);
    expect(report.summary.contributors).toBeGreaterThan(0);
    expect(report.toolsUsed).toContain('git');
    expect(report.period.since).toBeTruthy();
    expect(report.period.until).toBeTruthy();
  });
});

describe('formatters', () => {
  it('formatTestGapsReport produces valid markdown', async () => {
    const { analyzeTestGaps, formatTestGapsReport } = await import('../../src/analyzers/tests');
    const report = analyzeTestGaps(tmp);
    const md = formatTestGapsReport(report, '1.0');
    expect(md).toContain('# Test Gap');
    expect(md.length).toBeGreaterThan(100);
  });

  it('formatSecurityReport produces valid markdown', async () => {
    const { analyzeSecurity, formatSecurityReport } = await import('../../src/analyzers/security');
    const report = analyzeSecurity(tmp);
    const md = formatSecurityReport(report, '1.0');
    expect(md).toContain('Vulnerability');
    expect(md.length).toBeGreaterThan(100);
  });

  it('formatQualityReport produces valid markdown', async () => {
    const { analyzeQuality, formatQualityReport } = await import('../../src/analyzers/quality');
    const report = analyzeQuality(tmp);
    const md = formatQualityReport(report, '1.0');
    expect(md).toContain('Quality');
    expect(md.length).toBeGreaterThan(100);
  });

  it('formatDevReport produces valid markdown', async () => {
    const { analyzeDevActivity, formatDevReport } = await import('../../src/analyzers/developer');
    const report = analyzeDevActivity(tmp);
    const md = formatDevReport(report, '1.0');
    expect(md).toContain('Developer');
    expect(md.length).toBeGreaterThan(100);
  });
});
