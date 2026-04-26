/**
 * Generic tool runner -- uses grep, find, wc, git.
 * Works on any Unix machine with no external dependencies.
 * This is Layer 0: always available.
 */
import * as fs from 'fs';
import { HealthMetrics } from '../types';
import { run, countLines, fileExists } from './runner';
import { getFindExcludeFlags } from './exclusions';
import { allSourceExtensions, splitTestFilePatterns } from '../../languages';

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

// Pack-driven find expressions (Phase 10i.0-LP.3). Replaces the
// pre-LP hardcoded extension/pattern lists with iteration over the
// language registry. Adding a 6th pack auto-extends both expressions.
//
// Behavior expansions vs pre-LP.3 (both more correct than before):
//   - `.mjs`/`.cjs` now counted as source files (TypeScript pack
//     declared them in `sourceExtensions`; the legacy hardcoded list
//     missed them).
//   - Rust integration tests under `tests/*.rs` now counted as test
//     files (Rust pack declared `tests/*.rs` as a path-anchored
//     pattern; the legacy used only `-name` and skipped path patterns).
const SOURCE_EXTS = `\\( ${allSourceExtensions()
  .map((e) => `-name "*${e}"`)
  .join(' -o ')} \\)`;

const TEST_PATTERNS = (() => {
  const { nameOnly, pathAnchored } = splitTestFilePatterns();
  const nameClauses = nameOnly.map((p) => `-name "${p}"`);
  const pathClauses = pathAnchored.map((p) => `-path "*/${p}"`);
  return `\\( ${[...nameClauses, ...pathClauses].join(' -o ')} \\)`;
})();

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

  // Security — secret scanning lives entirely under the SECRETS capability
  // (gitleaks, 800+ patterns). The 7-pattern grep fallback that used to
  // live here was deleted in Phase 10e.C.7 along with the legacy
  // `secretFindings` / `secretDetails` fields. When gitleaks is absent
  // the report surfaces that fact through `toolsUnavailable` and the
  // capability envelope is simply absent.
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
    toolsUsed: ['grep', 'find', 'wc', 'git'],
    toolsUnavailable: [],
  };
}
