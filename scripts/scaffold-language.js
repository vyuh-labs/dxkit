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
  - [ ] Write \`BadLint.<ext>\` with multiple deliberate violations the
        linter's default ruleset flags (multiple so at least one fires
        across version drift).
  - [ ] Write \`Duplications.<ext>\` with two near-identical helper
        functions sized comfortably above jscpd's defaults
        (\`--min-lines 5 --min-tokens 50\`).
  - [ ] Write \`Secrets.<ext>\` with a fake AKIA-pattern AWS key that
        matches gitleaks' default \`aws-access-token\` rule but is
        clearly bogus (low-entropy patterned digits).
  - [ ] Write \`UntestedModule.<ext>\` — simple class/function with no
        matching test file. Body should be lint-clean and clone-free.
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
    return `${prefix}${contents.trim()}, ${id}${suffix}`;
  });
  fs.writeFileSync(indexPath, indexSrc);
  ok(`updated src/languages/index.ts (registered ${id} in LANGUAGES)`);
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
  `  7. Populate test/fixtures/benchmarks/${id}/ — the standard 5 files (see fixture README)`,
  `  8. Register in test/integration/cross-ecosystem.test.ts: BENCHMARK_LANGUAGES row +`,
  `     "cross-ecosystem benchmarks — ${displayName}" describe block (extend lint.expectedTool union)`,
  `  9. Add ${id} toolchain install to .github/workflows/ci.yml`,
  ` 10. Document the toolchain requirement in CONTRIBUTING.md "Cross-ecosystem benchmarks"`,
  '',
  `  Validate: npm run test:run`,
  `  Recipe enforcement runs in pre-commit (architecture greps + contract tests + recipe-playbook synthesis).`,
  '',
];
console.log(nextSteps.join('\n')); // slop-ok
