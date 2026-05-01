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
  capabilities: {},

  // ─── LP-recipe metadata (populate every field) ─────────────────────────

  // Bash permission entries for .claude/settings.json. Cover the test/build/
  // lint commands a developer would run from Claude Code.
  permissions: [/* TODO: e.g. 'Bash(${id} build:*)', 'Bash(${id} test:*)' */],

  // Filename under src-templates/.claude/rules/. Created by the scaffolder.
  ruleFile: '${id}.md',

  // Per-pack templates scaffolded by 'vyuh-dxkit init'.
  templateFiles: [],

  // CLI binaries 'vyuh-dxkit doctor' checks for. Adding the language's
  // primary toolchain binary here is the minimum.
  cliBinaries: [/* TODO: e.g. 'kotlinc', 'gradle' */],

  // Default language version surfaced in DEFAULT_VERSIONS and the
  // <KEY>_VERSION template var.
  defaultVersion: 'TODO',

  // Optional: lookup key in DetectedStack['versions']. Defaults to id.
  // Only override when legacy template/config naming differs (typescript
  // pack uses versionKey: 'node' for historical reasons).
  // versionKey: '${id}',

  // Renders this pack's section under languages: in .project.yaml.
  projectYamlBlock: ({ config, enabled }) =>
    [
      \`  ${id}:\`,
      \`    enabled: \${enabled}\`,
      \`    version: "\${config.versions['${id}' as keyof typeof config.versions] ?? 'TODO'}"\`,
    ].join('\\n'),
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
 * RECIPE NOTE: each parser exercised here SHOULD be tested against a
 * REAL fixture file under \`test/fixtures/raw/${id}/\`, not a synthetic
 * JSON/XML string. The C# defect lesson (5 months silent, parsers
 * passed unit tests on synthetic JSON but returned 0 findings on real
 * input — fixed in Phase 10h.6.8) is the reason. Capture commands live
 * in \`test/fixtures/raw/${id}/HARVEST.md\`.
 *
 * TODO(${id}): replace the placeholder fixture names below with the
 * actual files you harvest, and the parser names with the actual
 * exports from src/languages/${id}.ts.
 */

import { describe, it, expect } from 'vitest';
// import * as fs from 'fs';
// import * as path from 'path';
import { ${id} } from '../src/languages/${id}';
// import {
//   parse${capitalize(id)}LintOutput,
//   parse${capitalize(id)}CoverageOutput,
//   parse${capitalize(id)}DepVulnsOutput,
//   extract${capitalize(id)}ImportsRaw,
//   map${capitalize(id)}Severity,
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

// ─── Parser test stubs — uncomment + fill in once each parser exists ───────
//
// describe('map${capitalize(id)}Severity', () => {
//   it('tiers severity strings into dxkit four-tier scheme', () => {
//     // expect(map${capitalize(id)}Severity('error')).toBe('high');
//     // expect(map${capitalize(id)}Severity('warning')).toBe('medium');
//     // expect(map${capitalize(id)}Severity('info')).toBe('low');
//   });
// });
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
//
// describe('extract${capitalize(id)}ImportsRaw', () => {
//   it('extracts simple imports from source text', () => {
//     // const src = '<sample source>';
//     // expect(extract${capitalize(id)}ImportsRaw(src)).toEqual([...]);
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

// ─── 5. Template-configs dir: src-templates/configs/<id>/ ───────────────────

const configsDir = path.join(REPO_ROOT, 'src-templates', 'configs', id);
ensureDir(configsDir);
const CONFIGS_README = `Add per-pack template files here (e.g. \`build.gradle.kts.template\`,
\`Package.swift.template\`). Reference them from
\`src/languages/${id}.ts:templateFiles\`.

\`vyuh-dxkit init\` writes these to project root, skipping if the
output path already exists.
`;
writeIfMissing(path.join(configsDir, 'README.md'), CONFIGS_README);

// ─── 6. Update src/types.ts (extend LanguageId union) ───────────────────────
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

// ─── 7. Update src/languages/index.ts (register in LANGUAGES) ──────────────

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

// ─── 8. G6 (Recipe v3): CHANGELOG [Unreleased] stub ───────────────────────
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
  `  2. Populate sourceExtensions, testFilePatterns, tools, cliBinaries, defaultVersion, permissions`,
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
