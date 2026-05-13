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

/**
 * Resolve the git toplevel for `cwd`. D026 (2.4.7): cross-cutting repo
 * artifacts (`.github/`, `README.md`, `CONTRIBUTING.md`, `Makefile`,
 * `.env.example`, etc.) conventionally live at the repo root, not in
 * the subdirectory a user happens to scan. dpl-studio's baseline F8:
 * customer ran `dxkit health Code/Source/`; both Documentation and DX
 * dimensions returned 0/100 because none of those probes found
 * matches in `Code/Source/`. The fix scopes those probes to the
 * git toplevel.
 *
 * Returns `cwd` unchanged when `git rev-parse --show-toplevel` fails
 * (not in a git repo, or git missing) so non-git workflows keep
 * working — they just don't get the toplevel-scoped improvement.
 */
function resolveGitToplevel(cwd: string): string {
  const top = run('git rev-parse --show-toplevel 2>/dev/null', cwd).trim();
  return top.length > 0 ? top : cwd;
}

/** Gather metrics using only built-in Unix tools. */
export function gatherGenericMetrics(cwd: string): Partial<HealthMetrics> {
  const EXCLUDE = getFindExcludeFlags(cwd);
  // D026 (2.4.7): repo-level artifacts probed from git toplevel; code-
  // level metrics (source-file counts, hygiene grep, semgrep) stay
  // scoped to `cwd` so analyzing a subdirectory still measures that
  // subdir's code quality.
  const repoRoot = resolveGitToplevel(cwd);

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

  // Documentation — D026 (2.4.7): probe from repo root, not from cwd.
  // dpl-studio's `Code/Source/` doesn't have README.md/etc.; the repo
  // root does. docCommentFiles stays cwd-scoped because it counts
  // source-file doc-comment density inside whatever subtree the user
  // chose to analyze.
  const readmeExists = fileExists(repoRoot, 'README.md', 'readme.md');
  const readmeLines =
    parseInt(run("wc -l README.md 2>/dev/null | awk '{print $1}'", repoRoot)) || 0;
  // prettier-ignore
  const docCommentCmd = "grep -rlE '/\\*\\*|^\"\"\"|^[[:space:]]*#[[:space:]]' --include='*.ts' --include='*.py' --include='*.go' . 2>/dev/null | grep -v node_modules | grep -v dist"; // lp-recipe-ok: see D027 — doc-comment heuristic is JS-shaped; per-language patterns land with 2.4.8 doc-comment refactor
  const docCommentFiles = countLines(docCommentCmd, cwd);
  const apiDocsExist = fileExists(
    repoRoot,
    'openapi.json',
    'openapi.yaml',
    'swagger.json',
    'swagger.yaml',
  );
  const architectureDocsExist = fileExists(repoRoot, 'ARCHITECTURE.md', 'docs/', 'ADR/', 'adr/');
  const contributingExists = fileExists(repoRoot, 'CONTRIBUTING.md');
  const changelogExists = fileExists(repoRoot, 'CHANGELOG.md', 'CHANGES.md');

  // Security — secret scanning lives entirely under the SECRETS capability
  // (gitleaks, 800+ patterns). The 7-pattern grep fallback that used to
  // live here was deleted in Phase 10e.C.7 along with the legacy
  // `secretFindings` / `secretDetails` fields. When gitleaks is absent
  // the report surfaces that fact through `toolsUnavailable` and the
  // capability envelope is simply absent.
  // prettier-ignore
  const evalCountCmd = "grep -rnE '\\beval\\(' --include='*.ts' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | grep -v dist | wc -l"; // lp-recipe-ok: see D033 — eval() is JS/Py-affinity; Rust/Java/Kotlin/C# need separate per-pattern language scoping
  const evalCount = parseInt(run(evalCountCmd, cwd)) || 0;

  const privateKeyFiles = countLines(
    `find . \\( -name "*.key" -o -name "*.pem" \\) ${EXCLUDE} 2>/dev/null`,
    cwd,
  );
  const envFilesInGit = countLines('git ls-files .env .env.* 2>/dev/null', cwd);
  // prettier-ignore
  const tlsDisabledCmd = "grep -rnE 'NODE_TLS_REJECT_UNAUTHORIZED.*0|rejectUnauthorized.*false|VERIFY_SSL.*false' --include='*.ts' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | wc -l"; // lp-recipe-ok: see D034 — each TLS-bypass pattern is ecosystem-specific (Node, JS-anywhere, Python)
  const tlsDisabledCount = parseInt(run(tlsDisabledCmd, cwd)) || 0;

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

  // Developer Experience — D026 (2.4.7): probe repo root. CI/Docker/
  // pre-commit/Makefile/env-example conventionally live at the repo
  // root. dpl-studio: pre-D026 these all returned 0 when run from
  // `Code/Source/` because `.github/workflows/` etc. live one level up.
  const ciConfigCount = countLines(
    'find .github/workflows -name "*.yml" -o -name "*.yaml" 2>/dev/null; ls .gitlab-ci.yml Jenkinsfile .circleci/config.yml 2>/dev/null',
    repoRoot,
  );
  const dockerConfigCount = countLines(
    'ls Dockerfile docker-compose.yml docker-compose.yaml .devcontainer/devcontainer.json 2>/dev/null',
    repoRoot,
  );
  const precommitConfigCount = countLines(
    'ls -d .husky .pre-commit-config.yaml .git/hooks/pre-commit 2>/dev/null',
    repoRoot,
  );
  const makefileExists = fileExists(repoRoot, 'Makefile', 'justfile', 'Taskfile.yml');
  const envExampleExists = fileExists(repoRoot, '.env.example', '.env.sample', '.env.template');

  // Coverage config — D026 (2.4.7): also repo-root-scoped. Most test
  // runners look for these at the project root; scanning a subdirectory
  // shouldn't make dxkit forget the test setup exists at the top.
  const coverageConfigExists = fileExists(
    repoRoot,
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
