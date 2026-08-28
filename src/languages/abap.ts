/**
 * The ABAP language pack (4.4.0 / P1-5).
 *
 * Built research-first — the tooling decision record is
 * `docs/decisions/abap-tooling.md`: ONE adopted external tool
 * (abaplint, MIT, exact-version pinned in the registry because upstream
 * deliberately does not follow semver) fills BOTH gate roles, and dxkit
 * writes ZERO ABAP parsing code (Rule 5 — ABAP's grammar is exactly the
 * kind nobody should hand-roll; abaplint maintains ~1000 statement
 * matchers and digests abapGit's ~500k-line codebase in CI).
 *
 *   - SYNTAX FLOOR (`correctness.syntaxCheck`): `abaplint -f json`
 *     against the repo's own committed `abaplint.json`. Config-less
 *     repos get a DISCLOSED no-check (never a false pass) — abaplint
 *     resolves its file globs relative to the CONFIG's directory, so a
 *     dxkit-bundled config cannot glob a foreign tree (verified; the
 *     scaffold template `src-templates/abap/abaplint-floor.json` exists
 *     for `init` to materialize INTO a repo, not for runtime use).
 *   - LINT GATE (`lintGate`): the same tool through the Rule 17 seam,
 *     JSON output mapped by a TOTAL structured parser; findings mint
 *     located custom-check identities so a pre-existing backlog
 *     grandfathers and a net-new diagnostic gates.
 *
 * ABAP Unit execution and activation need a live SAP system — declined
 * by design (the consumer's own executor seam owns that); the
 * `affectedTests` builder stays null forever, not as a TODO.
 */

import { NO_TREE_INVARIANTS } from './capabilities/tree-invariants';
import type { RemediationSupport } from './capabilities/remediation';

import { fileExists } from '../analyzers/tools/runner';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { extractJsonBlob, asRecord, num, str } from './capabilities/lint-structured';
import { hashFirstConfig, toolVersionInput } from './capabilities/recall-inputs';
import { run } from '../analyzers/tools/runner';
import { readRepoFile } from './version-detect';
import type { LanguageSupport } from './types';
import { abapBdefStructureCheck } from './abap-bdef';
import type { CapabilityProvider } from './capabilities/provider';
import type { LintResult, SeverityCounts } from './capabilities/types';
import type { RawLocatedFinding } from './capabilities/lint-gate';

/** ABAP's remediation answer: the ecosystem genuinely lacks the mechanisms
 *  (no package manager, no lockfile, no dependency registry), so every
 *  capability is a PERMANENT reasoned exemption, not a planned one. */
const abapRemediation: RemediationSupport = {
  resyncLockfile: {
    kind: 'exemption',
    reason: 'ABAP has no package manager or lockfile for dxkit to resync',
  },
  pinTransitive: {
    kind: 'exemption',
    reason: 'ABAP has no dependency manifest in which a transitive version could be pinned',
  },
  declareDependency: {
    kind: 'exemption',
    reason: 'ABAP has no package registry to declare and install dependencies from',
  },
  lintFix: {
    kind: 'exemption',
    reason: 'no ABAP linter with a reliable machine autofix is wired as a lint gate yet',
  },
};

/**
 * An ABAP repo: a committed `abaplint.json` (the ecosystem's one config
 * convention), or any `.abap` source in the tree (abapGit
 * serialization). The walk is exclusion-aware + memoized (the canonical
 * walker), so a non-ABAP repo pays one cheap existence probe.
 */
function detectAbap(cwd: string): boolean {
  if (fileExists(cwd, 'abaplint.json')) return true;
  return walkPaths(cwd, { extensions: ['.abap'] }).length > 0;
}

/**
 * TOTAL parser over `abaplint -f json` output: a single-line JSON array
 * of `{ description, key, file, start: { row }, severity }` (verified
 * against the pinned 2.120.19 — real bytes in test/fixtures/raw/abap/).
 * Garbage in → [] out, never a throw (the contract test feeds it
 * garbage). Paths come back ABSOLUTE — the seam's validating boundary
 * relativizes them (the 3.8 parseLocated lesson); this parser only maps
 * fields.
 */
export function parseAbaplintJson(output: string): readonly RawLocatedFinding[] {
  const blob = extractJsonBlob(output);
  if (!Array.isArray(blob)) return [];
  const findings: RawLocatedFinding[] = [];
  for (const entry of blob) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const file = str(rec.file);
    if (!file) continue;
    const start = asRecord(rec.start);
    const line = start ? num(start.row) : undefined;
    findings.push({
      file,
      ...(line !== undefined && line > 0 ? { line } : {}),
      ...(str(rec.key) ? { rule: str(rec.key) } : {}),
      ...(str(rec.description) ? { message: str(rec.description) } : {}),
    });
  }
  return findings;
}

/**
 * The lint REPORT capability (quality report's counts) — the same tool,
 * the same TOTAL parser, the same config gate as the lint GATE below:
 * abaplint is meaningful only against the repo's committed
 * abaplint.json (no config = 188 default rules = noise), so a
 * config-less repo reads unavailable-with-reason, never a fabricated
 * clean. abaplint severities are Error/Warning/Info; the four-tier map
 * is Error→medium (style-config findings are not security highs),
 * Warning→low, Info→low.
 */
const abapLintProvider: CapabilityProvider<LintResult> = {
  source: 'abap',
  async gather(cwd) {
    if (!fileExists(cwd, 'abaplint.json')) return null;
    const tool = findTool(TOOL_DEFS.abaplint, cwd);
    if (!tool.available || !tool.path) return null;
    const raw = run(`${tool.path} -f json`, cwd, 120000);
    const findings = parseAbaplintJson(raw);
    const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      if (f.rule === 'parser_error' || f.rule === 'structure' || f.rule === 'check_syntax') {
        counts.high++;
      } else {
        counts.medium++;
      }
    }
    return { schemaVersion: 1, tool: 'abaplint', counts };
  },
};

export const abap: LanguageSupport = {
  id: 'abap',
  displayName: 'ABAP',
  // purlType deliberately omitted: the purl spec's type registry has no
  // ABAP ecosystem; the SBOM export discloses the omission per row.

  // ABAP's inline comment is `"` (everything after it on the line).
  // Full-line `*` comments exist only in column 1 — the inline form is
  // the one the allowlist annotation inserter needs.
  commentSyntax: { lineComment: '"' },

  // abapGit serialization: `<object>.<type>.abap` for source,
  // `.ddls.asddls` for CDS, `.bdef.asbdef` for RAP behavior definitions
  // (carried but NOT syntax-checked by abaplint — a DISCLOSED coverage
  // hole, see the decision record; text rules still apply to them).
  sourceExtensions: ['.abap', '.asddls', '.asbdef'],

  // jscpd tokenizes .abap without this but finds ZERO clones (verified);
  // the explicit format mapping restores clone detection.
  jscpdFormatsExts: ['abap:abap'],

  // abapGit test includes.
  testFilePatterns: ['*.testclasses.abap'],

  extraExcludes: [],

  detect: detectAbap,

  tools: ['abaplint'],

  // No ABAP semgrep ruleset exists; the code-pattern surface for ABAP is
  // policy text rules + the abaplint rule set.
  semgrepRulesets: [],

  // Lint counts via the one adopted tool. No dependency-manifest
  // ecosystem exists offline (ABAP dependencies live in the SAP system)
  // and no coverage-report convention outside a live system — deliberate
  // omissions, not gaps to fill.
  capabilities: { lint: abapLintProvider },

  exportDetection: {
    reliability: 'unreliable',
    strategy:
      'no static export analysis for ABAP — visibility lives in class DEFINITION sections that ' +
      'dxkit deliberately does not parse (the adopted-tool boundary, docs/decisions/abap-tooling.md)',
  },

  treeInvariants: NO_TREE_INVARIANTS,
  remediation: abapRemediation,
  correctness: {
    // abaplint is a registry TOOL running on dxkit's own Node runtime —
    // no ambient toolchain, no build, any host (Rule 20).
    execution(_cwd) {
      return {
        hosts: ['any'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      };
    },
    // The parse floor: the repo's own committed abaplint.json decides
    // what "parses" means (for a generated package, that config IS part
    // of its DoD; `init` scaffolds a parse-only one from the template).
    // Config-less repo → null → the floor plan simply carries no ABAP
    // check: nothing claims "passed" (the acceptance's minimum), and
    // nothing false-blocks a repo that never opted in. The runner owns
    // execution + the fail-open policy for a missing binary.
    syntaxCheck(ctx) {
      if (!fileExists(ctx.cwd, 'abaplint.json')) return null;
      const tool = findTool(TOOL_DEFS.abaplint, ctx.cwd);
      return {
        label: 'abaplint-syntax',
        bin: tool.available && tool.path ? tool.path : 'abaplint',
        args: ['-f', 'json'],
      };
    },
    // ABAP Unit needs a live SAP system (activation, database, the
    // works). Permanently declined — the consumer's executor seam owns
    // test execution; dxkit's floor never pretends to cover it.
    affectedTests(_ctx) {
      return null;
    },
    // The `.bdef` STRUCTURAL floor (#309): abaplint has no BDL parser, so
    // behavior definitions get the plausibility tier — its own check id,
    // never presented as "parsed". Retires when upstream parses BDL.
    structureCheck: abapBdefStructureCheck,
  },

  lintGate: {
    execution(_cwd) {
      return {
        hosts: ['any'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      };
    },
    // abaplint requires a project config to be meaningful (no config =
    // all 188 rules — noise, plus sidecar-file complaints), so the gate
    // is keyed on the repo's committed abaplint.json — the checkstyle
    // precedent: a config-needing linter stays dormant until the repo
    // carries one. STRUCTURED parse over `-f json` (never a regex over a
    // display format — the 3.9 class).
    lintCommand(ctx) {
      if (!fileExists(ctx.cwd, 'abaplint.json')) return null;
      const tool = findTool(TOOL_DEFS.abaplint, ctx.cwd);
      if (!tool.available || !tool.path) return null;
      return {
        bin: tool.path,
        args: ['-f', 'json'],
        parse: { kind: 'structured', label: 'abaplint-json', parse: parseAbaplintJson },
        expectedExit: 0,
      };
    },
    recallInputs(ctx) {
      // What decides what this gate can SEE (Rule 19): the abaplint
      // version (upstream ships several releases a week with NO semver —
      // the exact drift class this input exists for) and the config file
      // (rules on/off = recall). Both machine-independent.
      return {
        ...toolVersionInput(TOOL_DEFS.abaplint, ctx.cwd, 'abaplint'),
        ...hashFirstConfig(ctx.cwd, ['abaplint.json', 'abaplint.jsonc']),
      };
    },
  },

  // cloc knows ABAP natively (`cloc --show-lang`).
  clocLanguageNames: ['ABAP'],

  // The "toolchain" an ABAP gate container needs is Node (abaplint's
  // runtime — dxkit's own); no SAP SDK exists to provision.
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/node:1',
    opts: { version: '22', nvmVersion: 'latest' },
  },

  permissions: ['Bash(abaplint:*)'],

  ruleFile: 'abap.md',

  cliBinaries: ['abaplint'],

  // The ABAP language release floor (7.58 = current ABAP Cloud baseline).
  defaultVersion: '758',

  // The committed abaplint.json names the target release
  // (`syntax.version.release`); 'Newest' is a moving target, so only a
  // concrete release string is returned.
  detectVersion(cwd) {
    const raw = readRepoFile(cwd, 'abaplint.json');
    if (!raw) return undefined;
    try {
      const cfg = JSON.parse(raw) as {
        syntax?: { version?: { release?: string } | string };
      };
      const version = cfg.syntax?.version;
      const release = typeof version === 'string' ? version : version?.release;
      if (!release || release === 'Newest') return undefined;
      return release.replace(/^v/, '');
    } catch {
      return undefined;
    }
  },
};
