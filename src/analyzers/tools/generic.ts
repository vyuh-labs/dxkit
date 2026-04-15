/**
 * Generic tool runner -- uses grep, find, wc, git.
 * Works on any Unix machine with no external dependencies.
 * This is Layer 0: always available.
 */
import * as fs from 'fs';
import { HealthMetrics } from '../types';
import { run, countLines, fileExists } from './runner';
import { getFindExcludeFlags } from './exclusions';

// grepCount uses a narrow filter (node_modules, dist, __pycache__, .d.ts) to
// preserve pre-refactor byte-equality. The broader EXCLUDED_DIRS list from
// exclusions.ts is used for find-based counts. Widening this filter would
// change legitimate metric totals and should be a separate, intentional change.
const GREP_PIPELINE_FILTER = 'grep -v node_modules | grep -v dist | grep -v __pycache__';

/** Reliable grep count that avoids shell escaping issues by writing pattern to a temp file. */
function grepCount(cwd: string, pattern: string, includes: string[]): number {
  const patternFile = `/tmp/dxkit-grep-${Date.now()}-${Math.random().toString(36).slice(2)}.pat`;
  fs.writeFileSync(patternFile, pattern);
  const includeFlags = includes.map((i) => `--include='${i}'`).join(' ');
  const result = run(
    `grep -rEf '${patternFile}' ${includeFlags} . 2>/dev/null | ${GREP_PIPELINE_FILTER} | grep -v '.d.ts' | wc -l`,
    cwd,
  );
  try {
    fs.unlinkSync(patternFile);
  } catch {
    /* ignore */
  }
  return parseInt(result) || 0;
}

// EXCLUDE moved inside gatherGenericMetrics() — must be computed per-cwd now
// so it picks up project-specific .gitignore / .dxkit-ignore entries.

const SOURCE_EXTS =
  '\\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" ' +
  '-o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.cs" \\)';

const TEST_PATTERNS =
  '\\( -name "*.test.*" -o -name "*.spec.*" -o -name "*_test.go" ' +
  '-o -name "test_*.py" -o -name "*Tests.cs" -o -name "*_test.rs" \\)';

/** Gather metrics using only built-in Unix tools. */
export function gatherGenericMetrics(cwd: string): Partial<HealthMetrics> {
  const EXCLUDE = getFindExcludeFlags(cwd);

  // File counts
  const sourceFiles = countLines(`find . -type f ${SOURCE_EXTS} ${EXCLUDE}`, cwd);
  const testFiles = countLines(`find . -type f ${TEST_PATTERNS} ${EXCLUDE}`, cwd);
  const testDirFiles = countLines(
    `find . -type f ${SOURCE_EXTS} ${EXCLUDE} \\( -path "*/__tests__/*" -o -path "*/tests/*" -o -path "*/test/*" \\) 2>/dev/null`,
    cwd,
  );

  // Total lines, largest file, files over 500 — single find+xargs wc pass
  const wcRaw = run(
    `find . -type f ${SOURCE_EXTS} ${EXCLUDE} -print0 2>/dev/null | xargs -0 wc -l 2>/dev/null`,
    cwd,
    120000,
  );

  let totalLines = 0;
  let largestFileLines = 0;
  let largestFilePath = '';
  let filesOver500Lines = 0;

  if (wcRaw) {
    for (const line of wcRaw.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const lines = parseInt(m[1]);
      const file = m[2];
      if (file === 'total') {
        totalLines = lines;
      } else {
        if (lines > largestFileLines) {
          largestFileLines = lines;
          largestFilePath = file;
        }
        if (lines > 500) filesOver500Lines++;
      }
    }
    // If only one file, xargs wc won't print "total"
    if (totalLines === 0 && largestFileLines > 0) totalLines = largestFileLines;
  }

  // Console/debug statement count -- use grepCount helper for reliability
  const jsConsoleCount = grepCount(cwd, 'console\\.(log|error|warn)', ['*.ts', '*.tsx', '*.js']);
  const pyPrintCount = grepCount(cwd, '\\bprint\\(', ['*.py']);
  const goPrintCount = grepCount(cwd, 'fmt\\.Print', ['*.go']);
  const consoleLogCount = jsConsoleCount + pyPrintCount + goPrintCount;

  // TypeScript ": any" count
  const anyTypeCount = grepCount(cwd, ': any', ['*.ts', '*.tsx']);

  // Documentation
  const readmeExists = fileExists(cwd, 'README.md', 'readme.md');
  const readmeLines = parseInt(run("wc -l README.md 2>/dev/null | awk '{print $1}'", cwd)) || 0;
  const docCommentFiles = countLines(
    "grep -rlE '/\\*\\*|^\"\"\"|^[[:space:]]*#[[:space:]]' --include='*.ts' --include='*.py' --include='*.go' . 2>/dev/null | grep -v node_modules | grep -v dist",
    cwd,
  );
  const apiDocsExist = fileExists(
    cwd,
    'openapi.json',
    'openapi.yaml',
    'swagger.json',
    'swagger.yaml',
  );
  const architectureDocsExist = fileExists(cwd, 'ARCHITECTURE.md', 'docs/', 'ADR/', 'adr/');
  const contributingExists = fileExists(cwd, 'CONTRIBUTING.md');
  const changelogExists = fileExists(cwd, 'CHANGELOG.md', 'CHANGES.md');

  // Security -- grep-based secret detection (Layer 0 fallback, overridden by gitleaks when available)
  const secretPatterns = [
    { pattern: 'password[[:space:]]*[:=]', rule: 'hardcoded-password' },
    { pattern: 'api[_-]?key[[:space:]]*[:=]', rule: 'hardcoded-api-key' },
    { pattern: 'secret[[:space:]]*[:=]', rule: 'hardcoded-secret' },
    { pattern: 'BEGIN.*PRIVATE KEY', rule: 'private-key-in-source' },
    { pattern: 'AKIA[0-9A-Z]{16}', rule: 'aws-access-key' },
    { pattern: 'ghp_[a-zA-Z0-9]{36}', rule: 'github-token' },
    { pattern: 'sk-ant-[a-zA-Z0-9]', rule: 'anthropic-api-key' },
  ];

  const secretDetails: HealthMetrics['secretDetails'] = [];
  for (const sp of secretPatterns) {
    const findings = run(
      `grep -rnE '${sp.pattern}' --include='*.ts' --include='*.js' --include='*.py' --include='*.go' . 2>/dev/null | grep -v node_modules | grep -v dist | grep -v '.d.ts' | head -20`,
      cwd,
    );
    for (const line of findings.split('\n').filter((l) => l.trim())) {
      const match = line.match(/^\.\/(.+?):(\d+):/);
      if (match) {
        secretDetails.push({
          file: match[1],
          line: parseInt(match[2]),
          rule: sp.rule,
          severity:
            sp.rule.includes('private-key') || sp.rule.includes('password') ? 'critical' : 'high',
        });
      }
    }
  }

  const evalCount =
    parseInt(
      run(
        "grep -rnE '\\beval\\(' --include='*.ts' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | grep -v dist | wc -l",
        cwd,
      ),
    ) || 0;

  const privateKeyFiles = countLines(
    `find . \\( -name "*.key" -o -name "*.pem" \\) ${EXCLUDE} 2>/dev/null`,
    cwd,
  );
  const envFilesInGit = countLines('git ls-files .env .env.* 2>/dev/null', cwd);
  const tlsDisabledCount =
    parseInt(
      run(
        "grep -rnE 'NODE_TLS_REJECT_UNAUTHORIZED.*0|rejectUnauthorized.*false|VERIFY_SSL.*false' --include='*.ts' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | wc -l",
        cwd,
      ),
    ) || 0;

  // Maintainability
  const controllers = countLines(
    `find . \\( -path "*/controllers/*" -name "*.ts" -o -path "*/handlers/*" -name "*.go" -o -path "*/views/*" -name "*.py" \\) ${EXCLUDE} 2>/dev/null`,
    cwd,
  );
  const models = countLines(
    `find . -path "*/models/*" -type f ${SOURCE_EXTS} ${EXCLUDE} 2>/dev/null`,
    cwd,
  );
  const directories = countLines(`find . -type d ${EXCLUDE} 2>/dev/null`, cwd);

  // Developer Experience
  const ciConfigCount = countLines(
    'find .github/workflows -name "*.yml" -o -name "*.yaml" 2>/dev/null; ls .gitlab-ci.yml Jenkinsfile .circleci/config.yml 2>/dev/null',
    cwd,
  );
  const dockerConfigCount = countLines(
    'ls Dockerfile docker-compose.yml docker-compose.yaml .devcontainer/devcontainer.json 2>/dev/null',
    cwd,
  );
  const precommitConfigCount = countLines(
    'ls -d .husky .pre-commit-config.yaml .git/hooks/pre-commit 2>/dev/null',
    cwd,
  );
  const makefileExists = fileExists(cwd, 'Makefile', 'justfile', 'Taskfile.yml');
  const envExampleExists = fileExists(cwd, '.env.example', '.env.sample', '.env.template');

  // Coverage config
  const coverageConfigExists = fileExists(
    cwd,
    '.nycrc',
    '.nycrc.json',
    '.c8rc',
    '.c8rc.json',
    'jest.config.js',
    'jest.config.ts',
    'vitest.config.ts',
    'vitest.config.js',
    '.coveragerc',
    'setup.cfg',
    'pytest.ini',
  );

  return {
    sourceFiles,
    testFiles: testFiles + testDirFiles,
    totalLines,
    coverageConfigExists,
    filesOver500Lines,
    largestFileLines,
    largestFilePath,
    consoleLogCount,
    anyTypeCount,
    readmeExists,
    readmeLines,
    docCommentFiles,
    apiDocsExist,
    architectureDocsExist,
    contributingExists,
    changelogExists,
    secretFindings: secretDetails.length,
    secretDetails,
    evalCount,
    privateKeyFiles,
    envFilesInGit,
    tlsDisabledCount,
    controllers,
    models,
    directories,
    ciConfigCount,
    dockerConfigCount,
    precommitConfigCount,
    makefileExists,
    envExampleExists,
    coveragePercent: null,
    toolsUsed: ['grep', 'find', 'wc', 'git'],
    toolsUnavailable: [],
  };
}
