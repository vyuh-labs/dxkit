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

const TEST_TEMPLATE = `import { describe, it, expect } from 'vitest';
import { ${id} } from '../src/languages/${id}';

describe('${id} pack', () => {
  it('declares its id and displayName', () => {
    expect(${id}.id).toBe('${id}');
    expect(${id}.displayName).toBe('${displayName}');
  });

  // TODO(${id}): add pack-specific tests once detect() and capabilities are implemented.
  // Examples to mirror from existing packs:
  //   - parseRequirementsTxtTopLevels in test/python.test.ts
  //   - parseGoModDirectDeps in test/go.test.ts
  //   - parseCargoAuditOutput in test/rust.test.ts
});
`;

const testPath = path.join(REPO_ROOT, 'test', `languages-${id}.test.ts`);
writeIfMissing(testPath, TEST_TEMPLATE);

// ─── 3. Fixture skeleton: test/fixtures/benchmarks/<id>/ ────────────────────

const fixtureDir = path.join(REPO_ROOT, 'test', 'fixtures', 'benchmarks', id);
ensureDir(fixtureDir);
const FIXTURE_README = `# ${displayName} benchmark fixture

TODO(${id}): populate this directory with a minimal real ${displayName} project that:
  - has a known dep-vulnerability (matrix vulnerabilities row)
  - contains a fake hardcoded credential (matrix secrets row,
    e.g. AKIA1234567890ABCDEF in a config file)
  - has a deliberate linter violation (matrix lint row)
  - has a near-duplicate code block (matrix duplications row)
  - has one untested source file (matrix test-gaps row)

See test/fixtures/benchmarks/python/ for an example of the conventions.

When the fixture is populated, register it in
test/integration/cross-ecosystem.test.ts by adding a row to
BENCHMARK_LANGUAGES.
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
  `  3. Implement capability providers (capabilities.depVulns / lint / coverage / etc.)`,
  `  4. Add TOOL_DEFS entries for ${id}'s tools in src/analyzers/tools/tool-registry.ts`,
  `  5. Populate test/fixtures/benchmarks/${id}/ with the matrix-dimension content`,
  `  6. Register the new fixture in test/integration/cross-ecosystem.test.ts BENCHMARK_LANGUAGES`,
  `  7. Add ${id} toolchain install to .github/workflows/ci.yml`,
  `  8. Document the toolchain requirement in CONTRIBUTING.md "Cross-ecosystem benchmarks"`,
  '',
  `  Validate: npm run test:run`,
  `  Recipe enforcement runs in pre-commit (architecture greps + contract tests + recipe-playbook synthesis).`,
  '',
];
console.log(nextSteps.join('\n')); // slop-ok
