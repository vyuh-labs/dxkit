import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LANGUAGES, getLanguage, detectActiveLanguages } from '../src/languages';
import type { LanguageId, LanguageSupport } from '../src/languages';
import { TOOL_DEFS } from '../src/analyzers/tools/tool-registry';
import { grammarShape } from '../src/ast/grammar-shape';

const REQUIRED_IDS: LanguageId[] = ['typescript', 'python', 'go', 'rust', 'csharp'];

describe('language registry', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(LANGUAGES)).toBe(true);
    expect(LANGUAGES.length).toBeGreaterThan(0);
  });

  it('covers all 5 required language IDs', () => {
    const registered = LANGUAGES.map((l) => l.id);
    for (const id of REQUIRED_IDS) {
      expect(registered, `missing language: ${id}`).toContain(id);
    }
  });

  it('has no duplicate IDs', () => {
    const ids = LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getLanguage returns the correct pack for each registered ID', () => {
    for (const lang of LANGUAGES) {
      expect(getLanguage(lang.id)).toBe(lang);
    }
  });

  it('getLanguage returns undefined for unknown IDs', () => {
    expect(getLanguage('typescript')).toBeDefined();
    // Cast to bypass type narrowing — tests should cover runtime safety.
    expect(getLanguage('brainfuck' as LanguageId)).toBeUndefined();
  });

  it('detectActiveLanguages returns an array without throwing', () => {
    const result = detectActiveLanguages(process.cwd());
    expect(Array.isArray(result)).toBe(true);
    // dxkit is a TypeScript project — should detect at least typescript.
    expect(result.some((l) => l.id === 'typescript')).toBe(true);
  });
});

describe.each(LANGUAGES as LanguageSupport[])('language contract: $id', (lang) => {
  it('has a non-empty displayName', () => {
    expect(typeof lang.displayName).toBe('string');
    expect(lang.displayName.length).toBeGreaterThan(0);
  });

  it('declares at least one source extension starting with "."', () => {
    expect(lang.sourceExtensions.length).toBeGreaterThan(0);
    for (const ext of lang.sourceExtensions) {
      expect(ext.startsWith('.'), `invalid extension "${ext}"`).toBe(true);
    }
  });

  it('declares at least one test file pattern containing a wildcard', () => {
    expect(lang.testFilePatterns.length).toBeGreaterThan(0);
    for (const pat of lang.testFilePatterns) {
      expect(pat.includes('*') || pat.includes('?'), `pattern "${pat}" has no wildcard`).toBe(true);
    }
  });

  it('detect() returns a boolean and is idempotent', () => {
    const first = lang.detect(process.cwd());
    const second = lang.detect(process.cwd());
    expect(typeof first).toBe('boolean');
    expect(first).toBe(second);
  });

  it('tools and semgrepRulesets are arrays of strings', () => {
    expect(Array.isArray(lang.tools)).toBe(true);
    expect(Array.isArray(lang.semgrepRulesets)).toBe(true);
    for (const t of lang.tools) {
      expect(typeof t).toBe('string');
    }
    for (const r of lang.semgrepRulesets) {
      expect(typeof r).toBe('string');
    }
  });

  it('every tool ID references a valid TOOL_DEFS key', () => {
    const validKeys = Object.keys(TOOL_DEFS);
    for (const toolId of lang.tools) {
      expect(validKeys, `${lang.id} references unknown tool "${toolId}"`).toContain(toolId);
    }
  });

  it('every tool invoked via findTool(TOOL_DEFS.X) is declared in tools[]', () => {
    // Scan the pack's source file for TOOL_DEFS.X / TOOL_DEFS['X'] patterns.
    // Every X found must appear in lang.tools — otherwise a new tool call
    // slipped in without being declared as a dependency.
    const srcPath = path.resolve(__dirname, '..', 'src', 'languages', `${lang.id}.ts`);
    const src = fs.readFileSync(srcPath, 'utf-8');
    const invokedToolIds = new Set<string>();
    const dotRe = /\bTOOL_DEFS\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    const bracketRe = /\bTOOL_DEFS\[\s*['"]([^'"]+)['"]\s*\]/g;
    let m: RegExpExecArray | null;
    while ((m = dotRe.exec(src)) !== null) invokedToolIds.add(m[1]);
    while ((m = bracketRe.exec(src)) !== null) invokedToolIds.add(m[1]);

    const declared = new Set(lang.tools);
    for (const id of invokedToolIds) {
      expect(
        declared,
        `${lang.id}: "${id}" invoked via TOOL_DEFS but missing from tools[]`,
      ).toContain(id);
    }
  });

  // D009 reverse direction (closed in Phase 10i.0-LP.7): every tool the pack
  // DECLARES must either be invoked via TOOL_DEFS in pack source OR be on
  // the artifact-generating allowlist below. Catches the rot where a pack
  // declares a tool it stopped using — e.g. switching from cargo-audit
  // command-line invocation to direct OSV API call would leave cargo-audit
  // in tools[] but unreferenced in source.
  //
  // Artifact-generating tools are run externally to produce files dxkit
  // reads (e.g. coverage-py → coverage.json, cargo-llvm-cov → lcov.info).
  // They're legitimately declared so `vyuh-dxkit tools install` sets them
  // up, but gather code reads the artifact, not the tool.
  it('every declared tool is invoked or on the artifact-generating allowlist', () => {
    // Artifact-generating tools are run externally (typically by the user
    // or CI) to produce a file dxkit reads. They're declared so
    // `vyuh-dxkit tools install` sets them up, but pack source never
    // invokes them as a binary — it just reads the artifact.
    const ARTIFACT_GENERATING_TOOLS = new Set([
      'coverage-py', // produces coverage.json
      'cargo-llvm-cov', // produces lcov.info
      'pip-licenses', // produces license JSON
      'go-licenses', // produces license output
      'nuget-license', // produces license JSON
      'vitest-coverage', // produces coverage-summary.json
      'simplecov', // produces coverage/.resultset.json
    ]);

    const srcPath = path.resolve(__dirname, '..', 'src', 'languages', `${lang.id}.ts`);
    const src = fs.readFileSync(srcPath, 'utf-8');

    // Build the set of tool ids that appear in pack source via ANY of:
    //   - `TOOL_DEFS.<id>` (preferred — Architecture Rule #1)
    //   - `TOOL_DEFS['<id>']` (bracket form)
    //   - `node_modules/.bin/<binary>` (project-local escape hatch)
    //   - any TOOL_DEFS[id].binaries[] entry as a shell-command literal
    //     like `'<binary> ...'` or `"<binary> ..."` (covers
    //     `run('npm audit ...')`, `run('dotnet format ...')`, etc.)
    const invokedToolIds = new Set<string>();
    const dotRe = /\bTOOL_DEFS\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    const bracketRe = /\bTOOL_DEFS\[\s*['"]([^'"]+)['"]\s*\]/g;
    const nodeModRe = /node_modules\/\.bin\/([A-Za-z_][A-Za-z0-9_-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = dotRe.exec(src)) !== null) invokedToolIds.add(m[1]);
    while ((m = bracketRe.exec(src)) !== null) invokedToolIds.add(m[1]);
    while ((m = nodeModRe.exec(src)) !== null) invokedToolIds.add(m[1]);

    // Bare-binary detection: for each declared tool, look up its
    // canonical binary name(s) and check if any appear at the start of
    // a quoted shell command literal in source.
    for (const declaredTool of lang.tools) {
      const def = TOOL_DEFS[declaredTool];
      const binaries = def?.binaries ?? [declaredTool];
      for (const bin of binaries) {
        // Match `<bin> ` or `<bin>$` or `<bin>:` inside a single- or
        // double-quoted string. Anchored with a non-word char before
        // the binary name to avoid matching e.g. `'npm-audit'` when
        // looking for `npm`.
        const escaped = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cmdRe = new RegExp(`['"\`](?:[^'"\`]*[^a-zA-Z0-9_-])?${escaped}(?:[\\s'"\`:]|$)`);
        if (cmdRe.test(src)) {
          invokedToolIds.add(declaredTool);
          break;
        }
      }
    }

    for (const declaredTool of lang.tools) {
      const usedInSource = invokedToolIds.has(declaredTool);
      const isArtifact = ARTIFACT_GENERATING_TOOLS.has(declaredTool);
      expect(
        usedInSource || isArtifact,
        `${lang.id}: "${declaredTool}" declared in tools[] but never invoked ` +
          `(no TOOL_DEFS reference, no node_modules/.bin path, no shell-command binary). ` +
          `Either remove from tools[] OR add to ARTIFACT_GENERATING_TOOLS allowlist.`,
      ).toBe(true);
    }
  });

  // ─── Phase 10i.0-LP.7 — recipe metadata completeness ────────────────────
  // Every pack must declare the LP-refactor metadata fields that the pack-
  // driven consumers (generator, doctor, project-yaml, constants) iterate
  // over. A pack missing these fields would silently disappear from those
  // outputs without breaking the build — this catches the omission early.

  it('declares non-empty `permissions` (Bash entries for .claude/settings.json)', () => {
    expect(
      Array.isArray(lang.permissions),
      `${lang.id}: missing permissions[] — generator.ts iteration would skip this pack`,
    ).toBe(true);
    expect(lang.permissions!.length).toBeGreaterThan(0);
    for (const p of lang.permissions!) expect(typeof p).toBe('string');
  });

  it('declares non-empty `cliBinaries` (commands `doctor` checks)', () => {
    expect(
      Array.isArray(lang.cliBinaries),
      `${lang.id}: missing cliBinaries[] — doctor would silently skip this pack's toolchain check`,
    ).toBe(true);
    expect(lang.cliBinaries!.length).toBeGreaterThan(0);
    for (const b of lang.cliBinaries!) expect(typeof b).toBe('string');
  });

  it('declares `defaultVersion` (fallback for <KEY>_VERSION template variable)', () => {
    expect(
      typeof lang.defaultVersion,
      `${lang.id}: missing defaultVersion — <KEY>_VERSION template var would have no fallback`,
    ).toBe('string');
    expect(lang.defaultVersion!.length).toBeGreaterThan(0);
  });

  it('a version-bearing ciSetup step wires `versionInput` (CI provisions the DETECTED SDK)', () => {
    // A `with` input named `version` or ending `-version` carries the toolchain
    // version. If a step hardcodes one WITHOUT `versionInput`, CI silently
    // provisions the pack's default even when the repo targets another version
    // (the .NET-8-on-a-net9-repo bug). Force the pack to opt into derivation —
    // or deliberately omit `versionInput` (documented, e.g. Kotlin's JDK).
    for (const step of lang.ciSetup?.steps ?? []) {
      const versionKeys = Object.keys(step.with ?? {}).filter(
        (k) => k === 'version' || k.endsWith('-version'),
      );
      if (versionKeys.length === 0) continue;
      // If versionInput is set it must name an actual `with` key; a pack may
      // omit it only when the version axis differs from its detected version
      // (Kotlin's setup-java JDK vs its compiler version — defers to Java).
      if (step.versionInput !== undefined) {
        expect(
          versionKeys,
          `${lang.id}: ciSetup step '${step.name}' versionInput '${step.versionInput}' not in \`with\``,
        ).toContain(step.versionInput);
      } else {
        expect(
          lang.id === 'kotlin',
          `${lang.id}: ciSetup step '${step.name}' hardcodes ${versionKeys.join('/')} but has no versionInput — wire detectVersion + versionInput so CI derives the repo's version (or document the exemption)`,
        ).toBe(true);
      }
    }
  });

  it('declares `devcontainerFeature` (per-stack feature for installDevcontainer)', () => {
    // Every shipped pack today has a canonical ghcr.io feature. If a
    // future pack genuinely has no feature surface, drop this
    // assertion for that pack and document why.
    expect(
      lang.devcontainerFeature,
      `${lang.id}: missing devcontainerFeature — installDevcontainer would omit this pack's toolchain`,
    ).toBeDefined();
    expect(typeof lang.devcontainerFeature!.name).toBe('string');
    expect(lang.devcontainerFeature!.name).toMatch(/^ghcr\.io\/devcontainers/);
  });

  // 2.6 allowlist feature (Sprint 1): every pack declares its line-comment
  // syntax so the inline-allowlist annotation generator can render
  // `<lineComment> dxkit-allow:<category> reason="..."` in the right
  // form for the file's language. A pack missing `commentSyntax` would
  // make the inline path silently fall back to `#` (broken in TS/Go/
  // Rust/C#/Kotlin/Java) or hardcode a default in the allowlist module
  // (a Rule 6 violation). The scaffolder ships a placeholder; this
  // assertion enforces that the placeholder gets filled in.
  it('declares commentSyntax with a non-empty lineComment', () => {
    expect(
      lang.commentSyntax,
      `${lang.id}: missing commentSyntax — allowlist inline annotation insertion ` +
        `would have no per-language comment form`,
    ).toBeDefined();
    expect(typeof lang.commentSyntax!.lineComment).toBe('string');
    expect(
      lang.commentSyntax!.lineComment.length,
      `${lang.id}: commentSyntax.lineComment is empty — fill in the scaffolded ` +
        `placeholder ('#' for hash-style, '//' for slash-style, etc.)`,
    ).toBeGreaterThan(0);
    if (lang.commentSyntax!.blockCommentStart !== undefined) {
      expect(typeof lang.commentSyntax!.blockCommentStart).toBe('string');
      expect(typeof lang.commentSyntax!.blockCommentEnd).toBe('string');
      expect(lang.commentSyntax!.blockCommentEnd!.length).toBeGreaterThan(0);
    }
  });

  it('depVulns capability declares non-empty manifestPatterns (2.16)', () => {
    const dep = lang.capabilities?.depVulns;
    if (!dep) return; // a pack without dependency auditing is exempt
    expect(
      Array.isArray(dep.manifestPatterns) && dep.manifestPatterns.length > 0,
      `${lang.id}: depVulns capability must declare non-empty manifestPatterns — the ` +
        `incremental ref-based dep-audit skip cannot tell whether a PR touched this ` +
        `pack's dependencies without them (CLAUDE.md Rule 6). Fill in the scaffolded list.`,
    ).toBe(true);
    for (const p of dep.manifestPatterns) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    }
  });

  // Correctness floor (2.23): EVERY built-in pack MUST declare the liveness
  // gate and supply BOTH command builders. The capability shipped optional
  // (TS/JS + Python first) and tightened to REQUIRED once all eight packs
  // declared it — the same optional-then-required arc `depVulns.manifestPatterns`
  // followed. Each builder is a pure function returning a `{label,bin,args}`
  // command or null — the runner never hardcodes a per-language command
  // (CLAUDE.md Rule 6). A pack with `syntaxCheck` but no `affectedTests` (or
  // vice-versa) is a half-wired provider that would silently gate only half the
  // liveness signal. A NEW pack that omits `correctness` fails HERE.
  it('declares a correctness provider with both syntaxCheck and affectedTests', () => {
    const c = lang.correctness;
    expect(
      c,
      `${lang.id}: every pack must declare a correctness (liveness) provider`,
    ).toBeDefined();
    if (!c) return; // unreachable once the assertion above holds — narrows the type
    expect(
      typeof c.syntaxCheck,
      `${lang.id}: correctness provider must supply a syntaxCheck() builder`,
    ).toBe('function');
    expect(
      typeof c.affectedTests,
      `${lang.id}: correctness provider must supply an affectedTests() builder`,
    ).toBe('function');
    // Both builders must return null or a well-formed command for a trivial
    // context — never throw, never return a malformed shape.
    const ctx = { cwd: '/nonexistent-repo', changedFiles: [], scope: 'affected' as const };
    for (const build of [c.syntaxCheck, c.affectedTests]) {
      const cmd = build(ctx);
      if (cmd !== null) {
        expect(typeof cmd.label).toBe('string');
        expect(typeof cmd.bin).toBe('string');
        expect(Array.isArray(cmd.args)).toBe(true);
      }
    }
  });

  // custom-check flagship: every pack declares a lint-GATE provider (Rule 6),
  // so the lint gate is uniformly pack-driven and no pack silently lacks the
  // slot. A pack with no zero-config standalone linter returns null (dormant —
  // e.g. Java, whose linters need project config); the rest return a well-formed
  // located command. A NEW pack that omits `lintGate` fails HERE.
  it('declares a lintGate provider returning null or a well-formed located command', () => {
    const g = lang.lintGate;
    expect(
      g,
      `${lang.id}: every pack must declare a lintGate provider (real or dormant)`,
    ).toBeDefined();
    expect(typeof g!.lintCommand, `${lang.id}: lintGate must supply a lintCommand() builder`).toBe(
      'function',
    );
    const cmd = g!.lintCommand({ cwd: process.cwd(), changedFiles: [] });
    if (cmd !== null) {
      expect(typeof cmd.bin).toBe('string');
      expect(Array.isArray(cmd.args)).toBe(true);
      // A located gate MUST carry a parse pattern with a `file` capture group —
      // without it every finding is binary and net-new lint can't be diffed.
      expect(typeof cmd.parse).toBe('string');
      expect(cmd.parse, `${lang.id}: lint parse regex must capture (?<file>…)`).toContain(
        '(?<file>',
      );
      // The pattern must compile.
      expect(() => new RegExp(cmd.parse)).not.toThrow();
    }
  });

  it('extraExcludes is an array of strings when defined', () => {
    if (lang.extraExcludes) {
      expect(Array.isArray(lang.extraExcludes)).toBe(true);
      for (const e of lang.extraExcludes) {
        expect(typeof e).toBe('string');
      }
    }
  });

  it('optional methods have correct types when present', () => {
    if (lang.mapLintSeverity) expect(typeof lang.mapLintSeverity).toBe('function');
  });

  // D021 sub-piece 4 (2.4.7): every pack with a coverage capability
  // ships a `runTests()` so `vyuh-dxkit coverage` /
  // `vyuh-dxkit health --with-coverage` / the report orchestrator can
  // materialize an artifact across the full matrix. Coverage providers
  // without `runTests` would surface as `'skipped — no runTests()
  // implementation yet'` in the runner — historically that was a
  // staging state during pack ramp; post-2.4.7 every shipped pack
  // covers the round-trip.
  it('coverage capability ships runTests() if declared', () => {
    const cov = lang.capabilities?.coverage;
    if (cov) {
      expect(
        typeof cov.runTests,
        `${lang.id}: coverage capability declared but runTests() missing — ` +
          `would surface as "skipped" in the coverage runner`,
      ).toBe('function');
    }
  });

  // G_v4_4 (2.4.7): packs with a depVulns capability MUST ship
  // `upgradeCommand` so `buildUpgradeCommand` can dispatch the
  // per-ecosystem install template. Pre-G_v4_4 the dispatch lived as
  // a hardcoded switch on `tool`, which broke when generic tool names
  // (`osv-scanner`) didn't match the pack-aliased switch keys
  // (`osv-scanner-nuget-direct`). D062 is the .NET WinForms benchmark
  // manifestation.
  it('upgradeCommand exists when depVulns capability is declared', () => {
    if (lang.capabilities?.depVulns) {
      expect(
        typeof lang.upgradeCommand,
        `${lang.id}: depVulns declared but upgradeCommand missing — ` +
          `vuln-scan "Remediation Commands" would fall back to generic prose`,
      ).toBe('function');
    }
    if (lang.upgradeCommand) {
      const out = lang.upgradeCommand('example-package', '1.2.3');
      expect(typeof out).toBe('string');
      expect(out!.length).toBeGreaterThan(0);
    }
  });

  // D073 (2.4.7): every pack declares its cloc language names so
  // `gatherClocMetrics` can filter line counts + the language summary
  // to "actual source code" (excluding JSON/XML/CSV/Markdown data
  // formats cloc lists alongside real languages). Pre-D073 the .NET
  // WinForms benchmark Quality "Comment Ratio" sat at 4.3% because
  // 1.6M JSON + 1.3M XML
  // lines were summed into the denominator alongside C# code.
  it('declares non-empty clocLanguageNames', () => {
    expect(
      Array.isArray(lang.clocLanguageNames),
      `${lang.id}: missing clocLanguageNames — cloc's filter would skip this pack ` +
        `and totalLines / Comment Ratio would drop this language entirely`,
    ).toBe(true);
    expect(lang.clocLanguageNames!.length).toBeGreaterThan(0);
    for (const n of lang.clocLanguageNames!) expect(typeof n).toBe('string');
  });

  // httpFlow (M6): a flow declaration only extracts when the whole chain is
  // wired — descriptor -> grammar -> shape row -> wasm artifact. A pack that
  // declares httpFlow with a missing link SILENTLY contributes nothing (the
  // extractor fail-opens per file), which is exactly the kind of half-landed
  // capability this contract exists to make loud.
  it('httpFlow, when declared, is extraction-complete (grammar + shape + wasm) and non-vacuous', () => {
    if (!lang.httpFlow) return; // packs without a modeled HTTP surface skip
    const hf = lang.httpFlow;

    // 1. A flow descriptor without a grammar can never parse a file.
    const grammars = Object.entries(lang.treeSitterGrammars ?? {});
    expect(
      grammars.length,
      `${lang.id}: declares httpFlow but no treeSitterGrammars — no file would ever parse, ` +
        `so the descriptor is dead. Declare the grammar(s) for its source extensions.`,
    ).toBeGreaterThan(0);

    for (const [ext, grammar] of grammars) {
      expect(ext.startsWith('.'), `${lang.id}: grammar key "${ext}" must be a dotted ext`).toBe(
        true,
      );
      // 2. The grammar must have a shape row (src/ast/grammar-shape.ts) — the
      //    extractor skips files whose grammar it cannot read.
      expect(
        grammarShape(grammar),
        `${lang.id}: grammar "${grammar}" has no shape row in src/ast/grammar-shape.ts — ` +
          `flow extraction would silently skip every ${ext} file. Add the row (most grammars ` +
          `fit the shared callee-field factory).`,
      ).not.toBeNull();
      // 3. The wasm artifact must actually ship.
      const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
      const wasm = path.join(wasmsDir, 'out', `tree-sitter-${grammar}.wasm`);
      expect(
        fs.existsSync(wasm),
        `${lang.id}: no bundled wasm for grammar "${grammar}" (${wasm})`,
      ).toBe(true);
    }

    // 4. Non-vacuous: at least one construct family, and every present family
    //    well-formed (an empty methods/names list matches nothing, silently).
    const families = [
      hf.clientCallees,
      hf.clientMethodCallees?.methods,
      hf.routeDecorators,
      hf.routeRouterCallees?.methods,
      hf.routeMemberDecorators?.methods,
      hf.routePathDecorators?.names,
      hf.routeCallees?.names,
      hf.fileRoutes ? [hf.fileRoutes.handlerFile] : undefined,
    ].filter((f): f is string[] => f !== undefined);
    expect(
      families.length,
      `${lang.id}: httpFlow declares no construct family — a vacuous descriptor`,
    ).toBeGreaterThan(0);
    for (const family of families) {
      expect(family.length, `${lang.id}: an httpFlow construct family is empty`).toBeGreaterThan(0);
    }
    if (hf.routePathDecorators) {
      expect(hf.routePathDecorators.methodsKeyword.length).toBeGreaterThan(0);
      expect(hf.routePathDecorators.defaultMethods.length).toBeGreaterThan(0);
    }
    if (hf.routeRouterCallees) expect(hf.routeRouterCallees.bases.length).toBeGreaterThan(0);
    if (hf.fileRoutes) {
      expect(hf.fileRoutes.baseDirs.length).toBeGreaterThan(0);
      expect(hf.fileRoutes.methodExports.length).toBeGreaterThan(0);
    }
    // Discovery signals, when declared, must be well-formed (an empty anyOf
    // silently recommends nothing).
    for (const signal of hf.flowSignals ?? []) {
      expect(signal.manifest.length).toBeGreaterThan(0);
      expect(signal.anyOf.length).toBeGreaterThan(0);
    }
  });
});
