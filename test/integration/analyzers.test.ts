/**
 * Integration tests for the 5 analyzer entry points.
 *
 * Creates a minimal but realistic temp repo once, runs each analyzer once,
 * and shares the report across all assertions — both the "does the
 * analyzer return a valid report" tests and the formatter tests use the
 * same cached report. This avoids double-paying the gitleaks/jscpd/etc.
 * execution cost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { analyzeHealth, analyzeHealthWithMetrics } from '../../src/analyzers/health';
import { HealthReport, HealthMetrics } from '../../src/analyzers/types';
import { analyzeTestGaps, formatTestGapsReport } from '../../src/analyzers/tests';
import { TestGapsReport } from '../../src/analyzers/tests/types';
import { analyzeSecurity, formatSecurityReport } from '../../src/analyzers/security';
import { SecurityReport } from '../../src/analyzers/security/types';
import { analyzeQuality, formatQualityReport } from '../../src/analyzers/quality';
import { QualityReport } from '../../src/analyzers/quality/types';
import { analyzeDevActivity, formatDevReport } from '../../src/analyzers/developer';
import { DevReport } from '../../src/analyzers/developer/types';

let tmp: string;

// One run per analyzer, shared across all `it` blocks.
let healthReport: HealthReport;
let healthMetrics: HealthMetrics;
let testGapsReport: TestGapsReport;
let securityReport: SecurityReport;
let qualityReport: QualityReport;
let devReport: DevReport;

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

  writeFile('README.md', '# Test Project\n\nA test project.\n');
  writeFile(
    '.github/workflows/ci.yml',
    'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
  );
  writeFile('Dockerfile', 'FROM node:20\nCOPY . .\n');
  writeFile('.env.example', 'DATABASE_URL=postgres://...\n');
  writeFile('Makefile', 'build:\n\tnpm run build\n');

  execSync('git add -A && git commit -m "init"', { cwd: tmp, stdio: 'pipe' });

  // Run each analyzer ONCE. Subsequent tests read the cached result.
  // `analyzeHealthWithMetrics` gives us both the report and the metrics;
  // the plain report is identical, so one call covers both.
  const h = analyzeHealthWithMetrics(tmp);
  healthReport = h.report;
  healthMetrics = h.metrics;
  testGapsReport = analyzeTestGaps(tmp);
  securityReport = analyzeSecurity(tmp);
  qualityReport = analyzeQuality(tmp);
  devReport = analyzeDevActivity(tmp);
}, 120000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('analyzeHealth', () => {
  it('produces a complete health report', () => {
    expect(healthReport.summary.overallScore).toBeGreaterThan(0);
    expect(healthReport.summary.overallScore).toBeLessThanOrEqual(100);
    expect(healthReport.summary.grade).toMatch(/^[A-F]$/);

    expect(healthReport.dimensions.testing).toBeDefined();
    expect(healthReport.dimensions.quality).toBeDefined();
    expect(healthReport.dimensions.documentation).toBeDefined();
    expect(healthReport.dimensions.security).toBeDefined();
    expect(healthReport.dimensions.maintainability).toBeDefined();
    expect(healthReport.dimensions.developerExperience).toBeDefined();

    for (const dim of Object.values(healthReport.dimensions)) {
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(100);
      expect(dim.status).toBeTruthy();
    }

    expect(healthReport.toolsUsed.length).toBeGreaterThan(0);
    expect(healthReport.toolsUsed).toContain('grep');
    expect(healthReport.toolsUsed).toContain('find');
  });

  it('metrics struct has expected fields', () => {
    expect(healthMetrics).toBeDefined();
    expect(healthMetrics.sourceFiles).toBeGreaterThan(0);
    expect(healthMetrics.testFiles).toBeGreaterThan(0);
    expect(healthMetrics.readmeExists).toBe(true);
  });
});

describe('analyzeTestGaps', () => {
  it('produces a test gaps report', () => {
    expect(testGapsReport.summary.sourceFiles).toBeGreaterThan(0);
    expect(testGapsReport.summary.testFiles).toBeGreaterThan(0);
    expect(testGapsReport.summary.activeTestFiles).toBeGreaterThan(0);
    expect(testGapsReport.summary.effectiveCoverage).toBeGreaterThanOrEqual(0);
    expect(testGapsReport.summary.effectiveCoverage).toBeLessThanOrEqual(100);
    expect(testGapsReport.summary.coverageSource).toBeTruthy();
    expect(testGapsReport.testFiles.length).toBeGreaterThan(0);
    expect(testGapsReport.toolsUsed).toContain('find');
  });

  it('formatTestGapsReport produces valid markdown', () => {
    const md = formatTestGapsReport(testGapsReport, '1.0');
    expect(md).toContain('# Test Gap');
    expect(md.length).toBeGreaterThan(100);
  });
});

describe('analyzeSecurity', () => {
  it('produces a security report', () => {
    expect(securityReport.summary).toBeDefined();
    expect(securityReport.summary.findings).toBeDefined();
    expect(typeof securityReport.summary.findings.total).toBe('number');
    expect(securityReport.toolsUsed.length).toBeGreaterThan(0);
    expect(securityReport.toolsUsed).toContain('find');
  });

  it('formatSecurityReport produces valid markdown', () => {
    const md = formatSecurityReport(securityReport, '1.0');
    expect(md).toContain('Vulnerability');
    expect(md.length).toBeGreaterThan(100);
  });
});

describe('analyzeQuality', () => {
  it('produces a quality report with slop score', () => {
    expect(qualityReport.slopScore).toBeGreaterThanOrEqual(0);
    expect(qualityReport.slopScore).toBeLessThanOrEqual(100);
    expect(qualityReport.metrics).toBeDefined();
    expect(typeof qualityReport.metrics.lintErrors).toBe('number');
    expect(typeof qualityReport.metrics.consoleLogCount).toBe('number'); // slop-ok: testing console counting
    expect(qualityReport.toolsUsed.length).toBeGreaterThan(0);
  });

  it('formatQualityReport produces valid markdown', () => {
    const md = formatQualityReport(qualityReport, '1.0');
    expect(md).toContain('Quality');
    expect(md.length).toBeGreaterThan(100);
  });
});

describe('analyzeDevActivity', () => {
  it('produces a developer activity report', () => {
    expect(devReport.summary.totalCommits).toBeGreaterThan(0);
    expect(devReport.summary.contributors).toBeGreaterThan(0);
    expect(devReport.toolsUsed).toContain('git');
    expect(devReport.period.since).toBeTruthy();
    expect(devReport.period.until).toBeTruthy();
  });

  it('formatDevReport produces valid markdown', () => {
    const md = formatDevReport(devReport, '1.0');
    expect(md).toContain('Developer');
    expect(md.length).toBeGreaterThan(100);
  });
});
