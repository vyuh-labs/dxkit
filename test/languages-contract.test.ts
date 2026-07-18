import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LANGUAGES, getLanguage, detectActiveLanguages } from '../src/languages';
import type { LanguageId, LanguageSupport } from '../src/languages';
import { TOOL_DEFS } from '../src/analyzers/tools/tool-registry';
import { TOOLCHAIN_DEFS } from '../src/execution';
import { grammarShape } from '../src/ast/grammar-shape';
import { modelShapeForGrammar } from '../src/ast/grammar-model-shape';

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

/** Strip `//` line comments and block comments from TS source so a
 *  source-grep tests the CODE, not the prose describing it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Packs that legitimately cannot probe their linter's VERSION as a recall input
 * (CLAUDE.md Rule 19). A DECLARED exemption with a reason, never a silent
 * omission — same discipline as Rule 10's `DEFERRED_KINDS` and Rule 16's
 * `exemptionReason`. Adding an entry here is a deliberate, reviewable act;
 * returning an empty input set quietly is not.
 *
 * Each entry states what is genuinely unavailable AND what closes it on the
 * repo's side, so the residue is a known limit rather than a mystery.
 */
const RECALL_VERSION_EXEMPT: Readonly<Record<string, string>> = {
  java:
    'lintGate is dormant (lintCommand returns null): Java linters need project config, so no ' +
    'stable text gate is pinned yet and nothing runs. Nothing runs means nothing can drift, so ' +
    'an empty input set is accurate. Drop this exemption when a real command lands.',
  csharp:
    'the gate reads MSBuild warnings, whose analyzers ship with the .NET SDK — and the SDK is an ' +
    'ambient runtime (cliBinaries), not a dxkit-managed registry tool (Rule 1), so there is no ' +
    'honest version for findTool to probe. A repo closes this itself by pinning global.json, ' +
    'which IS hashed here, alongside .editorconfig and Directory.Build.props.',
};

/**
 * Packs with NO devcontainer feature surface — with the reason. A feature is
 * the wrong mechanism when the ecosystem's canonical container story is a
 * base image; declaring a bogus feature would break container builds.
 */
const DEVCONTAINER_FEATURE_EXEMPT: Readonly<Record<string, string>> = {
  swift:
    'no swift feature exists in ghcr.io/devcontainers or the community registry (450 features ' +
    'audited 2026-07, zero swift). The canonical Swift devcontainer is the BASE IMAGE ' +
    'mcr.microsoft.com/devcontainers/swift, which the per-pack feature mechanism cannot ' +
    'express. Drop this exemption if a first-party/community feature lands.',
};

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
    // Every pack has a canonical ghcr.io feature OR a declared exemption
    // stating why none can exist — a reason, never an omission (the
    // RECALL_VERSION_EXEMPT discipline applied to the devcontainer surface).
    const exemption = DEVCONTAINER_FEATURE_EXEMPT[lang.id];
    if (exemption) {
      expect(
        lang.devcontainerFeature,
        `${lang.id}: declared feature-exempt but has one — drop the exemption`,
      ).toBeUndefined();
      expect(exemption.length, `${lang.id}: exemption needs a real reason`).toBeGreaterThan(40);
      return;
    }
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

  it('depVulns lockfilePatterns, when declared, are exact basenames', () => {
    const dep = lang.capabilities?.depVulns;
    if (!dep?.lockfilePatterns) return; // root-only auditing is a valid choice
    expect(
      dep.lockfilePatterns.length,
      `${lang.id}: an EMPTY lockfilePatterns is ambiguous — omit the field for ` +
        `root-only auditing, or declare the independent-resolution lockfile names`,
    ).toBeGreaterThan(0);
    for (const p of dep.lockfilePatterns) {
      // Nested-root discovery matches EXACT basenames via the canonical
      // walker — a glob or path segment would silently never match.
      expect(p.includes('*'), `${lang.id}: lockfilePattern "${p}" must not be a glob`).toBe(false);
      expect(p.includes('/'), `${lang.id}: lockfilePattern "${p}" must be a basename`).toBe(false);
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
      if (cmd.parse.kind === 'regex') {
        // A regex gate MUST capture a `file` group — without it every finding
        // is binary and net-new lint can't be diffed. Regex is the documented
        // EXCEPTION (a linter with no machine-readable output — today only
        // MSBuild's diagnostic stream); prefer `structured` for a new pack.
        expect(cmd.parse.pattern, `${lang.id}: lint parse regex must capture (?<file>…)`).toContain(
          '(?<file>',
        );
        expect(() => new RegExp((cmd.parse as { pattern: string }).pattern)).not.toThrow();
      } else {
        // A structured gate parses the linter's NATIVE machine-readable output.
        // Its label is the parse's recall identity (a function can't be
        // hashed), and the parse must be TOTAL over untrusted linter output:
        // garbage in → [] out, never a throw — the runner treats a throw as a
        // misconfigured check, so a parser that throws on real-world noise
        // silently downgrades every run to one binary finding.
        expect(cmd.parse.kind).toBe('structured');
        expect(cmd.parse.label, `${lang.id}: structured parse must carry a label`).toMatch(
          /^[a-z0-9-]+$/,
        );
        const parse = cmd.parse.parse;
        for (const garbage of ['', 'not json', '{"truncated": [', '[{"half": tru', '42', '[]']) {
          let out!: unknown;
          expect(
            () => (out = parse(garbage)),
            `${lang.id}: structured parse threw on garbage input ${JSON.stringify(garbage)}`,
          ).not.toThrow();
          expect(Array.isArray(out), `${lang.id}: structured parse must return an array`).toBe(
            true,
          );
        }
      }
    }
  });

  // Rule 20 (4.0): every capability that executes repo-facing commands
  // declares what it NEEDS from the environment that runs it. The
  // pre-declaration model implicitly assumed `{ hosts: any, toolchains: [],
  // needsBuild: false }` everywhere — wrong on every axis for the C# build
  // gates (the dpl-studio class). This block makes the declaration total,
  // well-formed, repo-intrinsic, and non-divergent from doctor's toolchain
  // probe (the cliBinaries parity — two projections of one concept, Rule 2.30).
  describe('execution requirements (Rule 20)', () => {
    /** Every (capability, requirement) pair this pack declares at `cwd`. */
    function declaredRequirements(cwd: string): Array<{ capability: string; req: unknown }> {
      const out: Array<{ capability: string; req: unknown }> = [];
      out.push({ capability: 'correctness', req: lang.correctness.execution(cwd) });
      if (lang.lintGate) out.push({ capability: 'lintGate', req: lang.lintGate.execution(cwd) });
      const dep = lang.capabilities?.depVulns;
      if (dep) out.push({ capability: 'depVulns', req: dep.execution(cwd) });
      if (lang.deepSast) {
        out.push({ capability: 'deepSast', req: lang.deepSast.execution(cwd) });
      }
      return out;
    }

    const HOSTS = ['linux', 'macos', 'windows', 'any'];

    it('every declaring capability returns a well-formed requirement', () => {
      for (const { capability, req } of declaredRequirements(process.cwd())) {
        const r = req as {
          hosts: unknown;
          toolchains: unknown;
          needsBuild: unknown;
          buildTarget: unknown;
          weight: unknown;
        };
        const label = `${lang.id}.${capability}`;
        expect(Array.isArray(r.hosts) && r.hosts.length > 0, `${label}: hosts non-empty`).toBe(
          true,
        );
        for (const h of r.hosts as unknown[]) {
          expect(HOSTS, `${label}: unknown host '${String(h)}'`).toContain(h);
        }
        expect(Array.isArray(r.toolchains), `${label}: toolchains is an array`).toBe(true);
        for (const t of r.toolchains as unknown[]) {
          // Every referenced toolchain must resolve in the ONE provisioning
          // registry — an unregistered id would make the requirement
          // unroutable and its install hint unanswerable.
          expect(
            Object.keys(TOOLCHAIN_DEFS),
            `${label}: toolchain '${String(t)}' not in TOOLCHAIN_DEFS`,
          ).toContain(t);
        }
        expect(typeof r.needsBuild, `${label}: needsBuild is boolean`).toBe('boolean');
        expect(['none', 'discovered', 'configured'], `${label}: buildTarget`).toContain(
          r.buildTarget,
        );
        expect(['cheap', 'build'], `${label}: weight`).toContain(r.weight);
      }
    });

    it('requirements are deterministic, total, and repo-intrinsic', () => {
      // Deterministic: same repo → byte-identical answer (a requirement that
      // wobbles would flap placement and disclosures).
      expect(declaredRequirements(process.cwd())).toEqual(declaredRequirements(process.cwd()));
      // Total: an empty/alien cwd must still answer, never throw — the
      // declaration is consulted before anything about the repo is known good.
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-exec-contract-'));
      try {
        expect(() => declaredRequirements(empty)).not.toThrow();
        // Repo-intrinsic, machine-independent: nothing machine-specific may
        // leak into the declaration (the Rule 19 recall-inputs discipline —
        // an absolute path would make the same repo read differently per host).
        const serialized = JSON.stringify(declaredRequirements(empty));
        expect(serialized).not.toContain(os.homedir());
        expect(serialized).not.toContain(empty);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });

    // The cliBinaries parity net: doctor's toolchain-coverage signal reads
    // `cliBinaries` (the PATH projection) while placement reads the
    // requirement declarations. Two projections of one concept drift unless
    // pinned (Rule 2.30) — every declared toolchain must surface at least one
    // of its registry binaries in the pack's cliBinaries, so a toolchain gap
    // placement would route on is never invisible to doctor.
    it('declared toolchains surface through cliBinaries (doctor parity)', () => {
      const declared = new Set(
        declaredRequirements(process.cwd()).flatMap(
          ({ req }) => (req as { toolchains: readonly string[] }).toolchains,
        ),
      );
      for (const id of declared) {
        const def = TOOLCHAIN_DEFS[id as keyof typeof TOOLCHAIN_DEFS];
        expect(
          def.binaries.some((b) => (lang.cliBinaries ?? []).includes(b)),
          `${lang.id}: toolchain '${id}' declares binaries [${def.binaries.join(', ')}] but ` +
            `none appear in cliBinaries [${(lang.cliBinaries ?? []).join(', ')}] — doctor ` +
            `would never report the gap placement routes on`,
        ).toBe(true);
      }
    });
  });

  // Rule 19: a pack that gates lint must also declare what makes its linter SEE
  // differently. The command alone is not enough — `eslint-plugin-react-hooks
  // ^7.0.1 -> 7.1.1` adds rules under a byte-identical argv, and without these
  // inputs every finding the new rules report is blamed on the next PR.
  it('declares lintGate.recallInputs returning a stable string map (Rule 19)', () => {
    const g = lang.lintGate;
    expect(
      typeof g!.recallInputs,
      `${lang.id}: lintGate must supply a recallInputs() builder (CLAUDE.md Rule 19)`,
    ).toBe('function');

    // Must not throw. The seam calls this behind a fail-open catch so a pack can
    // never take the gate down — which also means a wiring bug (e.g. a
    // `TOOL_DEFS.<missing>` that type-checks and is undefined at runtime, the
    // one that shipped for cargo/dotnet) degrades to a silently empty input set
    // rather than failing loudly. This assertion is what makes it loud.
    let inputs!: Record<string, string>;
    expect(() => {
      inputs = g!.recallInputs({ cwd: process.cwd(), changedFiles: [], mode: 'resolved' });
    }, `${lang.id}: recallInputs threw — a wiring bug here degrades to no attribution`).not.toThrow();

    expect(inputs && typeof inputs).toBe('object');
    for (const [key, value] of Object.entries(inputs)) {
      expect(typeof value, `${lang.id}: recallInputs['${key}'] must be a string`).toBe('string');
      // Inputs must be stable across MACHINES, not just runs. An absolute path
      // differs between the machine that captured the baseline and the one that
      // checks it, so it reads as permanent drift and silently turns the kind's
      // gate off while looking healthy — the OVER-drift failure, which is worse
      // than the misattribution Rule 19 fixes because nothing announces it.
      expect(
        path.isAbsolute(value),
        `${lang.id}: recallInputs['${key}'] is an absolute path ('${value}') — ` +
          `machine-specific inputs read as permanent drift`,
      ).toBe(false);
      expect(
        /\d{4}-\d{2}-\d{2}T|\bGMT\b/.test(value),
        `${lang.id}: recallInputs['${key}'] looks like a timestamp — it would drift on its own`,
      ).toBe(false);
    }
  });

  it('lintGate.recallInputs is deterministic across calls (Rule 19)', () => {
    // An input that moves between two back-to-back calls on ONE machine can
    // never be compared across two. Same discipline as D144's byte-identical
    // tools map.
    const g = lang.lintGate!;
    const ctx = { cwd: process.cwd(), changedFiles: [], mode: 'resolved' as const };
    expect(g.recallInputs(ctx)).toEqual(g.recallInputs(ctx));
  });

  it('lintGate.recallInputs honours the locked/resolved mode (Rule 19 / §8.1)', () => {
    // Both modes must answer without throwing. They may agree (a pack whose
    // linter is a standalone binary has no declared range to differ from).
    const g = lang.lintGate!;
    const base = { cwd: process.cwd(), changedFiles: [] };
    expect(() => g.recallInputs({ ...base, mode: 'locked' })).not.toThrow();
    expect(() => g.recallInputs({ ...base, mode: 'resolved' })).not.toThrow();
  });

  // Rule 19 PARITY: a pack that gates lint must probe its linter's VERSION, or
  // declare why it cannot. Config hashes alone are not enough — they catch a
  // repo editing its rules, never the toolchain moving underneath it, which is
  // the case that shipped (an unchanged argv, a bumped plugin, 535 findings
  // blamed on the next PR).
  //
  // Source-grep rather than a runtime probe, because at test time most packs'
  // linters are not installed, so `recallInputs` legitimately returns `{}` and
  // a runtime assertion could not tell "nothing installed here" from "this pack
  // never asks". Mirrors the existing TOOL_DEFS ↔ tools[] parity rule above.
  //
  // An exemption is a DECLARED reason, never an omission — same discipline as
  // Rule 10's DEFERRED_KINDS and Rule 16's `exemptionReason`. A new pack that
  // returns the scaffold's placeholder `{}` fails here until it either wires a
  // probe or says why it can't.
  it('lintGate.recallInputs probes a linter version, or declares an exemption (Rule 19)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'languages', `${lang.id}.ts`),
      'utf-8',
    );
    const whole = src.slice(src.indexOf('recallInputs('));
    // Strip comments BEFORE grepping. The scaffold's own TODO says
    // "...toolVersionInput(TOOL_DEFS.<tool>, …)" to show an author what to
    // write — and a naive grep matched that comment and concluded the dormant
    // scaffold already probed. A test that passes because of a code comment is
    // worse than no test: it reports coverage that does not exist.
    const body = stripComments(whole.slice(0, whole.indexOf('\n  },')));
    const probes = /toolVersionInput|nodeLinterVersions|installedNodeVersion/.test(body);
    const exemption = RECALL_VERSION_EXEMPT[lang.id];

    if (exemption) {
      expect(
        probes,
        `${lang.id}: declared exempt from a version probe but has one — drop the exemption`,
      ).toBe(false);
      expect(exemption.length, `${lang.id}: exemption needs a real reason`).toBeGreaterThan(40);
      return;
    }
    expect(
      probes,
      `${lang.id}: lintGate.recallInputs does not probe its linter's version. A config hash ` +
        `alone cannot see the toolchain move underneath the repo — which is the exact case ` +
        `Rule 19 exists for. Add toolVersionInput(TOOL_DEFS.<tool>, …) (and declare the tool ` +
        `in tools[]), or add an entry to RECALL_VERSION_EXEMPT saying why it is impossible.`,
    ).toBe(true);
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
      hf.routeCallees
        ? [...(hf.routeCallees.names ?? []), ...(hf.routeCallees.memberNames ?? [])]
        : undefined,
      hf.clientRequestCallees?.names,
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

  it('modelSchema, when declared, is extraction-complete (grammar + model shape + wasm) and non-vacuous', () => {
    if (!lang.modelSchema) return; // packs without canonical model conventions skip
    const ms = lang.modelSchema;

    // 1. A model descriptor without a grammar can never parse a file.
    const grammars = Object.entries(lang.treeSitterGrammars ?? {});
    expect(
      grammars.length,
      `${lang.id}: declares modelSchema but no treeSitterGrammars — no file would ever ` +
        `parse, so the descriptor is dead. Declare the grammar(s) for its source extensions.`,
    ).toBeGreaterThan(0);

    for (const [ext, grammar] of grammars) {
      // 2. The grammar must have a MODEL shape row (grammar-model-shape.ts) —
      //    the extractor skips files whose class/field syntax it cannot read.
      expect(
        modelShapeForGrammar(grammar),
        `${lang.id}: grammar "${grammar}" has no model-shape row in ` +
          `src/ast/grammar-model-shape.ts — model extraction would silently skip every ` +
          `${ext} file. Add the row, verified against the bundled wasm.`,
      ).not.toBeNull();
      // 3. The wasm artifact must actually ship (shared with the flow check,
      //    re-asserted here so a model-only pack still fails loud).
      const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
      const wasm = path.join(wasmsDir, 'out', `tree-sitter-${grammar}.wasm`);
      expect(
        fs.existsSync(wasm),
        `${lang.id}: no bundled wasm for grammar "${grammar}" (${wasm})`,
      ).toBe(true);
    }

    // 4. Non-vacuous: at least one RECOGNITION family (base classes /
    //    decorators / struct tags — fieldCallees only enrich, they cannot
    //    recognize), and every present family/sub-shape well-formed.
    const recognition = [ms.modelBaseClasses, ms.modelDecorators, ms.structTagKeys].filter(
      (f): f is string[] => f !== undefined,
    );
    expect(
      recognition.length,
      `${lang.id}: modelSchema declares no recognition family (modelBaseClasses / ` +
        `modelDecorators / structTagKeys) — a vacuous descriptor that can never mark a model`,
    ).toBeGreaterThan(0);
    for (const family of recognition) {
      expect(
        family.length,
        `${lang.id}: a modelSchema recognition family is empty`,
      ).toBeGreaterThan(0);
    }
    for (const fc of ms.fieldCallees ?? []) {
      expect(fc.names.length, `${lang.id}: a fieldCallees entry has no names`).toBeGreaterThan(0);
      if (fc.optionalityKeyword !== undefined) {
        expect(fc.optionalityKeyword.length).toBeGreaterThan(0);
      }
    }
    for (const [key, value] of Object.entries(ms.typeAliases ?? {})) {
      expect(key, `${lang.id}: typeAliases key "${key}" must be lowercase`).toBe(key.toLowerCase());
      expect(value.length).toBeGreaterThan(0);
    }
    // Discovery signals, when declared, must be well-formed.
    for (const signal of ms.schemaSignals ?? []) {
      expect(signal.manifest.length).toBeGreaterThan(0);
      expect(signal.anyOf.length).toBeGreaterThan(0);
    }
  });
});
