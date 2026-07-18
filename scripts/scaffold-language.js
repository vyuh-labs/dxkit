#!/usr/bin/env node
/**
 * Phase 10i.0-LP.7 / 10f.4 — Language pack scaffolder.
 *
 * Generates the 7 recipe files for a new language pack from inline
 * templates so a contributor never starts from a blank file. Each
 * generated file has TODO markers at the spots that need real
 * implementation work (detect logic, capability providers, fixture
 * content). Type-safe by construction — no casts in generated code.
 *
 * Usage:
 *
 *   npm run new-lang kotlin "Kotlin (Android)"
 *
 * Creates:
 *   src/languages/<id>.ts                   pack stub (all LanguageSupport fields)
 *   test/languages-<id>.test.ts             pack-specific test stub
 *   test/fixtures/benchmarks/<id>/          fixture directory skeleton
 *   src-templates/.claude/rules/<id>.md     Claude rule file stub
 *   src-templates/configs/<id>/             template-config dir skeleton
 *
 * Updates:
 *   src/types.ts                            extends `LanguageId` union with <id>
 *   src/languages/index.ts                  registers <id> in `LANGUAGES`
 *
 * After 10f.4, `DetectedStack.languages` is `Record<LanguageId, boolean>`,
 * so adding <id> to the `LanguageId` union is the ONLY type change
 * needed — there's no fixed-shape interface to extend.
 *
 * Prints a next-steps checklist with the remaining manual work
 * (capability provider implementations, CI workflow toolchain install,
 * CONTRIBUTING.md toolchain table row, fixture content).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// CLI scaffolder — `console.*` is the user-facing output channel, not slop.
function die(msg) {
  console.error(`X ${msg}`); // slop-ok
  process.exit(1);
}

function ok(msg) {
  console.log(`+ ${msg}`); // slop-ok
}

function info(msg) {
  console.log(`. ${msg}`); // slop-ok
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeIfMissing(absPath, content) {
  if (fs.existsSync(absPath)) {
    info(`skipped ${path.relative(REPO_ROOT, absPath)} (already exists)`);
    return false;
  }
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, content);
  ok(`created ${path.relative(REPO_ROOT, absPath)}`);
  return true;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── G4 (Recipe v3): benchmark fixture profile registry ────────────────────
// Per-language conventions for the standard 4 benchmark fixtures
// (Secrets / BadLint / Duplications / UntestedModule). When scaffolding
// a new pack, add an entry here BEFORE running `npm run new-lang` so
// the scaffolder writes ready-to-use fixture stubs instead of empty
// placeholders.
//
// The standard 4 fixtures are language-agnostic in INTENT (matrix
// asserts gitleaks/jscpd/test-gaps fire) but language-specific in
// SYNTAX. Pre-templating saves ~30 min of cribbing-from-kotlin per new
// pack. Languages without a profile fall back to GENERIC_FIXTURE_STUB
// (writes empty files with TODO markers — still better than nothing).
//
// Profile fields:
//   ext           — file extension (no leading dot)
//   filenameCase  — 'pascal' (Secrets.kt) or 'snake' (secrets.py)
//   comment       — line-comment marker ('//', '#', '--', etc.)
//   secrets       — body of the AKIA-leaking file (gitleaks AWS rule)
//   badLint       — body that violates the pack's default linter
//   duplications  — body with two near-identical methods (jscpd target)
//   untested      — body with one simple class/function (no test pair)
//
// AKIA constant: every profile must use the literal "AKIA1234567890ABCDEF"
// — gitleaks' default `aws-access-token` rule matches /AKIA[0-9A-Z]{16}/
// and the matrix asserts severity=critical.

const GENERIC_FIXTURE_STUB = {
  ext: 'TODO',
  filenameCase: 'pascal',
  comment: '//',
  secrets: '// TODO: declare AWS_ACCESS_KEY_ID constant equal to "AKIA1234567890ABCDEF"\n',
  badLint:
    "// TODO: write a body that violates the pack's default linter\n" +
    '//       (e.g. unused-import, magic-number, useless-assignment)\n',
  duplications:
    '// TODO: two near-identical methods (>=20 lines each, >=50 jscpd tokens)\n' +
    "//       cribbing from any existing pack's Duplications fixture is fine\n",
  untested:
    '// TODO: one simple class/function with no matching test file\n' +
    '//       body must be lint-clean, clone-free, and secret-free\n',
};

const FIXTURE_PROFILES = {
  php: {
    ext: 'php',
    filenameCase: 'snake',
    comment: '//',
    secrets:
      '<?php\n' +
      '// Hardcoded fake AWS access key — gitleaks should flag this as\n' +
      '// `aws-access-token`. Per-language secret fixture pre-staging the\n' +
      '// cross-ecosystem assertion surface.\n' +
      '//\n' +
      '// The key below is intentionally fake (low-entropy, no valid AWS\n' +
      '// checksum) so it cannot be used to authenticate.\n' +
      '$awsAccessKeyId = "AKIA1234567890ABCDEF";\n',
    badLint:
      '<?php\n' +
      '// Deliberate PHP_CodeSniffer violations on the PSR-12 standard:\n' +
      '//   - opening brace on the declaration line (PSR12.Functions)\n' +
      '//   - uppercase TRUE/FALSE (Generic.PHP.LowerCaseConstant)\n' +
      'function bad_lint($flag){ if ($flag === TRUE){ return 1; } return FALSE; }\n',
    duplications:
      '<?php\n' +
      '// Two near-identical functions — jscpd should detect this clone with\n' +
      '// default thresholds (--min-lines 5 --min-tokens 50).\n' +
      'function summarize_items_a(array $items): float\n' +
      '{\n' +
      '    $total = 0;\n' +
      '    $sumPositive = 0;\n' +
      '    $sumNegative = 0;\n' +
      '    $countPositive = 0;\n' +
      '    $countNegative = 0;\n' +
      '    foreach ($items as $item) {\n' +
      '        if ($item > 0) {\n' +
      '            $total = $total + $item;\n' +
      '            $sumPositive = $sumPositive + $item;\n' +
      '            $countPositive = $countPositive + 1;\n' +
      '        } else {\n' +
      '            $total = $total - $item;\n' +
      '            $sumNegative = $sumNegative + $item;\n' +
      '            $countNegative = $countNegative + 1;\n' +
      '        }\n' +
      '    }\n' +
      '    $avgPos = $countPositive > 0 ? $sumPositive / $countPositive : 0.0;\n' +
      '    $avgNeg = $countNegative > 0 ? $sumNegative / $countNegative : 0.0;\n' +
      '    return $total + $avgPos + $avgNeg;\n' +
      '}\n' +
      '\n' +
      'function summarize_items_b(array $items): float\n' +
      '{\n' +
      '    $total = 0;\n' +
      '    $sumPositive = 0;\n' +
      '    $sumNegative = 0;\n' +
      '    $countPositive = 0;\n' +
      '    $countNegative = 0;\n' +
      '    foreach ($items as $item) {\n' +
      '        if ($item > 0) {\n' +
      '            $total = $total + $item;\n' +
      '            $sumPositive = $sumPositive + $item;\n' +
      '            $countPositive = $countPositive + 1;\n' +
      '        } else {\n' +
      '            $total = $total - $item;\n' +
      '            $sumNegative = $sumNegative + $item;\n' +
      '            $countNegative = $countNegative + 1;\n' +
      '        }\n' +
      '    }\n' +
      '    $avgPos = $countPositive > 0 ? $sumPositive / $countPositive : 0.0;\n' +
      '    $avgNeg = $countNegative > 0 ? $sumNegative / $countNegative : 0.0;\n' +
      '    return $total + $avgPos + $avgNeg;\n' +
      '}\n',
    untested:
      '<?php\n' +
      '// Deliberate untested file fixture. No matching `*Test.php` exists;\n' +
      "// dxkit's `test-gaps` filename-match coverage source should report\n" +
      '// this in `gaps[]` with `hasMatchingTest: false`.\n' +
      'class UntestedModule\n' +
      '{\n' +
      '    public function describe(): string\n' +
      '    {\n' +
      "        return 'untested';\n" +
      '    }\n' +
      '}\n',
  },
  swift: {
    ext: 'swift',
    filenameCase: 'pascal',
    comment: '//',
    secrets:
      '// Hardcoded fake AWS access key — gitleaks should flag this as\n' +
      '// `aws-access-token`. Per-language secret fixture pre-staging the\n' +
      '// cross-ecosystem assertion surface.\n' +
      '//\n' +
      '// The key below is intentionally fake (low-entropy, no valid AWS\n' +
      '// checksum) so it cannot be used to authenticate.\n' +
      'let awsAccessKeyId = "AKIA1234567890ABCDEF"\n',
    badLint:
      '// Deliberate SwiftLint violations on default config:\n' +
      '//   - force_cast (error): `as!`\n' +
      '//   - force_try (error): `try!`\n' +
      'import Foundation\n' +
      '\n' +
      'func badLint() -> Int {\n' +
      '    let anyValue: Any = 42\n' +
      '    let forced = anyValue as! Int\n' +
      '    let data = try! JSONSerialization.data(withJSONObject: ["k": forced])\n' +
      '    return data.count\n' +
      '}\n',
    duplications:
      '// Two near-identical functions — jscpd should detect this clone with\n' +
      '// default thresholds (--min-lines 5 --min-tokens 50).\n' +
      'func summarizeItemsA(_ items: [Int]) -> Double {\n' +
      '    var total = 0\n' +
      '    var sumPositive = 0\n' +
      '    var sumNegative = 0\n' +
      '    var countPositive = 0\n' +
      '    var countNegative = 0\n' +
      '    for item in items {\n' +
      '        if item > 0 {\n' +
      '            total = total + item\n' +
      '            sumPositive = sumPositive + item\n' +
      '            countPositive = countPositive + 1\n' +
      '        } else {\n' +
      '            total = total - item\n' +
      '            sumNegative = sumNegative + item\n' +
      '            countNegative = countNegative + 1\n' +
      '        }\n' +
      '    }\n' +
      '    let avgPos = countPositive > 0 ? Double(sumPositive) / Double(countPositive) : 0.0\n' +
      '    let avgNeg = countNegative > 0 ? Double(sumNegative) / Double(countNegative) : 0.0\n' +
      '    return Double(total) + avgPos + avgNeg\n' +
      '}\n' +
      '\n' +
      'func summarizeItemsB(_ items: [Int]) -> Double {\n' +
      '    var total = 0\n' +
      '    var sumPositive = 0\n' +
      '    var sumNegative = 0\n' +
      '    var countPositive = 0\n' +
      '    var countNegative = 0\n' +
      '    for item in items {\n' +
      '        if item > 0 {\n' +
      '            total = total + item\n' +
      '            sumPositive = sumPositive + item\n' +
      '            countPositive = countPositive + 1\n' +
      '        } else {\n' +
      '            total = total - item\n' +
      '            sumNegative = sumNegative + item\n' +
      '            countNegative = countNegative + 1\n' +
      '        }\n' +
      '    }\n' +
      '    let avgPos = countPositive > 0 ? Double(sumPositive) / Double(countPositive) : 0.0\n' +
      '    let avgNeg = countNegative > 0 ? Double(sumNegative) / Double(countNegative) : 0.0\n' +
      '    return Double(total) + avgPos + avgNeg\n' +
      '}\n',
    untested:
      '// Deliberate untested file fixture. No matching `*Tests.swift` exists;\n' +
      "// dxkit's `test-gaps` filename-match coverage source should report\n" +
      '// this in `gaps[]` with `hasMatchingTest: false`.\n' +
      'struct UntestedModule {\n' +
      '    func describe() -> String {\n' +
      '        "untested"\n' +
      '    }\n' +
      '}\n',
  },
  ruby: {
    ext: 'rb',
    filenameCase: 'snake',
    comment: '#',
    secrets:
      '# Hardcoded fake AWS access key — gitleaks should flag this as\n' +
      '# `aws-access-token`. Per-language secret fixture pre-staging the\n' +
      '# cross-ecosystem assertion surface.\n' +
      '#\n' +
      '# The key below is intentionally fake (low-entropy, no valid AWS\n' +
      '# checksum) so it cannot be used to authenticate.\n' +
      'AWS_ACCESS_KEY_ID = "AKIA1234567890ABCDEF"\n',
    badLint:
      '# Deliberate RuboCop violations on default config:\n' +
      '#   - Lint/UselessAssignment (unused_var)\n' +
      '#   - Style/RedundantReturn (return at end of method)\n' +
      'def bad_lint\n' +
      '  unused_var = 42\n' +
      '  return 0\n' +
      'end\n',
    duplications:
      '# Two near-identical methods — jscpd should detect this clone with\n' +
      '# default thresholds (--min-lines 5 --min-tokens 50).\n' +
      'def summarize_items_a(items)\n' +
      '  total = 0\n' +
      '  sum_positive = 0\n' +
      '  sum_negative = 0\n' +
      '  count_positive = 0\n' +
      '  count_negative = 0\n' +
      '  items.each do |item|\n' +
      '    if item > 0\n' +
      '      total = total + item\n' +
      '      sum_positive = sum_positive + item\n' +
      '      count_positive = count_positive + 1\n' +
      '    else\n' +
      '      total = total - item\n' +
      '      sum_negative = sum_negative + item\n' +
      '      count_negative = count_negative + 1\n' +
      '    end\n' +
      '  end\n' +
      '  avg_pos = count_positive > 0 ? sum_positive.to_f / count_positive : 0.0\n' +
      '  avg_neg = count_negative > 0 ? sum_negative.to_f / count_negative : 0.0\n' +
      '  total + avg_pos + avg_neg\n' +
      'end\n' +
      '\n' +
      'def summarize_items_b(items)\n' +
      '  total = 0\n' +
      '  sum_positive = 0\n' +
      '  sum_negative = 0\n' +
      '  count_positive = 0\n' +
      '  count_negative = 0\n' +
      '  items.each do |item|\n' +
      '    if item > 0\n' +
      '      total = total + item\n' +
      '      sum_positive = sum_positive + item\n' +
      '      count_positive = count_positive + 1\n' +
      '    else\n' +
      '      total = total - item\n' +
      '      sum_negative = sum_negative + item\n' +
      '      count_negative = count_negative + 1\n' +
      '    end\n' +
      '  end\n' +
      '  avg_pos = count_positive > 0 ? sum_positive.to_f / count_positive : 0.0\n' +
      '  avg_neg = count_negative > 0 ? sum_negative.to_f / count_negative : 0.0\n' +
      '  total + avg_pos + avg_neg\n' +
      'end\n',
    untested:
      '# Deliberate untested file fixture. No matching `_spec.rb` /\n' +
      "# `_test.rb` exists; dxkit's `test-gaps` filename-match coverage\n" +
      '# source should report this in `gaps[]` with `hasMatchingTest: false`.\n' +
      'class UntestedModule\n' +
      '  def describe\n' +
      '    "untested"\n' +
      '  end\n' +
      'end\n',
  },
};

const FIXTURE_NAMES = ['secrets', 'badLint', 'duplications', 'untested'];

function fixtureFilename(concern, profile) {
  // pascal: Secrets.kt, BadLint.kt, Duplications.kt, UntestedModule.kt
  // snake:  secrets.py, bad_lint.py, duplications.py, untested_module.py
  const pascalNames = {
    secrets: 'Secrets',
    badLint: 'BadLint',
    duplications: 'Duplications',
    untested: 'UntestedModule',
  };
  const snakeNames = {
    secrets: 'secrets',
    badLint: 'bad_lint',
    duplications: 'duplications',
    untested: 'untested_module',
  };
  const base = profile.filenameCase === 'snake' ? snakeNames[concern] : pascalNames[concern];
  return `${base}.${profile.ext}`;
}

function writeBenchmarkFixtures(id, displayName, fixtureDir) {
  const profile = FIXTURE_PROFILES[id] ?? GENERIC_FIXTURE_STUB;
  const isGeneric = !FIXTURE_PROFILES[id];
  if (isGeneric) {
    info(
      `no FIXTURE_PROFILES entry for '${id}' — writing TODO-stub fixtures. ` +
        `Add a profile to scripts/scaffold-language.js for the next scaffold.`,
    );
  }
  for (const concern of FIXTURE_NAMES) {
    const filename = fixtureFilename(concern, profile);
    const headerLines = [
      `${profile.comment} Per-language ${concern} fixture, ${displayName} row.`,
      `${profile.comment} Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.`,
      '',
    ];
    const content = headerLines.join('\n') + profile[concern];
    writeIfMissing(path.join(fixtureDir, filename), content);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2) {
  die(
    'Usage: npm run new-lang <id> "<displayName>"\n' +
      '  Example: npm run new-lang kotlin "Kotlin (Android)"',
  );
}

const id = args[0];
const displayName = args[1];

if (!/^[a-z][a-z0-9]*$/.test(id)) {
  die(
    `Invalid id "${id}" — must be lowercase letters/digits, starting with a letter ` +
      `(e.g. "kotlin", "swift").`,
  );
}

// ─── 1. Pack stub: src/languages/<id>.ts ────────────────────────────────────

const PACK_TEMPLATE = `import { fileExists } from '../analyzers/tools/runner';
import type { LanguageSupport } from './types';

// TODO(${id}): implement detection logic — return true when this is a
// ${displayName} project. Common signals: a manifest file (package.json,
// build.gradle.kts, Package.swift) or a source file at known locations.
function detect${capitalize(id)}(cwd: string): boolean {
  // Example:
  // return fileExists(cwd, 'build.gradle.kts') || fileExists(cwd, 'Package.swift');
  return false;
}

export const ${id}: LanguageSupport = {
  id: '${id}',
  displayName: '${displayName}',

  // TODO(${id}): line-comment syntax used by this language. Drives the
  // allowlist feature's inline-annotation insertion. Required for any
  // pack that supports inline allowlists (every pack today).
  //   Hash-style:    { lineComment: '#' }                 // python, ruby, shell
  //   Slash-style:   { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' }
  //                    // typescript, go, rust, csharp, kotlin, java
  // Block-comment fields are reserved for files where line-comment
  // syntax is unavailable. Omit if not applicable for this language.
  //
  // The placeholder below is intentionally empty so the languages-
  // contract test FAILS until the contributor fills it in (the
  // assertion checks lineComment.length > 0). Do not "helpfully"
  // populate this with a default — that would let an unfilled
  // placeholder leak past CI.
  commentSyntax: { lineComment: '' },

  // TODO(${id}): list source-file extensions (with leading dot).
  sourceExtensions: [],

  // TODO(${id}): list test-file glob patterns. Patterns containing a slash
  // are path-anchored (matched via find -path); plain patterns are
  // basename-only (matched via find -name).
  testFilePatterns: [],

  // TODO(${id}): directories to exclude beyond the universal default
  // (node_modules, dist, vendor, etc. live in src/analyzers/tools/exclusions.ts).
  // Include build artifact dirs specific to this ecosystem.
  extraExcludes: [],

  detect: detect${capitalize(id)},

  // TODO(${id}): list TOOL_DEFS keys this pack relies on. Every entry must
  // exist in src/analyzers/tools/tool-registry.ts:TOOL_DEFS.
  tools: [],

  // TODO(${id}): semgrep ruleset slugs for this language (e.g. 'p/javascript').
  // Empty array if no first-class semgrep coverage exists.
  semgrepRulesets: [],

  // TODO(${id}): capability providers — see existing packs for examples.
  // capabilities: { depVulns, lint, coverage, imports, testFramework, licenses }
  //
  // If you add a \`depVulns\` provider, it MUST declare \`manifestPatterns\`
  // (its dependency manifests + lockfiles, e.g. ['package.json',
  // 'package-lock.json']). This is required by the DepVulnsProvider type AND
  // asserted non-empty by test/languages-contract.test.ts — the incremental
  // ref-based dep-audit skip needs it to tell whether a PR touched this pack's
  // dependencies (CLAUDE.md Rule 6).
  //
  // It must ALSO declare \`execution(cwd)\` (Rule 20): a lockfile-reading
  // audit via a registry tool needs nothing ({ hosts: ['any'], toolchains: [],
  // needsBuild: false, buildTarget: 'none', weight: 'cheap' }); an audit that
  // drives the ecosystem's own toolchain (npm audit → 'node', govulncheck →
  // 'go' + needsBuild) declares it.
  //
  // ALSO declare \`lockfilePatterns\` when the ecosystem has a lockfile (or a
  // manifest that independently resolves, like go.mod / requirements.txt):
  // exact basenames marking an INDEPENDENT dependency-resolution root. The
  // dep audit then runs once per nested root and merges — without it, a vuln
  // added to a nested sub-project's lockfile is invisible to the root audit.
  // Deliberately lockfiles, not plain manifests: a workspace member / Maven
  // module resolves from the root tree and is already covered.
  capabilities: {},

  // TODO(${id}): exported-symbol detection reliability for the graphify
  // symbol-extension pipeline. Drives the per-node \`exported\` field in
  // .dxkit/reports/graph.json + the explore CLI's api-surface query +
  // the dashboard viz's "exported only" filter.
  //   'full'        — top-level + member exports detected reliably
  //                   (TS export keyword, Go capitalization, Rust pub,
  //                    C# / Java / Kotlin public modifier)
  //   'partial'     — top-level reliable, member-level imperfect
  //                   (Python __all__ + public-name heuristic)
  //   'unreliable'  — static analysis cannot answer reliably
  //                   (Ruby metaprogramming defeats AST analysis)
  // The strategy string is a single-line human-readable description
  // surfaced when consumers explain exclusion or partial coverage.
  // Detection itself lives in src/analyzers/tools/graphify.ts.
  exportDetection: {
    reliability: 'unreliable',
    strategy: 'TODO(${id}): describe how exported symbols are detected for this language',
  },

  // TODO(${id}): OPTIONAL per-pack architectural descriptors — add the ones
  // this language has a surface for (omit the rest). All flow through the
  // \`all*\` registry helpers in src/languages/index.ts (CLAUDE.md Rule 6);
  // see typescript.ts for worked examples. The recipe-playbook test asserts a
  // pack's contributions reach each helper.
  //   architecturalShape  — primary-component / route / model path conventions
  //                         + vocabulary + test-gap taxonomy
  //   deepSast            — CodeQL / Snyk Code interprocedural engine support
  //   callGraphReliability — how much to trust graphify's caller counts here
  //   correctness         — the liveness floor (REQUIRED; wired below)

  // TODO(${id}): OPTIONAL httpFlow — UI→API flow extraction for this language.
  // Add it if the language has an HTTP client or web framework. The recipe is
  // DECLARATION-ONLY (zero extractor edits — CONTRIBUTING.md "Adding flow
  // support to a language pack" is the walkthrough):
  //   1. Declare \`treeSitterGrammars\` below (extension → logical grammar
  //      name). The wasm ships in tree-sitter-wasms; if the grammar has no
  //      shape row yet, add one in src/ast/grammar-shape.ts (most fit the
  //      shared callee-field factory) — test/languages-contract.test.ts
  //      loud-fails an httpFlow pack whose grammar is unshaped.
  //   2. Fill the descriptor. Construct families (see HttpFlowSupport in
  //      src/languages/types.ts, worked examples in typescript.ts/python.ts):
  //        clientCallees          — fetch(url)-style bare clients
  //        clientMethodCallees    — recv.get('/x'); \`bases\` = TRUSTED
  //                                 always-HTTP receivers (requests, httpx)
  //        routeDecorators        — bare verb decorators (@get('/x'))
  //        routeMemberDecorators  — member verb decorators (@app.get('/x'))
  //        routePathDecorators    — path + methods kwarg (@app.route(...))
  //        routeRouterCallees     — app.get('/x', handler) router calls
  //        routeCallees           — verb-less path(route, view) → ANY routes
  //        fileRoutes             — file-convention routing (route.ts under app/)
  //   3. Add a fixture under test/fixtures/analysis/ + a flow row in
  //      test/fixtures-analysis.test.ts, and a pack test like
  //      test/flow-extract-python.test.ts pinning YOUR declaration.
  //
  // httpFlow: { ... },
  // treeSitterGrammars: { '.${id}': '${id}' },

  // TODO(${id}): OPTIONAL modelSchema — data-model extraction for the schema
  // drift gate. Add it if the language has canonical model conventions (an
  // ORM, entity decorators, struct-tag serialization). DECLARATION-ONLY,
  // like httpFlow (CONTRIBUTING.md "Adding model-schema support" is the
  // walkthrough):
  //   1. \`treeSitterGrammars\` as above, PLUS a model-shape row in
  //      src/ast/grammar-model-shape.ts (class/field/heritage/tag syntax —
  //      verify every node/field name against a real parse;
  //      test/languages-contract.test.ts loud-fails an unshaped pack).
  //   2. Fill the descriptor (ModelSchemaSupport in src/languages/types.ts;
  //      worked examples typescript.ts/python.ts/go.ts):
  //        modelBaseClasses       — heritage markers (models.Model, BaseModel)
  //        weakModelBaseClasses   — too-generic names (Base): count only when
  //                                 a fieldCallees constructor corroborates
  //        modelDecorators        — @Entity / @Table / @dataclass
  //        structTagKeys          — Go-style tag markers (json/gorm)
  //        fieldCallees           — ORM field constructors (type + optionality;
  //                                 typeFrom: 'callee' | 'firstArg')
  //        transparentTypeWrappers— annotation wrappers to fold (Mapped[X])
  //        typeAliases            — lowercase lexical folds (charfield→string)
  //        schemaSignals          — manifest tokens for doctor discovery
  //      PRECISION-FIRST: a missed model is a disclosed gap; a false model
  //      floods the drift diff. When unsure, leave it out — schema.specs
  //      (OpenAPI/JSON Schema) is the honest fallback.
  //   3. Pin it: extend the pack test + a model fixture/row in
  //      test/fixtures-analysis.test.ts, then real-repo-validate the wave
  //      (extraction accuracy + mutation battery — see the release gate in
  //      the feature's design history).
  //
  // modelSchema: { ... },

  // REQUIRED(${id}): correctness floor — the loop-safety liveness gate. Two PURE
  // command builders; the runner (src/analyzers/correctness/run.ts) executes
  // them and owns the fail-open/fail-closed + timeout policy — a pack NEVER
  // shells out itself (CLAUDE.md Rule 6 + Rule 15, arch-check enforced). Both
  // return a { label, bin, args } command or null (skip). \`bin\` is resolved on
  // PATH, or may be an absolute interpreter path the pack resolved itself. The
  // field is REQUIRED on LanguageSupport — this scaffold wires a DORMANT (both
  // builders return null) provider so the pack compiles; fill in real commands
  // before ship. syntaxCheck = the cheap "does it compile/parse" check every
  // language can give; affectedTests = run the tests the change reaches (native
  // impact-selection where the ecosystem supports it, else a coarser fallback
  // with CI's full scope as the backstop). See typescript.ts / python.ts, and
  // jvm-build.ts for a shared multi-build-system provider.
  correctness: {
    // REQUIRED(${id}) — Rule 20: what the floor NEEDS from the environment
    // that runs it. PURE and REPO-INTRINSIC (read repo files only — never
    // PATH, never process.platform; the contract test rejects
    // non-determinism). The dormant floor below runs nothing, so the empty
    // requirement is accurate NOW — when you fill in real commands, declare
    // their truth: the ambient toolchain (a ToolchainId from
    // src/execution/toolchains.ts — register it there if new), needsBuild
    // for compiled stacks, and hosts narrowed when the BUILD is OS-locked
    // (csharp derives hosts from the repo's TFMs — the worked example).
    execution(_cwd) {
      // TODO(${id}): declare the floor's real requirement, e.g.
      //   return { hosts: ['any'], toolchains: ['${id}'], needsBuild: true,
      //            buildTarget: 'discovered', weight: 'build' };
      return {
        hosts: ['any'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      };
    },
    syntaxCheck(_ctx) {
      // TODO(${id}): compile/typecheck the change, e.g.
      //   return { label: 'compile', bin: '${id}', args: ['build'] };
      return null;
    },
    affectedTests(_ctx) {
      // TODO(${id}): run the tests the change reaches. ctx.scope === 'affected'
      // → the changed subset (fast surface); 'full' (or empty ctx.changedFiles)
      // → the whole suite (CI backstop).
      return null;
    },
  },

  // Lint-GATE provider (custom-check flagship): the linter command that gates
  // NET-NEW lint findings, plus a regex mapping its output to per-location
  // findings. Every pack declares this slot (the contract test forces it). This
  // scaffold ships a DORMANT gate (returns null) so the pack compiles; wire a
  // real one before ship IF the language has a zero-config standalone linter
  // with a stable per-line format (eslint/ruff/golangci-lint/rubocop/clippy/
  // ktlint are the worked examples). If not (linter needs project config, e.g.
  // Java checkstyle), leave it dormant — users gate their linter via a
  // .dxkit/policy.json \`checks\` entry.
  lintGate: {
    // Rule 20 (same contract as correctness.execution above): the dormant
    // gate needs nothing; declare the real requirement with the real command
    // (a JVM-jar linter needs 'jdk'; a build-stream gate like MSBuild needs
    // the SDK + needsBuild + TFM-derived hosts — see csharp.ts).
    execution(_cwd) {
      // TODO(${id}): update alongside lintCommand.
      return {
        hosts: ['any'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      };
    },
    lintCommand(_ctx) {
      // TODO(${id}): resolve the linter (findTool(TOOL_DEFS.<tool>, ctx.cwd)) and
      // return { bin, args, parse, expectedExit }; or return null (dormant).
      //
      // PREFER a STRUCTURED parse over your linter's native machine-readable
      // output (its --format json / SARIF / NDJSON mode) — a display format is
      // for humans, and every regex over one eventually diverges from it (the
      // shipped 3.9 class: eslint's display render dropped findings its JSON
      // carried; clippy's short format omitted the lint NAME, colliding
      // identities). Map it to { file, line?, rule?, message? } entries; the
      // seam boundary relativizes paths, dedupes, and caps — your parser must
      // only be TOTAL (garbage in → [] out, never a throw; the contract test
      // feeds it garbage). Helpers: ./capabilities/lint-structured
      // (extractJsonBlob for a JSON blob amid combined-stream noise, jsonLines
      // for NDJSON, asRecord/str/num for defensive field access).
      //
      //   parse: { kind: 'structured', label: '<tool>-json', parse: parse<Tool>Json }
      //
      // Fall back to { kind: 'regex', pattern } — named groups
      // (?<file>)(?<line>)(?<rule>)(?<message>) — ONLY when the linter has no
      // machine-readable output (today only MSBuild's diagnostic stream), and
      // say why in a comment. Either way add relative + absolute fixtures in
      // test/custom-checks/lint-formats.test.ts (the coverage guard fails
      // without them).
      return null;
    },
    recallInputs(_ctx) {
      // What determines what THIS linter can SEE, beyond its argv (Rule 19):
      // its own version, its PLUGIN versions, its config file. Without these, a
      // plugin bump adds rules under an unchanged command and every finding the
      // new rules report is blamed on whoever opens the next PR.
      //
      // TODO(${id}): when \`lintCommand\` returns a real command, populate this:
      //   return {
      //     ...toolVersionInput(TOOL_DEFS.<tool>, _ctx.cwd, '<tool>'),
      //     ...hashFirstConfig(_ctx.cwd, ['<linter>.toml', '.<linter>rc']),
      //   };
      // Helpers live in ./capabilities/recall-inputs. \`_ctx.mode\` is
      // 'resolved' (what ran) or 'locked' (declared ranges).
      //
      // Inputs MUST be stable across MACHINES, not just runs: never an absolute
      // path or a timestamp. An unstable input reads as permanent drift and
      // silently turns the gate off while looking healthy.
      //
      // \`{}\` is correct while the gate is dormant — nothing runs, so nothing
      // can drift.
      return {};
    },
  },

  // ─── LP-recipe metadata (populate every field) ─────────────────────────

  // Bash permission entries for .claude/settings.json. Cover the test/build/
  // lint commands a developer would run from Claude Code.
  permissions: [/* TODO: e.g. 'Bash(${id} build:*)', 'Bash(${id} test:*)' */],

  // Filename under src-templates/.claude/rules/. Created by the scaffolder.
  ruleFile: '${id}.md',

  // CLI binaries 'vyuh-dxkit doctor' checks for. Adding the language's
  // primary toolchain binary here is the minimum.
  cliBinaries: [/* TODO: e.g. 'kotlinc', 'gradle' */],

  // Default language version surfaced in DEFAULT_VERSIONS and the
  // <KEY>_VERSION template var — the FLOOR when detection misses.
  defaultVersion: 'TODO',

  // Detect the toolchain version this repo targets from its manifest
  // (e.g. a .csproj TargetFramework, go.mod's \`go X.Y\`, a .python-version).
  // Return undefined when undetectable (consumers fall back to defaultVersion).
  // This is what makes CI + the devcontainer provision the SDK the repo
  // actually targets instead of the hardcoded default — DON'T skip it. Use the
  // readRepoFile / repoFileExists helpers in ./version-detect (and walkPaths for
  // deep manifest discovery). If your \`ciSetup\` step passes a version input, set
  // \`versionInput\` on that step so the detected version is substituted in.
  detectVersion(cwd) {
    // TODO: read this language's version manifest and return e.g. '3.12'.
    void cwd;
    return undefined;
  },

  // Optional: lookup key in DetectedStack['versions']. Defaults to id.
  // Only override when legacy template/config naming differs (typescript
  // pack uses versionKey: 'node' for historical reasons).
  // versionKey: '${id}',
};
`;

const packPath = path.join(REPO_ROOT, 'src', 'languages', `${id}.ts`);
writeIfMissing(packPath, PACK_TEMPLATE);

// ─── 2. Test stub: test/languages-<id>.test.ts ──────────────────────────────
// Recipe v2 (Phase 10j.1): includes the fixture-loading helper, the
// real-fixture provenance docstring, and parser-test stubs for the
// standard capability surface (lint / coverage / depVulns / imports).
// The C# defect lesson is encoded in the provenance comment — synthetic
// fixtures drift silently from real tool output.

const TEST_TEMPLATE = `/**
 * ${displayName} pack — pack-specific tests.
 *
 * RECIPE NOTE — two distinct parser classes, two distinct test
 * conventions (Recipe v4 G_v4_1):
 *
 * 1. **Source-text parsers** (\`extract${capitalize(id)}ImportsRaw\`,
 *    \`map${capitalize(id)}Severity\`, anything that reads
 *    ${displayName} source code or severity-string mappings) →
 *    **synthetic inline strings**. No fixture file. Language syntax
 *    is stable; real-fixture provenance adds toil without surfacing
 *    bugs.
 *
 * 2. **Tool-output parsers** (\`parse${capitalize(id)}LintOutput\`,
 *    \`parse${capitalize(id)}CoverageOutput\`,
 *    \`parse${capitalize(id)}DepVulnsOutput\`, anything that reads
 *    JSON/XML/text from an external tool's stdout) → **REAL fixture
 *    file** under \`test/fixtures/raw/${id}/\`, captured via the
 *    commands in that dir's \`HARVEST.md\`. The C# defect (Phase
 *    10h.6.8 — parser passed synthetic-JSON unit tests for 5 months
 *    while returning 0 findings on real \`dotnet list package
 *    --vulnerable\` output) is the reason real bytes beat hand-crafted.
 *
 * The split matters because the failure modes differ: source-text
 * parsers fail when the language grammar changes (rare, loud); tool-
 * output parsers fail when the upstream tool ships a schema tweak
 * (frequent, silent). Real fixtures defend against the latter.
 *
 * TODO(${id}): replace the placeholder fixture names below with the
 * actual files you harvest, and the parser names with the actual
 * exports from src/languages/${id}.ts.
 */

import { describe, it, expect } from 'vitest';
// import * as fs from 'fs';
// import * as path from 'path';
import { ${id} } from '../src/languages/${id}';
// Source-text parsers (synthetic inline tests — see section A below):
// import {
//   extract${capitalize(id)}ImportsRaw,
//   map${capitalize(id)}Severity,
// } from '../src/languages/${id}';
//
// Tool-output parsers (real-fixture tests — see section B below):
// import {
//   parse${capitalize(id)}LintOutput,
//   parse${capitalize(id)}CoverageOutput,
//   parse${capitalize(id)}DepVulnsOutput,
// } from '../src/languages/${id}';

// const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', '${id}');
// function readFixture(name: string): string {
//   return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
// }

describe('${id} pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(${id}.id).toBe('${id}');
    expect(${id}.displayName).toBe('${displayName}');
  });

  // TODO(${id}): once capabilities land, assert the providers are wired:
  //   expect(${id}.capabilities?.depVulns).toBeDefined();
  //   expect(${id}.capabilities?.lint).toBeDefined();
  //   expect(${id}.capabilities?.coverage).toBeDefined();
  //   expect(${id}.capabilities?.imports).toBeDefined();
  //   expect(${id}.capabilities?.testFramework).toBeDefined();
});

// ═══════════════════════════════════════════════════════════════════════════
// Section A — Source-text parsers (synthetic inline strings, no fixture)
// ═══════════════════════════════════════════════════════════════════════════
//
// Test these with hand-crafted ${displayName} source snippets or
// severity-string examples. Language syntax is stable; real fixtures
// add toil without catching bugs at this layer.
//
// describe('map${capitalize(id)}Severity', () => {
//   it('tiers severity strings into dxkit four-tier scheme', () => {
//     // expect(map${capitalize(id)}Severity('error')).toBe('high');
//     // expect(map${capitalize(id)}Severity('warning')).toBe('medium');
//     // expect(map${capitalize(id)}Severity('info')).toBe('low');
//   });
// });
//
// describe('extract${capitalize(id)}ImportsRaw', () => {
//   it('extracts simple imports from source text', () => {
//     // const src = '<sample ${displayName} source code as a string literal>';
//     // expect(extract${capitalize(id)}ImportsRaw(src)).toEqual([...]);
//   });
// });

// ═══════════════════════════════════════════════════════════════════════════
// Section B — Tool-output parsers (REAL fixture from HARVEST.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// Test these against bytes the upstream tool actually emits. Capture
// commands live in \`test/fixtures/raw/${id}/HARVEST.md\`. Do NOT
// use synthetic JSON/XML strings here — see the C# defect lesson
// referenced in the file header.
//
// describe('parse${capitalize(id)}LintOutput', () => {
//   it('counts violations in the real fixture by severity tier', () => {
//     const raw = readFixture('lint-output.<ext>');
//     const counts = parse${capitalize(id)}LintOutput(raw);
//     expect(counts.high).toBeGreaterThan(0);
//   });
// });
//
// describe('parse${capitalize(id)}CoverageOutput', () => {
//   it('computes line-level coverage from the real fixture', () => {
//     const raw = readFixture('coverage-output.<ext>');
//     const result = parse${capitalize(id)}CoverageOutput(raw, 'coverage-output.<ext>', '/');
//     expect(result).not.toBeNull();
//     expect(result!.linePercent).toBeGreaterThan(0);
//   });
// });
//
// describe('parse${capitalize(id)}DepVulnsOutput', () => {
//   it('extracts findings from the real tool output', () => {
//     const raw = readFixture('depvulns-output.json');
//     const { findings } = parse${capitalize(id)}DepVulnsOutput(raw);
//     expect(findings.length).toBeGreaterThan(0);
//   });
// });
`;

const testPath = path.join(REPO_ROOT, 'test', `languages-${id}.test.ts`);
writeIfMissing(testPath, TEST_TEMPLATE);

// ─── 2b. Raw fixture dir + HARVEST.md ────────────────────────────────────────
// Recipe v2: each pack ships a HARVEST.md that documents how to capture
// real tool output as committed fixtures. Future packs run these
// commands to validate parsers against real bytes (the C# defect
// lesson). The dir is created with .gitkeep so it stays under version
// control even before harvest.

const rawFixtureDir = path.join(REPO_ROOT, 'test', 'fixtures', 'raw', id);
ensureDir(rawFixtureDir);
const HARVEST_TEMPLATE = `# ${displayName} — raw tool-output fixture harvest

Capture real ${displayName} tool output and commit the bytes here. Unit
tests in \`test/languages-${id}.test.ts\` parse these fixtures, NOT
hand-crafted strings. The C# defect (Phase 10h.6.8 — parser passed
synthetic-JSON unit tests for 5 months while returning 0 findings on
real \`dotnet list package --vulnerable\` output) is the cautionary
tale that justifies this discipline.

## Standard fixtures

| File                  | Producer                                    | What it validates                          |
| --------------------- | ------------------------------------------- | ------------------------------------------ |
| \`lint-output.<ext>\` | the pack's linter (e.g. detekt, ruff)       | parse\${Tool}LintOutput correctness        |
| \`coverage-output.<ext>\` | the pack's coverage reporter            | parse\${Tool}CoverageOutput correctness    |
| \`depvulns-output.json\` | osv-scanner / pip-audit / cargo-audit etc. | parse\${Tool}DepVulnsOutput correctness   |

## Capture commands

TODO(${id}): replace these placeholder commands with the actual capture
invocations for ${displayName}'s tools. Run from a tiny realistic
project (commit fake credentials/known-vuln deps that surface findings).

\`\`\`bash
# Example shape — adapt per tool:
# <tool> --format <fmt> <input> > test/fixtures/raw/${id}/lint-output.<ext>
# <tool> --report json > test/fixtures/raw/${id}/coverage-output.<ext>
# <vuln-tool> scan --format json > test/fixtures/raw/${id}/depvulns-output.json
\`\`\`

## Why committed

Real-output fixtures stay byte-identical to what the upstream tool
emits. \`.prettierignore\` excludes \`test/fixtures/raw/\` so reformatting
doesn't drift the bytes. Re-harvest only when:
  - The upstream tool ships a JSON/XML schema change
  - The fixture's project was edited (different finding set)
`;
writeIfMissing(path.join(rawFixtureDir, 'HARVEST.md'), HARVEST_TEMPLATE);

// ─── 3. Fixture skeleton: test/fixtures/benchmarks/<id>/ ────────────────────

const fixtureDir = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmarks', id);
ensureDir(fixtureDir);
const FIXTURE_README = `# ${displayName} benchmark fixture

Pinned vulnerable dep used by \`test/integration/cross-ecosystem.test.ts\`
to validate the ${displayName} pack across the cross-ecosystem matrix
(secrets / lint / dups / test-gaps + per-pack depVulns).

## Standard 5-file convention

Each language pack's benchmark dir ships these five files. Names are
case-sensitive and the cross-ecosystem matrix asserts findings on each.
Reference shape: \`test/fixtures/benchmarks/python/\` (most-canonical),
\`test/fixtures/benchmarks/kotlin/\` (most-recent / Recipe-v2 reference).

| File                       | Concern        | What flags it                                           |
| -------------------------- | -------------- | ------------------------------------------------------- |
| \`<manifest>\`             | depVulns       | the pack's vuln scanner via OSV.dev or native CLI      |
| \`BadLint.<ext>\`          | lint           | the pack's linter on default config                     |
| \`Duplications.<ext>\`     | duplications   | jscpd (language-agnostic clone detector)                |
| \`Secrets.<ext>\`          | secrets        | gitleaks (AKIA pattern is the standard fake token)      |
| \`UntestedModule.<ext>\`   | test-gaps      | filename-match coverage source (no companion test file) |

## TODO checklist for ${displayName}

  - [ ] Pick the right \`<manifest>\` osv-scanner / native scanner reads
        (e.g. \`pom.xml\` for Maven, \`Cargo.lock\` for Rust). Pin a
        known-vulnerable version of a stable popular package.
  - [ ] Recipe v3 / G4 scaffolded the standard 4 fixtures
        (Secrets / BadLint / Duplications / UntestedModule). Verify
        they suit ${displayName}'s default linter ruleset and adjust
        if needed; if no FIXTURE_PROFILES entry exists for this
        language, the files are TODO stubs you must fill in.
  - [ ] Register in \`test/integration/cross-ecosystem.test.ts\` —
        add a row to \`BENCHMARK_LANGUAGES\` and a
        \`cross-ecosystem benchmarks — ${displayName}\` describe block.
  - [ ] Run \`npm run test:run\` — all kotlin matrix rows + the
        ${displayName} benchmark depVulns test should pass (or skip on
        toolchain availability).

## Fixture vs raw

Fixtures here are full mini-projects exercised end-to-end by the
matrix tests. The \`test/fixtures/raw/${id}/\` directory holds
captured tool-output bytes for unit-test parser validation — see that
dir's HARVEST.md for capture commands.
`;
writeIfMissing(path.join(fixtureDir, 'README.md'), FIXTURE_README);

// ─── 3b. G4 (Recipe v3): templated standard-4 fixture stubs ────────────────
// Writes Secrets / BadLint / Duplications / UntestedModule files using
// the per-language profile from FIXTURE_PROFILES. Saves ~30 min of
// hand-cribbing from kotlin/python on each new pack. Falls back to
// generic TODO stubs when no profile exists for the language.

writeBenchmarkFixtures(id, displayName, fixtureDir);

// ─── 4. Rule file stub: src-templates/.claude/rules/<id>.md ─────────────────

const RULE_TEMPLATE = `# ${displayName} — Claude rules

TODO(${id}): document conventions Claude should follow when writing
${displayName} code in this project.

Topics that work well in this file:
  - Preferred test framework / commands
  - Lint rules and exceptions
  - Module structure conventions
  - Common idioms and anti-patterns
  - Build / format commands
`;

writeIfMissing(
  path.join(REPO_ROOT, 'src-templates', '.claude', 'rules', `${id}.md`),
  RULE_TEMPLATE,
);

// ─── 5. Update src/types.ts (extend LanguageId union) ───────────────────────
// Post-10f.4: this is the ONLY type-system edit required for a new pack.
// `DetectedStack.languages` is `Record<LanguageId, boolean>` and updates
// transparently when LanguageId gains a member.

const typesPath = path.join(REPO_ROOT, 'src', 'types.ts');
let typesSrc = fs.readFileSync(typesPath, 'utf-8');

// Match `export type LanguageId = '...' | '...' | ...;` (single-line form).
const langIdUnionRe = /(export type LanguageId\s*=\s*)([^;]+)(;)/;
const langIdMatch = typesSrc.match(langIdUnionRe);
if (!langIdMatch) {
  die(
    'Could not locate `export type LanguageId = ...;` in src/types.ts. ' +
      'Manual edit required: add the new id to the LanguageId union.',
  );
}

const existingUnion = langIdMatch[2];
if (new RegExp(`['"]${id}['"]`).test(existingUnion)) {
  info(`src/types.ts already has '${id}' in LanguageId union`);
} else {
  const newUnion = `${existingUnion.trim()} | '${id}'`;
  typesSrc = typesSrc.replace(langIdUnionRe, `$1${newUnion}$3`);
  fs.writeFileSync(typesPath, typesSrc);
  ok(`updated src/types.ts (extended LanguageId union with '${id}')`);
}

// ─── 6. Update src/languages/index.ts (register in LANGUAGES) ──────────────

const indexPath = path.join(REPO_ROOT, 'src', 'languages', 'index.ts');
let indexSrc = fs.readFileSync(indexPath, 'utf-8');

const importLine = `import { ${id} } from './${id}';`;
const registryRe = /(export const LANGUAGES: readonly LanguageSupport\[\] = \[)([^\]]+)(\];)/;

if (indexSrc.includes(importLine)) {
  info(`src/languages/index.ts already imports ${id}`);
} else {
  // Insert import after the last existing pack import.
  const packImportRe = /^import \{ \w+ \} from '\.\/\w+';$/gm;
  const matches = [...indexSrc.matchAll(packImportRe)];
  if (matches.length === 0) {
    info(
      `Could not find pack imports in src/languages/index.ts — please add manually:\n  ${importLine}`,
    );
  } else {
    const last = matches[matches.length - 1];
    const insertAt = last.index + last[0].length;
    indexSrc = indexSrc.slice(0, insertAt) + `\n${importLine}` + indexSrc.slice(insertAt);
  }
  // Append to the LANGUAGES array.
  if (!registryRe.test(indexSrc)) {
    die('Could not locate LANGUAGES array in src/languages/index.ts.');
  }
  indexSrc = indexSrc.replace(registryRe, (_match, prefix, contents, suffix) => {
    // G1 audit follow-up: strip both leading whitespace AND trailing
    // comma + whitespace before append. Multi-line shape from Prettier
    // is `[\n  python,\n  ...,\n  java,\n]` — `contents.trim()` alone
    // leaves the trailing comma in place and produced `java,, ruby`
    // (double comma) on the first scaffold against the multi-line form.
    const normalized = contents.replace(/,?\s*$/, '').replace(/^\s+/, '');
    return `${prefix}${normalized}, ${id}${suffix}`;
  });
  fs.writeFileSync(indexPath, indexSrc);
  ok(`updated src/languages/index.ts (registered ${id} in LANGUAGES)`);
}

// ─── 7. CHANGELOG [Unreleased] stub ────────────────────────────────────────
// Append a TODO line under the existing `## [Unreleased]` section so
// the developer doesn't forget to write release notes at ship time.
// Idempotent — skips if a line for this pack already exists.

const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
if (fs.existsSync(changelogPath)) {
  let changelogSrc = fs.readFileSync(changelogPath, 'utf-8');
  const stubLine = `- **TODO: \`${displayName}\` pack scaffolded.** Replace with real release notes (capabilities landed, defects closed, recipe gaps surfaced) before ship.`;
  if (changelogSrc.includes(stubLine)) {
    info(`CHANGELOG.md already has a stub for '${id}'`);
  } else {
    // Insert one line below `## [Unreleased]` plus its trailing blank.
    const unreleasedRe = /^(## \[Unreleased\]\n\n?)/m;
    if (!unreleasedRe.test(changelogSrc)) {
      info(
        'CHANGELOG.md missing `## [Unreleased]` section — skipping G6 stub. ' +
          'Add the section manually and re-run if needed.',
      );
    } else {
      changelogSrc = changelogSrc.replace(unreleasedRe, `$1${stubLine}\n\n`);
      fs.writeFileSync(changelogPath, changelogSrc);
      ok(`updated CHANGELOG.md ([Unreleased] stub for '${id}')`);
    }
  }
}

// ─── Next-steps checklist ────────────────────────────────────────────────────

// CLI output below — annotated with slop-ok per the project convention.
const HR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const nextSteps = [
  '',
  HR,
  `  ${displayName} pack scaffolded — next steps:`,
  HR,
  '',
  `  1. Implement detect${capitalize(id)}() in src/languages/${id}.ts`,
  `  2. Populate commentSyntax, sourceExtensions, testFilePatterns, tools, cliBinaries, defaultVersion, permissions`,
  `  3. Add TOOL_DEFS entries for ${id}'s tools in src/analyzers/tools/tool-registry.ts`,
  `  4. Harvest real tool-output bytes per test/fixtures/raw/${id}/HARVEST.md`,
  `     (the C# defect lesson — parsers MUST be unit-tested against real bytes)`,
  `  5. Implement capability providers + parsers (capabilities.depVulns / lint / coverage / etc.)`,
  `  6. Fill in parser-test stubs in test/languages-${id}.test.ts with the harvested fixtures`,
  `  7. test/fixtures/benchmarks/${id}/ — Secrets/BadLint/Duplications/UntestedModule scaffolded (G4);`,
  `     fill in the dep manifest (e.g. Gemfile, pom.xml, requirements.txt) by hand`,
  `  8. Register in test/integration/cross-ecosystem.test.ts: BENCHMARK_LANGUAGES row +`,
  `     "cross-ecosystem benchmarks — ${displayName}" describe block (extend lint.expectedTool union)`,
  `  9. Add ${id} toolchain install to .github/workflows/ci.yml`,
  ` 10. Document the toolchain requirement in CONTRIBUTING.md "Cross-ecosystem benchmarks"`,
  ` 11. Update README.md ecosystem coverage table + CLAUDE.md path globs for the new language`,
  `     (Recipe v3 / G5 — bash scripts/check-docs-coverage.sh fails until you do)`,
  ` 12. Curate the CHANGELOG.md "[Unreleased]" stub before ship (G6 wrote a placeholder)`,
  '',
  `  Validate: npm run test:run`,
  `  Recipe enforcement runs in pre-commit (architecture greps + contract tests + recipe-playbook synthesis + doc coverage).`,
  '',
];
console.log(nextSteps.join('\n')); // slop-ok
