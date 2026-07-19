import * as fs from 'fs';
import * as path from 'path';

import { type Coverage, type FileCoverage, round1 } from '../analyzers/tools/coverage';
import { loadExclusions } from '../analyzers/tools/exclusions';
import { gatherOsvScannerDepVulnsResult } from '../analyzers/tools/osv-scanner-deps';
import { fileExists, run } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import type { ExecutionRequirement } from '../execution';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  RunTestsOutcome,
} from './capabilities/provider';
import type {
  CorrectnessCommand,
  CorrectnessContext,
  CorrectnessProvider,
} from './capabilities/correctness';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  ImportsResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
  TestFrameworkResult,
} from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';
import { readRepoFile } from './version-detect';
import type { LintGateProvider, RawLocatedFinding } from './capabilities/lint-gate';
import { asRecord, extractJsonBlob, num, str } from './capabilities/lint-structured';
import { hashFirstConfig, toolVersionInput } from './capabilities/recall-inputs';

// ─── Detection ──────────────────────────────────────────────────────────────

function hasPhpSource(cwd: string): boolean {
  // Depth-unlimited via the canonical walker (G_v4_12). The source walk is
  // load-bearing (the swift lesson): a repo with .php sources but no
  // composer.json must still ACTIVATE the pack, or its disclosures (an
  // unauditable dependency story included) silently never render.
  return walkPaths(cwd, { extensions: ['.php'] }).length > 0;
}

function detectPhp(cwd: string): boolean {
  return fileExists(cwd, 'composer.json') || hasPhpSource(cwd);
}

// ─── Rule 20 execution requirements ─────────────────────────────────────────

/** PHP is interpreted — the floor and the phpcs phar both need only the
 *  ambient php CLI, no build. */
const PHP_CLI_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['php'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

/** A lockfile read via the registry-provisioned osv-scanner — no ambient
 *  toolchain at all. */
const PHP_LOCKFILE_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: [],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

// ─── Dep-vulns (osv-scanner over composer.lock, ecosystem Packagist) ────────

async function gatherPhpDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  // Ecosystem string + extraction verified against a live osv-scanner 2.4.0
  // run on a known-vulnerable lock (guzzle 7.4.0 → 4 GHSAs) before this
  // pack shipped — the swift 2.3.8 lesson (a scanner that parses nothing
  // reads as CLEAN).
  return gatherOsvScannerDepVulnsResult(cwd, 'php', 'Packagist', ['composer.lock']);
}

const phpDepVulnsProvider: DepVulnsProvider = {
  source: 'php',
  execution: () => PHP_LOCKFILE_EXECUTION,
  manifestPatterns: ['composer.json', 'composer.lock'],
  // Every composer.lock is an independent resolution root (nested
  // sub-projects — the moodle-plugin shape).
  lockfilePatterns: ['composer.lock'],
  async gather(cwd) {
    const outcome = await gatherPhpDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherPhpDepVulnsResult(cwd);
  },
};

// ─── Lint (PHP_CodeSniffer) ─────────────────────────────────────────────────

/**
 * Tier a phpcs finding by its sniff id (`source` in the JSON). phpcs is a
 * coding-standard tool, so almost everything is style — the few
 * security-shaped sniffs (eval, forbidden functions) go high, the rest low.
 * The counts path refines with the native ERROR/WARNING type.
 */
export function mapPhpcsSeverity(code: string | null | undefined): LintSeverity {
  if (typeof code !== 'string') return 'low';
  const rule = code.toLowerCase();
  if (rule.includes('.php.eval') || rule.includes('forbiddenfunctions')) return 'high';
  if (rule.includes('discouragedfunctions')) return 'medium';
  return 'low';
}

interface PhpcsMessage {
  file: string;
  line?: number;
  rule?: string;
  type?: string;
  message?: string;
}

/**
 * Map `phpcs --report=json` output to messages. Shape (verified against a
 * real 4.0.1 run): `{ totals: {...}, files: { <ABSOLUTE path>: { errors,
 * warnings, messages: [{ message, source, type: "ERROR"|"WARNING", line,
 * column }] } } }` — the seam boundary relativizes paths (Rule 17). TOTAL
 * over garbage: anything unparseable → [].
 */
export function parsePhpcsJsonMessages(output: string): PhpcsMessage[] {
  const data = asRecord(extractJsonBlob(output));
  const files = asRecord(data?.files);
  if (!files) return [];
  const out: PhpcsMessage[] = [];
  for (const [file, entry] of Object.entries(files)) {
    const e = asRecord(entry);
    if (!e || !Array.isArray(e.messages)) continue;
    for (const raw of e.messages) {
      const m = asRecord(raw);
      if (!m) continue;
      const message: PhpcsMessage = { file };
      const line = num(m.line);
      if (line !== undefined) message.line = line;
      const rule = str(m.source);
      if (rule !== undefined) message.rule = rule;
      const type = str(m.type);
      if (type !== undefined) message.type = type;
      const text = str(m.message);
      if (text !== undefined) message.message = text;
      out.push(message);
    }
  }
  return out;
}

/** The lint-gate structured parse: phpcs messages as raw located findings. */
export function parsePhpcsJson(output: string): RawLocatedFinding[] {
  return parsePhpcsJsonMessages(output).map((m) => ({
    file: m.file,
    ...(m.line !== undefined ? { line: m.line } : {}),
    ...(m.rule !== undefined ? { rule: m.rule } : {}),
    ...(m.message !== undefined ? { message: m.message } : {}),
  }));
}

/** Does the repo pin its own phpcs standard? Then phpcs auto-loads it and we
 *  must NOT override with PSR-12. */
const PHPCS_CONFIG_FILES = ['phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml', '.phpcs.xml.dist'];

function hasPhpcsConfig(cwd: string): boolean {
  return PHPCS_CONFIG_FILES.some((f) => fileExists(cwd, f));
}

/** phpcs args shared by the counts gather and the lint gate: JSON report,
 *  php files only, exclusions from the ONE source (Rule 4), PSR-12 only when
 *  the repo declares no standard of its own. */
function phpcsArgs(cwd: string): string[] {
  const ignore = loadExclusions(cwd)
    .dirs.map((d) => `*/${d}/*`)
    .join(',');
  return [
    '-q',
    // PHP's default 128M memory_limit is exhausted by the JSON reporter on
    // large legacy files (a real 17k-line controller killed phpcs
    // mid-report, and the empty output read as CLEAN — the false-clean
    // class this arg + the no-JSON guard below close together).
    '-d',
    'memory_limit=1G',
    '--report=json',
    '--extensions=php',
    ...(ignore ? [`--ignore=${ignore}`] : []),
    ...(hasPhpcsConfig(cwd) ? [] : ['--standard=PSR12']),
    '.',
  ];
}

function gatherPhpLintResult(cwd: string): LintGatherOutcome {
  const lint = findTool(TOOL_DEFS.phpcs, cwd);
  if (!lint.available || !lint.path) {
    return { kind: 'unavailable', reason: 'phpcs not installed' };
  }
  // phpcs exits non-zero when it reports findings — the JSON on stdout is
  // the observation either way.
  const raw = run(`${lint.path} ${phpcsArgs(cwd).join(' ')}`, cwd, 120000);
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  // A CLEAN phpcs run still prints a JSON skeleton — for THIS tool, empty
  // stdout ALWAYS means the run died (stderr-only refusal or crash). The
  // "empty output = clean" convention other packs use minted a zero-count
  // success on a php missing phpcs's required extensions (caught by the
  // tarball validation: the error goes to stderr and stdout is empty).
  // Same rule for non-empty output with no parseable JSON (a php fatal
  // error mid-report). Unavailable, never a fabricated clean.
  if (!raw || !asRecord(extractJsonBlob(raw))?.files) {
    return {
      kind: 'unavailable',
      reason: raw
        ? `phpcs produced no parseable JSON: ${raw.slice(0, 120)}`
        : 'phpcs produced no output (crashed, or the php runtime is missing the tokenizer/xmlwriter/SimpleXML extensions phpcs requires — e.g. `apt install php-xml`)',
    };
  }
  for (const m of parsePhpcsJsonMessages(raw)) {
    const byRule = mapPhpcsSeverity(m.rule);
    if (byRule !== 'low') {
      counts[byRule]++;
    } else if ((m.type ?? '').toUpperCase() === 'ERROR') {
      counts.medium++;
    } else {
      counts.low++;
    }
  }
  const envelope: LintResult = { schemaVersion: 1, tool: 'phpcs', counts };
  return { kind: 'success', envelope };
}

const phpLintProvider: CapabilityProvider<LintResult> = {
  source: 'php',
  async gather(cwd) {
    const outcome = gatherPhpLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

const phpLintGateProvider: LintGateProvider = {
  // The phar executes on the ambient php CLI (the detekt-needs-a-JVM shape).
  execution: () => PHP_CLI_EXECUTION,
  lintCommand(ctx) {
    const phpcs = findTool(TOOL_DEFS.phpcs, ctx.cwd);
    if (!phpcs.available || !phpcs.path) return null;
    return {
      bin: phpcs.path,
      args: phpcsArgs(ctx.cwd),
      parse: { kind: 'structured', label: 'phpcs-json', parse: parsePhpcsJson },
      expectedExit: 0,
    };
  },
  recallInputs(ctx) {
    // phpcs's version pins its sniff set; the repo's standard file decides
    // which sniffs run. Both move findings without anyone touching code.
    return {
      ...toolVersionInput(TOOL_DEFS.phpcs, ctx.cwd, 'phpcs'),
      ...hashFirstConfig(ctx.cwd, PHPCS_CONFIG_FILES),
    };
  },
};

// ─── Coverage (PHPUnit clover XML) ──────────────────────────────────────────

/**
 * Parse a PHPUnit clover XML report. Per-file: `<file name="...">` blocks
 * containing `<line num="N" type="stmt" count="C"/>` entries; a statement
 * line is covered iff count > 0. Absolute file names are relativized to cwd;
 * entries outside cwd (vendor deps when a repo mis-scopes coverage) are
 * dropped.
 */
export function parsePhpCloverXml(raw: string, sourceFile: string, cwd: string): Coverage | null {
  if (!raw.includes('<coverage')) return null;
  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalLines = 0;
  const cwdPrefix = path.resolve(cwd) + path.sep;
  const fileRe = /<file\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(raw)) !== null) {
    const name = fm[1];
    const body = fm[2];
    const abs = path.resolve(name);
    if (!abs.startsWith(cwdPrefix)) continue;
    const rel = abs.slice(cwdPrefix.length).replace(/\\/g, '/');
    let covered = 0;
    let total = 0;
    const lineRe = /<line\s+num="\d+"\s+type="stmt"\s+count="(\d+)"/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body)) !== null) {
      total++;
      if (parseInt(lm[1], 10) > 0) covered++;
    }
    if (total === 0) continue;
    files.set(rel, {
      path: rel,
      covered,
      total,
      pct: round1((covered / total) * 100),
    });
    totalCovered += covered;
    totalLines += total;
  }
  if (files.size === 0) return null;
  return {
    source: 'php-clover',
    sourceFile,
    linePercent: round1(totalLines > 0 ? (totalCovered / totalLines) * 100 : 0),
    files,
  };
}

const PHP_CLOVER_CANDIDATES = [
  'coverage-clover.xml',
  'clover.xml',
  'build/logs/clover.xml',
  'coverage/clover.xml',
];

function gatherPhpCoverageResult(cwd: string): CoverageResult | null {
  for (const rel of PHP_CLOVER_CANDIDATES) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    const coverage = parsePhpCloverXml(raw, rel, cwd);
    if (coverage) return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
  }
  return null;
}

/** The repo's phpunit runner, if provisioned (composer's vendor/bin shim).
 *  Absolute path — the runner stats bins against the process cwd (the
 *  gradlew lesson in jvm-build.ts). */
function phpunitBin(cwd: string): string | null {
  const bin = path.join(cwd, 'vendor', 'bin', 'phpunit');
  return fs.existsSync(bin) ? bin : null;
}

function hasPhpunitConfig(cwd: string): boolean {
  return fileExists(cwd, 'phpunit.xml') || fileExists(cwd, 'phpunit.xml.dist');
}

function runPhpTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'php',
      cmd: 'vendor/bin/phpunit --coverage-clover coverage-clover.xml',
      cwd,
      artifact: 'coverage-clover.xml',
      preflight: (cwd) => {
        if (!phpunitBin(cwd)) {
          return 'no vendor/bin/phpunit — run `composer install` first (PHPUnit is the canonical PHP coverage producer)';
        }
        // A coverage DRIVER (Xdebug or PCOV) must be loaded or PHPUnit runs
        // the tests but writes no report; runTestsWithCoverage's
        // artifact-missing outcome names that honestly.
        return null;
      },
    }),
  );
}

const phpCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'php',
  async gather(cwd) {
    return gatherPhpCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runPhpTestsWithCoverage(cwd);
  },
};

// ─── Imports ────────────────────────────────────────────────────────────────

/**
 * Capture imported symbols from PHP source: `use A\B\C;` (with grouped
 * `use A\{B, C};` and aliased `use A\B as X;` forms) plus string-literal
 * `require`/`include` targets. Comments are stripped first so commented-out
 * imports don't false-match.
 *
 * Extraction-only (no edges): resolving a namespace to a file needs the
 * composer autoload map — the kotlin/java posture, a disclosed gap.
 */
export function extractPhpImportsRaw(content: string): string[] {
  const out: string[] = [];
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*|#[^\n]*/g, '');
  const useRe =
    /^\s*use\s+(?:function\s+|const\s+)?([A-Za-z_\\][A-Za-z0-9_\\]*)(?:\s*\{([^}]*)\})?/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(stripped)) !== null) {
    if (m[2] !== undefined) {
      // Grouped form: `use A\B\{C, D as E};` → A\B\C, A\B\D
      const prefix = m[1].replace(/\\$/, '');
      for (const part of m[2].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/i)[0]
          .trim();
        if (name) out.push(`${prefix}\\${name}`);
      }
    } else {
      out.push(m[1]);
    }
  }
  const reqRe = /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
  while ((m = reqRe.exec(stripped)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function gatherPhpImportsResult(cwd: string): ImportsResult | null {
  const files = walkSourceFiles(cwd, {
    extensions: ['.php'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    extracted.set(rel, extractPhpImportsRaw(content));
  }
  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'php-imports',
    sourceExtensions: ['.php'],
    extracted,
    edges: new Map(),
  };
}

const phpImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'php',
  async gather(cwd) {
    return gatherPhpImportsResult(cwd);
  },
};

// ─── Test framework ─────────────────────────────────────────────────────────

function gatherPhpTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  if (!hasPhpunitConfig(cwd) && !phpunitBin(cwd)) return null;
  return { schemaVersion: 1, tool: 'php', name: 'phpunit' };
}

const phpTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'php',
  async gather(cwd) {
    return gatherPhpTestFrameworkResult(cwd);
  },
};

// ─── Correctness floor ──────────────────────────────────────────────────────

/**
 * The PHP correctness floor.
 *
 * syntaxCheck: `php -l <changed .php files>` — the interpreter IS the parse
 * check, and modern php lints every file passed (verified on 8.5; exit 255
 * on the first parse error). Diff-scoped only: PHP has no whole-tree lint
 * command, so full scope returns null (a disclosed absence — the lint gate
 * and affectedTests still cover CI) rather than an argv-exploding file list.
 *
 * affectedTests: the repo's own PHPUnit (`vendor/bin/phpunit`), whole suite
 * when any .php/composer file changed — PHP has no native impact selection.
 * Absent phpunit config/binary → null (fail-open, CI backstop).
 */
function phpRelevantChange(f: string): boolean {
  return f.endsWith('.php') || f.endsWith('composer.json') || f.endsWith('composer.lock');
}

const phpCorrectnessProvider: CorrectnessProvider = {
  execution: () => PHP_CLI_EXECUTION,

  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
    const changedPhp = ctx.changedFiles.filter((f) => f.endsWith('.php'));
    if (changedPhp.length === 0) return null;
    return { label: 'php-lint', bin: 'php', args: ['-l', ...changedPhp] };
  },

  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
    const bin = phpunitBin(ctx.cwd);
    if (!bin || !hasPhpunitConfig(ctx.cwd)) return null;
    const undeterminable = ctx.changedFiles.length === 0;
    if (ctx.scope === 'affected' && !undeterminable) {
      if (!ctx.changedFiles.some(phpRelevantChange)) return null;
    }
    return { label: 'affected-tests', bin, args: [] };
  },
};

// ─── Version detection ──────────────────────────────────────────────────────

/** The PHP version this repo targets — composer.json's `require.php`
 *  constraint (`"^8.1"` → `8.1`), else `.php-version`. */
function detectPhpVersion(cwd: string): string | undefined {
  const composer = readRepoFile(cwd, 'composer.json');
  if (composer) {
    try {
      const parsed = JSON.parse(composer) as { require?: Record<string, string> };
      const constraint = parsed.require?.php;
      const m = constraint?.match(/(\d+\.\d+)/);
      if (m) return m[1];
    } catch {
      /* malformed composer.json — fall through */
    }
  }
  const pin = readRepoFile(cwd, '.php-version').trim();
  const pinMatch = pin.match(/^(\d+\.\d+)/);
  return pinMatch ? pinMatch[1] : undefined;
}

// ─── The pack ───────────────────────────────────────────────────────────────

export const php: LanguageSupport = {
  id: 'php',
  displayName: 'PHP',
  commentSyntax: { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' },
  sourceExtensions: ['.php'],
  testFilePatterns: ['*Test.php', '*_test.php'],
  // Composer's dependency tree; framework caches that carry generated PHP.
  extraExcludes: ['vendor', 'storage', 'bootstrap/cache', 'var/cache'],

  exportDetection: {
    reliability: 'full',
    strategy:
      'public-by-default visibility semantics (no private/protected keyword on the declaration)',
  },

  // PHPDoc block openers.
  docCommentPatterns: ['/\\*\\*'],

  // TLS bypass idioms in the PHP HTTP stacks: raw cURL peer/host
  // verification off, Guzzle's verify option, stream-context verify_peer.
  tlsBypassPatterns: [
    'CURLOPT_SSL_VERIFYPEER[[:space:]]*,[[:space:]]*(false|FALSE|0)',
    'CURLOPT_SSL_VERIFYHOST[[:space:]]*,[[:space:]]*(false|FALSE|0)',
    '[\'"]verify[\'"][[:space:]]*=>[[:space:]]*(false|FALSE)',
    '[\'"]verify_peer[\'"][[:space:]]*=>[[:space:]]*(false|FALSE)',
  ],

  upgradeCommand(name, version) {
    return `composer require ${name}:^${version}`;
  },

  // PHP web conventions (Laravel/Symfony MVC): controllers + services are
  // the primary surfaces, Eloquent/Doctrine models the data layer, and the
  // routes/ dir + Http/ namespace mark the HTTP surface.
  architecturalShape: {
    primaryComponentPaths: ['/Controllers/', '/Http/', '/Services/', '/Jobs/'],
    routePaths: ['/Controllers/', '/routes/'],
    modelPaths: ['/Models/', '/Entity/', '/Entities/'],
    vocabulary: {
      components: 'controllers/services',
      models: 'models',
      routes: 'routes',
    },
    testGapPriority: {
      high: ['/Controllers/', '/Http/', '/Services/', '/Jobs/'],
    },
  },

  clocLanguageNames: ['PHP'],

  detect: detectPhp,

  tools: ['phpcs', 'osv-scanner'],
  semgrepRulesets: ['p/php'],

  // CodeQL has no PHP extractor; Snyk Code supports PHP (source-based, no
  // build).
  deepSast: {
    snykCode: true,
    execution: () => PHP_LOCKFILE_EXECUTION,
  },

  // Autoloading, magic methods (__call), and framework container wiring
  // defeat name-matching for a meaningful slice of calls.
  callGraphReliability: 'partial',

  correctness: phpCorrectnessProvider,
  lintGate: phpLintGateProvider,

  capabilities: {
    depVulns: phpDepVulnsProvider,
    lint: phpLintProvider,
    coverage: phpCoverageProvider,
    imports: phpImportsProvider,
    testFramework: phpTestFrameworkProvider,
    // licenses: deliberately omitted. `composer licenses` needs a resolved
    // vendor tree + the composer CLI; revisit on customer need.
  },

  mapLintSeverity: mapPhpcsSeverity,

  // ─── LP-recipe metadata ────────────────────────────────────────────────

  permissions: ['Bash(php:*)', 'Bash(composer:*)', 'Bash(phpcs:*)', 'Bash(vendor/bin/phpunit:*)'],
  ruleFile: 'php.md',
  cliBinaries: ['php', 'phpcs'],
  ciSetup: {
    steps: [
      {
        name: 'Set up PHP',
        uses: 'shivammathur/setup-php@v2',
        with: { 'php-version': '8.4' },
        versionInput: 'php-version',
      },
    ],
  },
  defaultVersion: '8.4',
  detectVersion: detectPhpVersion,
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/php:1',
    opts: { version: '8.4' },
  },
  devcontainerExtensions: ['bmewburn.vscode-intelephense-client'],
};
