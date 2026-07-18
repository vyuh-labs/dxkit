import * as fs from 'fs';
import * as path from 'path';

import { type Coverage, type FileCoverage, round1 } from '../analyzers/tools/coverage';
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
import { extractJsonBlob, asRecord, num, str } from './capabilities/lint-structured';
import { hashFirstConfig, toolVersionInput } from './capabilities/recall-inputs';

// ─── Project-shape probes ───────────────────────────────────────────────────
// A Swift repo comes in two shapes with different execution stories:
//   - SwiftPM (Package.swift): builds/tests anywhere the swift toolchain
//     runs — Linux, macOS, Windows.
//   - Xcode (*.xcodeproj / *.xcworkspace / Podfile): builds only via
//     xcodebuild, which needs macOS + full Xcode. Rule 20's motivating case.
// Both probes are pure + repo-intrinsic so execution requirements derived
// from them stay deterministic and machine-independent.

function hasSpmManifest(cwd: string): boolean {
  return fileExists(cwd, 'Package.swift');
}

/**
 * Does this repo carry an Xcode project? `.xcodeproj` / `.xcworkspace` are
 * DIRECTORIES, so we probe for the files they always contain
 * (`project.pbxproj` / `contents.xcworkspacedata`) via the canonical
 * depth-unlimited walker (G_v4_12 — real iOS repos nest the project a level
 * or more below the root).
 */
function hasXcodeProject(cwd: string): boolean {
  return (
    walkPaths(cwd, { extensions: [], basenames: ['project.pbxproj', 'contents.xcworkspacedata'] })
      .length > 0
  );
}

// ─── Rule 20 execution requirements ─────────────────────────────────────────

/** SwiftPM builds run wherever the swift toolchain does. */
const SWIFT_SPM_BUILD_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['swift'],
  needsBuild: true,
  buildTarget: 'discovered',
  weight: 'build',
};

/** An Xcode-project build is macOS + Xcode, full stop. */
const SWIFT_XCODE_BUILD_EXECUTION: ExecutionRequirement = {
  hosts: ['macos'],
  toolchains: ['xcode'],
  needsBuild: true,
  buildTarget: 'discovered',
  weight: 'build',
};

/**
 * The build-shaped requirement for THIS repo: SwiftPM-capable repos keep the
 * host-agnostic requirement (a repo with BOTH shapes still has a floor
 * everywhere — `swift build` covers the package); Xcode-only repos derive
 * `hosts: ['macos']` so placement routes them to a macos CI job and a local
 * Linux runner discloses `skipped-environment` instead of failing weirdly.
 */
function swiftBuildExecution(cwd: string): ExecutionRequirement {
  if (hasSpmManifest(cwd)) return SWIFT_SPM_BUILD_EXECUTION;
  if (hasXcodeProject(cwd)) return SWIFT_XCODE_BUILD_EXECUTION;
  // No build shape detected (or an alien cwd): answer the SwiftPM default —
  // the builders below return null there anyway, so nothing spawns.
  return SWIFT_SPM_BUILD_EXECUTION;
}

/** The swiftlint-static binary is self-contained (no Swift toolchain, no
 *  Xcode) — verified on a toolchain-less Linux host at pack-build time. */
const SWIFTLINT_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: [],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

// ─── Dep-vulns (osv-scanner over SwiftPM's Package.resolved) ────────────────

/**
 * SwiftPM dependencies audit via the ONE shared osv-scanner gather (Rule 2),
 * ecosystem `SwiftURL` (package names are repo URLs — `github.com/apple/
 * swift-nio`), fed by the GitHub Advisory Database's swift coverage.
 * Requires osv-scanner ≥ 2.4.0 (verified: 2.3.8's Package.resolved
 * extractor emitted an empty ecosystem and every Swift dep read clean).
 *
 * CocoaPods is DELIBERATELY not audited: OSV.dev has no `CocoaPods`
 * ecosystem (the API rejects it — verified 2026-07), so scanning a
 * Podfile.lock would return a structurally-guaranteed zero and a pod-based
 * repo would read as CLEAN while being unobserved — the wrong-artifact
 * class (Rule 2.30's lockfile-aware-scanner lesson). A Podfile.lock-only
 * repo therefore gets a DISCLOSED `unavailable`, never a fake clean; a repo
 * with both lockfiles is audited for SwiftPM with the pods gap named in the
 * reason surfaces (docs + runbook). Re-evaluate when an advisory database
 * covers CocoaPods.
 */
async function gatherSwiftDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const hasSpmLock = fileExists(cwd, 'Package.resolved');
  const hasPodLock = fileExists(cwd, 'Podfile.lock');
  if (!hasSpmLock && !hasPodLock) {
    return {
      kind: 'no-manifest',
      reason: 'no lockfile found (looked for: Package.resolved, Podfile.lock)',
    };
  }
  if (!hasSpmLock) {
    return {
      kind: 'unavailable',
      reason:
        'only Podfile.lock present — no advisory database covers CocoaPods (OSV.dev has no ' +
        'CocoaPods ecosystem), so pod dependencies are UNAUDITED, not clean',
    };
  }
  return gatherOsvScannerDepVulnsResult(cwd, 'swift', 'SwiftURL', ['Package.resolved']);
}

const swiftDepVulnsProvider: DepVulnsProvider = {
  source: 'swift',
  // A lockfile read via the registry-provisioned osv-scanner — no ambient
  // toolchain, runs anywhere.
  execution: () => ({
    hosts: ['any'],
    toolchains: [],
    needsBuild: false,
    buildTarget: 'none',
    weight: 'cheap',
  }),
  manifestPatterns: ['Package.swift', 'Package.resolved', 'Podfile', 'Podfile.lock'],
  // Only the AUDITABLE lockfile marks an independent audit root (a
  // Podfile.lock root would only ever disclose-skip). Xcode-managed SwiftPM
  // nests Package.resolved inside the .xcodeproj — nested-root discovery
  // finds it by basename.
  lockfilePatterns: ['Package.resolved'],
  async gather(cwd) {
    const outcome = await gatherSwiftDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherSwiftDepVulnsResult(cwd);
  },
};

// ─── Lint (SwiftLint) ───────────────────────────────────────────────────────

/**
 * Tier a SwiftLint violation by rule id. SwiftLint has two native severities
 * (error / warning); rule identity refines the buckets: the force-family
 * rules flag crash-on-nil/invalid-cast anti-patterns (correctness, not
 * style), the memory-safety-shaped rules sit in the middle.
 */
export function mapSwiftlintSeverity(code: string | null | undefined): LintSeverity {
  if (typeof code !== 'string') return 'low';
  const rule = code.toLowerCase();
  if (rule === 'force_cast' || rule === 'force_try' || rule === 'force_unwrapping') return 'high';
  if (
    rule === 'weak_delegate' ||
    rule === 'unowned_variable_capture' ||
    rule === 'discarded_notification_center_observer'
  ) {
    return 'medium';
  }
  return 'low';
}

interface SwiftlintViolation {
  file: string;
  line?: number;
  rule?: string;
  severity?: string;
  reason?: string;
}

/**
 * Map `swiftlint lint --reporter json` output to violations. One JSON array
 * of objects: `{ file, line, rule_id, severity: "Error"|"Warning", reason }`.
 * File paths are ABSOLUTE (verified against real 0.65.0 output) — the seam
 * boundary relativizes them (Rule 17's parseLocated contract). TOTAL over
 * garbage: anything unparseable → [].
 */
export function parseSwiftlintJsonViolations(output: string): SwiftlintViolation[] {
  const data = extractJsonBlob(output);
  if (!Array.isArray(data)) return [];
  const out: SwiftlintViolation[] = [];
  for (const entry of data) {
    const v = asRecord(entry);
    if (!v) continue;
    const file = str(v.file);
    if (!file) continue;
    const violation: SwiftlintViolation = { file };
    const line = num(v.line);
    if (line !== undefined) violation.line = line;
    const rule = str(v.rule_id);
    if (rule !== undefined) violation.rule = rule;
    const severity = str(v.severity);
    if (severity !== undefined) violation.severity = severity;
    const reason = str(v.reason);
    if (reason !== undefined) violation.reason = reason;
    out.push(violation);
  }
  return out;
}

/** The lint-gate structured parse: violations as raw located findings. */
export function parseSwiftlintJson(output: string): RawLocatedFinding[] {
  return parseSwiftlintJsonViolations(output).map((v) => ({
    file: v.file,
    ...(v.line !== undefined ? { line: v.line } : {}),
    ...(v.rule !== undefined ? { rule: v.rule } : {}),
    ...(v.reason !== undefined ? { message: v.reason } : {}),
  }));
}

/**
 * Single source of truth for the swift pack's lint-COUNTS gathering (the
 * Quality-score aggregate; the per-finding gate is `swiftLintGateProvider`).
 */
function gatherSwiftLintResult(cwd: string): LintGatherOutcome {
  const lint = findTool(TOOL_DEFS.swiftlint, cwd);
  if (!lint.available || !lint.path) {
    return { kind: 'unavailable', reason: 'swiftlint not installed' };
  }
  // SwiftLint exits 0 on clean/warnings-only and 2 on serious violations —
  // the JSON on stdout is the observation either way.
  const raw = run(`${lint.path} lint --quiet --no-cache --reporter json`, cwd, 120000);
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (!raw) {
    const envelope: LintResult = { schemaVersion: 1, tool: 'swiftlint', counts };
    return { kind: 'success', envelope };
  }
  for (const v of parseSwiftlintJsonViolations(raw)) {
    const byRule = mapSwiftlintSeverity(v.rule);
    // Unknown rules fall back to the native severity as a floor.
    if (byRule === 'low' && (v.severity ?? '').toLowerCase() === 'error') {
      counts.medium++;
    } else {
      counts[byRule]++;
    }
  }
  const envelope: LintResult = { schemaVersion: 1, tool: 'swiftlint', counts };
  return { kind: 'success', envelope };
}

const swiftLintProvider: CapabilityProvider<LintResult> = {
  source: 'swift',
  async gather(cwd) {
    const outcome = gatherSwiftLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

const swiftLintGateProvider: LintGateProvider = {
  execution: () => SWIFTLINT_EXECUTION,
  lintCommand(ctx) {
    const sl = findTool(TOOL_DEFS.swiftlint, ctx.cwd);
    if (!sl.available || !sl.path) return null;
    return {
      bin: sl.path,
      // Native JSON on stdout (progress noise goes to stderr), parsed
      // structurally — the display reporters truncate multi-line reasons.
      // `--no-cache` keeps the observation independent of a warm cache.
      args: ['lint', '--quiet', '--no-cache', '--reporter', 'json'],
      parse: { kind: 'structured', label: 'swiftlint-json', parse: parseSwiftlintJson },
      expectedExit: 0,
    };
  },
  recallInputs(ctx) {
    // SwiftLint's version pins its rule set; `.swiftlint.yml` decides which
    // rules run (opt-in rules, disabled rules, per-rule severities). Both
    // move findings without anyone touching the code.
    return {
      ...toolVersionInput(TOOL_DEFS.swiftlint, ctx.cwd, 'swiftlint'),
      ...hashFirstConfig(ctx.cwd, ['.swiftlint.yml', '.swiftlint.yaml']),
    };
  },
};

// ─── Coverage (swift test --enable-code-coverage → llvm-cov export JSON) ────

/**
 * Parse the llvm-cov export JSON SwiftPM writes to
 * `.build/debug/codecov/<Package>.json` after
 * `swift test --enable-code-coverage`. Shape:
 * `{ data: [{ files: [{ filename, summary: { lines: { count, covered } } }] }] }`.
 * Filenames are absolute; entries outside `cwd` (system modules, checkouts of
 * dependency packages under `.build/`) are excluded so coverage reflects the
 * repo's own sources.
 */
export function parseSwiftCoverageJson(
  raw: string,
  sourceFile: string,
  cwd: string,
): Coverage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root || !Array.isArray(root.data)) return null;
  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalLines = 0;
  const cwdPrefix = path.resolve(cwd) + path.sep;
  for (const dataEntry of root.data) {
    const d = asRecord(dataEntry);
    if (!d || !Array.isArray(d.files)) continue;
    for (const fileEntry of d.files) {
      const f = asRecord(fileEntry);
      if (!f) continue;
      const filename = str(f.filename);
      const summary = asRecord(f.summary);
      const lines = asRecord(summary?.lines);
      if (!filename || !lines) continue;
      const abs = path.resolve(filename);
      if (!abs.startsWith(cwdPrefix)) continue;
      const rel = abs.slice(cwdPrefix.length).replace(/\\/g, '/');
      if (rel.startsWith('.build/')) continue; // dependency checkouts
      const count = num(lines.count) ?? 0;
      const covered = num(lines.covered) ?? 0;
      files.set(rel, {
        path: rel,
        covered,
        total: count,
        pct: round1(count > 0 ? (covered / count) * 100 : 0),
      });
      totalLines += count;
      totalCovered += covered;
    }
  }
  if (files.size === 0) return null;
  return {
    source: 'swift',
    sourceFile,
    linePercent: round1(totalLines > 0 ? (totalCovered / totalLines) * 100 : 0),
    files,
  };
}

/** The codecov JSON SwiftPM produced, if any. `.build/debug` is a symlink to
 *  the active triple's debug dir, so probing it covers every platform. */
function findSwiftCodecovArtifact(cwd: string): string | null {
  const dir = path.join(cwd, '.build', 'debug', 'codecov');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const json = entries.filter((e) => e.endsWith('.json')).sort();
  return json.length > 0 ? path.posix.join('.build', 'debug', 'codecov', json[0]) : null;
}

function gatherSwiftCoverageResult(cwd: string): CoverageResult | null {
  const rel = findSwiftCodecovArtifact(cwd);
  if (!rel) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, rel), 'utf-8');
  } catch {
    return null;
  }
  const coverage = parseSwiftCoverageJson(raw, rel, cwd);
  if (!coverage) return null;
  return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
}

function runSwiftTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'swift',
      cmd: 'swift test --enable-code-coverage',
      cwd,
      artifact: findSwiftCodecovArtifact,
      preflight: (cwd) => {
        if (!hasSpmManifest(cwd)) {
          return 'no Package.swift in this directory — coverage-by-command needs SwiftPM (Xcode projects: run tests from Xcode or a macos CI job)';
        }
        return null;
      },
    }),
  );
}

const swiftCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'swift',
  async gather(cwd) {
    return gatherSwiftCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runSwiftTestsWithCoverage(cwd);
  },
};

// ─── Imports ────────────────────────────────────────────────────────────────

/**
 * Capture module names from Swift import declarations. Handles `import
 * Foundation`, `@testable import MyLib`, attribute-prefixed imports, and
 * kind-qualified imports (`import struct Foo.Bar` — the MODULE is `Foo`).
 * Submodule imports (`import UIKit.UIView`) collapse to the top module.
 */
export function extractSwiftImportsRaw(content: string): string[] {
  const out: string[] = [];
  const re =
    /^\s*(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|actor|let|var|func)\s+)?([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Resolve a Swift import to the in-project SwiftPM target directory
 * (`Sources/<Module>` / `Tests/<Module>`), or null for system/external
 * modules. Directory targets dead-end the import-graph BFS, matching the Go
 * pack's package-directory model — Swift imports are module-level, not
 * file-level.
 */
export function resolveSwiftImportRaw(_fromFile: string, spec: string, cwd: string): string | null {
  for (const base of ['Sources', 'Tests']) {
    const rel = `${base}/${spec}`;
    try {
      if (fs.statSync(path.join(cwd, rel)).isDirectory()) return rel;
    } catch {
      // not found
    }
  }
  return null;
}

function gatherSwiftImportsResult(cwd: string): ImportsResult | null {
  const files = walkSourceFiles(cwd, {
    extensions: ['.swift'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  const edges = new Map<string, ReadonlySet<string>>();
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    const specs = extractSwiftImportsRaw(content);
    extracted.set(rel, specs);
    const targets = new Set<string>();
    for (const spec of specs) {
      const resolved = resolveSwiftImportRaw(rel, spec, cwd);
      if (resolved) targets.add(resolved);
    }
    if (targets.size > 0) edges.set(rel, targets);
  }
  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'swift-imports',
    sourceExtensions: ['.swift'],
    extracted,
    edges,
  };
}

const swiftImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'swift',
  async gather(cwd) {
    return gatherSwiftImportsResult(cwd);
  },
};

// ─── Test framework ─────────────────────────────────────────────────────────

function gatherSwiftTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  if (!hasSpmManifest(cwd) && !hasXcodeProject(cwd)) return null;
  return { schemaVersion: 1, tool: 'swift', name: 'xctest' };
}

const swiftTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'swift',
  async gather(cwd) {
    return gatherSwiftTestFrameworkResult(cwd);
  },
};

// ─── Correctness floor ──────────────────────────────────────────────────────

function swiftRelevantChange(f: string): boolean {
  return (
    f.endsWith('.swift') ||
    f.endsWith('Package.resolved') ||
    f.endsWith('Podfile.lock') ||
    f.endsWith('.xcconfig') ||
    f.endsWith('project.pbxproj')
  );
}

/**
 * The Swift correctness floor.
 *
 * SwiftPM repos: `swift build` IS the compile check (incremental on a warm
 * `.build`), `swift test` the suite. Swift has no native per-test impact
 * selection, so the affected surface runs the whole suite when any
 * Swift-relevant file changed and skips otherwise (a docs-only change never
 * pays a build) — CI's `full` scope is the backstop, the Go-pack pattern.
 *
 * Xcode-only repos: `xcodebuild build` compiles the project's default target
 * (scheme-less form — the discovered root project). It carries the macos
 * execution requirement above, so on any other host the runner discloses
 * `skipped-environment` BEFORE spawning. `xcodebuild test` additionally
 * needs a scheme + simulator destination — genuinely repo-configured, so the
 * test half stays null (a disclosed gap, closable via a Rule-17 custom
 * check) rather than a command that fails on every unconfigured repo.
 */
const swiftCorrectnessProvider: CorrectnessProvider = {
  execution: swiftBuildExecution,

  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (hasSpmManifest(ctx.cwd)) {
      return { label: 'build', bin: 'swift', args: ['build'] };
    }
    if (hasXcodeProject(ctx.cwd)) {
      return { label: 'xcodebuild', bin: 'xcodebuild', args: ['build'] };
    }
    return null;
  },

  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (!hasSpmManifest(ctx.cwd)) return null;
    const undeterminable = ctx.changedFiles.length === 0;
    if (ctx.scope === 'affected' && !undeterminable) {
      if (!ctx.changedFiles.some(swiftRelevantChange)) return null;
    }
    return { label: 'affected-tests', bin: 'swift', args: ['test'] };
  },
};

// ─── Version detection ──────────────────────────────────────────────────────

/** The Swift version this repo targets — `.swift-version` (swiftly/swiftenv
 *  pin) first, else Package.swift's `// swift-tools-version:X.Y`, else the
 *  Xcode project's `SWIFT_VERSION` build setting (the only signal an
 *  Xcode-shaped repo has — verified on a real iOS repo whose root carries
 *  neither manifest). */
function detectSwiftVersion(cwd: string): string | undefined {
  const pin = readRepoFile(cwd, '.swift-version').trim();
  const pinMatch = pin.match(/^(\d+\.\d+(?:\.\d+)?)/);
  if (pinMatch) return pinMatch[1];
  const tools = readRepoFile(cwd, 'Package.swift').match(
    /\/\/\s*swift-tools-version\s*:\s*(\d+\.\d+)/,
  );
  if (tools) return tools[1];
  for (const rel of walkPaths(cwd, { extensions: [], basenames: ['project.pbxproj'] })) {
    const m = readRepoFile(cwd, rel).match(/SWIFT_VERSION\s*=\s*(\d+(?:\.\d+)?)/);
    if (m) return m[1].includes('.') ? m[1] : `${m[1]}.0`;
  }
  return undefined;
}

// ─── The pack ───────────────────────────────────────────────────────────────

export const swift: LanguageSupport = {
  id: 'swift',
  displayName: 'Swift',
  commentSyntax: { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' },
  sourceExtensions: ['.swift'],
  testFilePatterns: ['*Tests.swift', '*Test.swift'],
  // SwiftPM build output, CocoaPods checkout, Xcode derived data, Carthage
  // checkout, SwiftPM per-package config dir.
  extraExcludes: ['.build', 'Pods', 'DerivedData', 'Carthage', '.swiftpm'],

  // Sourcery/R.swift codegen + Xcode's CoreData model codegen.
  autogeneratedSourcePatterns: [
    '*.generated.swift',
    '*+CoreDataProperties.swift',
    '*+CoreDataClass.swift',
  ],

  exportDetection: {
    reliability: 'full',
    strategy: 'public/open access-level modifiers mark API surface (internal-by-default semantics)',
  },

  // Swift doc-comment markers: `///` is the dominant form, `/** */` the
  // block form (both feed DocC / Xcode Quick Help).
  docCommentPatterns: ['^[[:space:]]*///', '/\\*\\*'],

  // TLS/ATS bypass idioms in the Apple networking stacks: ATS's global
  // opt-out key (Info.plist or programmatic), AFNetworking's
  // security-policy escape hatch, and Alamofire's trust-evaluation
  // disablers (v5 DisabledTrustEvaluator / v4 disableEvaluation).
  tlsBypassPatterns: [
    'NSAllowsArbitraryLoads',
    'allowInvalidCertificates[[:space:]]*=[[:space:]]*(true|YES)',
    'DisabledTrustEvaluator|disableEvaluation',
  ],

  upgradeCommand(name, version) {
    // Both Swift ecosystems pin versions in an edited manifest, not via an
    // install command: SwiftPM in Package.swift's dependency requirement,
    // CocoaPods in the Podfile. Prose hint, the Maven/Gemfile pattern.
    return `# update ${name} to >= ${version} in Package.swift then \`swift package update ${name}\` (SwiftPM), or in Podfile then \`pod update ${name}\` (CocoaPods)`;
  },

  // iOS/macOS app conventions (MVVM / MVC): views + view models + view
  // controllers are the primary surfaces; no served HTTP routes (an app
  // consumes APIs, it doesn't expose them) so routePaths is omitted — the
  // frontend-pack pattern.
  architecturalShape: {
    primaryComponentPaths: ['/Views/', '/ViewModels/', '/ViewControllers/', '/Screens/'],
    modelPaths: ['/Models/', '/Entities/'],
    vocabulary: {
      components: 'views/view controllers',
      models: 'models',
    },
    testGapPriority: {
      high: ['/ViewModels/', '/ViewControllers/'],
    },
  },

  clocLanguageNames: ['Swift'],

  detect(cwd) {
    return hasSpmManifest(cwd) || fileExists(cwd, 'Podfile') || hasXcodeProject(cwd);
  },

  tools: ['swiftlint', 'osv-scanner'],
  semgrepRulesets: ['p/swift'],

  // CodeQL's swift extractor is GA (build-traced: SwiftPM on linux/macos,
  // Xcode on macos — the same derivation as the floor); Snyk Code supports
  // Swift.
  deepSast: {
    codeqlLanguage: 'swift',
    snykCode: true,
    execution: swiftBuildExecution,
  },

  // Protocol conformances, extensions, selector/storyboard wiring — name
  // matching resolves direct calls but misses the dynamic-dispatch layer an
  // iOS codebase leans on, so caller counts are indicative, not exhaustive.
  callGraphReliability: 'partial',

  correctness: swiftCorrectnessProvider,
  lintGate: swiftLintGateProvider,

  capabilities: {
    depVulns: swiftDepVulnsProvider,
    lint: swiftLintProvider,
    coverage: swiftCoverageProvider,
    imports: swiftImportsProvider,
    testFramework: swiftTestFrameworkProvider,
    // licenses: deliberately omitted. No canonical CLI license tool for
    // SwiftPM/CocoaPods (LicensePlist targets app bundles and needs project
    // integration — the Gradle-plugin class). Re-evaluate on customer need.
  },

  mapLintSeverity: mapSwiftlintSeverity,

  // ─── LP-recipe metadata ────────────────────────────────────────────────

  permissions: [
    'Bash(swift build:*)',
    'Bash(swift test:*)',
    'Bash(swift package:*)',
    'Bash(swiftlint:*)',
    'Bash(xcodebuild:*)',
  ],
  ruleFile: 'swift.md',
  // `swift` + `xcodebuild` — the two ambient toolchains the pack's execution
  // requirements route on (Rule 20 doctor parity); swiftlint is the
  // registry-installed gate binary.
  cliBinaries: ['swift', 'swiftlint', 'xcodebuild'],
  ciSetup: {
    steps: [
      {
        name: 'Set up Swift',
        uses: 'swift-actions/setup-swift@v2',
        with: { 'swift-version': '6.1' },
        versionInput: 'swift-version',
      },
    ],
  },
  defaultVersion: '6.1',
  detectVersion: detectSwiftVersion,
  // devcontainerFeature: deliberately omitted — no swift feature exists in
  // ghcr.io/devcontainers or the 450-feature community registry (verified
  // 2026-07). Swift's canonical devcontainer story is a BASE IMAGE
  // (mcr.microsoft.com/devcontainers/swift), which the feature mechanism
  // cannot express. Declared exempt in test/languages-contract.test.ts.
  devcontainerExtensions: ['swiftlang.swift-vscode'],
};
