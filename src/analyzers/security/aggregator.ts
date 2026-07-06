/**
 * Canonical security aggregator (G_v4_8 / 2.4.7 Phase C1).
 *
 * One source of truth for "code findings by severity", "dependency
 * advisories by severity", "unique advisory count", and cross-tool
 * dedup. Every consumer (standalone vuln-scan, health-side scorer,
 * BoM, dashboard) reads from `SecurityAggregate` instead of
 * re-counting raw envelope arrays.
 *
 * The disease this closes (D086 / D087 / D091):
 *
 * - **D086** Health Security section and standalone vuln-scan Code
 * Findings table both reported "code findings by severity" but
 * came up with different numbers (`0C 11H 18M 0L` vs
 * `0C 17H 14M 0L`) on the same repo. Two consumers, two
 * aggregation paths, slightly-different inclusion rules.
 *
 * - **D087** Vuln-scan exec summary said "Subtotal: 70" (sum of
 * dep-vuln severity buckets) and the same page later said
 * "81 advisories" (findings.length). 70 vs 81 on one page.
 *
 * - **D091** A single TLS-bypass root finding surfaced twice in the
 * Code Findings table (registry-grep at `:74` HIGH, semgrep at
 * `:72` MEDIUM) because code findings carried no fingerprint and
 * no cross-tool dedup ran.
 *
 * Architectural posture:
 *
 * - The aggregator sits BETWEEN gather and reports. Gather still
 * produces raw envelopes (`gatherSecrets`, `gatherFileFindings`,
 * `gatherCodePatterns`, `gatherTlsBypassFindings`, `gatherDepVulns`);
 * the aggregator merges + dedups + buckets them into the canonical
 * shape; consumers read by field name.
 *
 * - Three separately-named severity buckets (`codeBySeverity`,
 * `depBySeverity`, `secretsBySeverity`) — the shape forbids any
 * consumer from accidentally summing cross-axis again.
 *
 * - Two named dep counts (`dependencyAdvisoryUniqueCount` for the
 * canonical user-facing total; `dependencyFindingsRawCount` for
 * diagnostic audit). Renderers cannot pick "the wrong number"
 * without naming which they want.
 *
 * - Code findings get a canonical-rule + line-window fingerprint;
 * cross-tool collisions collapse to ONE CodeFinding with
 * `keptSeverity = max(severities)` and `producedBy` listing all
 * contributing tools. The `dedupCollisions` audit trail records
 * every collapse for `--detailed` visibility.
 *
 * - `provenance` distinguishes "tool ran, 0 findings" from "tool
 * didn't run" — drives D080-style "(not run: typescript)" labels.
 *
 * G_v4_8 architectural gate (`scripts/check-architecture.sh`) blocks
 * `countBySeverity` / severity-Record accumulator declarations
 * outside this file, mirroring G_v4_7's walker allowlist.
 */

import type { DepVulnFinding } from '../../languages/capabilities/types';
import type { Severity, FindingCategory, SecurityFinding } from './types';
import {
  canonicalRuleFor,
  codeContentAnchorFromHash,
  computeCodeFingerprint,
  computeContentFingerprint,
  lineWindowFor,
  secretContentAnchor,
  SECRET_CANONICAL_RULE,
} from '../tools/fingerprint';
import {
  annotateFindingsWithAllowlist,
  annotateDepFindingsWithAllowlist,
  allowlistLiftsScore,
} from '../../allowlist/annotate';
import type { AllowlistFile } from '../../allowlist/file';

// ─── Re-exports for consumer convenience ──────────────────────────────────

export type { Severity, FindingCategory, SecurityFinding } from './types';

// ─── Core types ───────────────────────────────────────────────────────────

/**
 * Per-severity counts. Local copy (avoids cross-module import friction
 * with `capabilities/types.SeverityCounts` — same shape, different
 * module home).
 */
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Post-aggregation code/secret/config finding. Extends raw
 * `SecurityFinding` with the identity + provenance fields the
 * aggregator stamps:
 *
 * - `fingerprint` — stable 16-char hash of
 * `(canonicalRule | file | lineWindow)`. Same key across runs;
 * enables diff tooling and dedup-by-identity downstream.
 * - `canonicalRule` — normalized rule id from the canonical-rule
 * registry. Different raw tool/rule pairs that describe the same
 * root finding collapse to the same `canonicalRule`. Unmapped
 * pairs pass through as `raw:${tool}:${rule}` — conservative
 * default; new collapse rules require explicit registry entries.
 * - `producedBy` — every raw `tool` that contributed to this
 * finding. Length > 1 means cross-tool dedup fired.
 */
export interface CodeFinding extends SecurityFinding {
  fingerprint: string;
  canonicalRule: string;
  producedBy: string[];
  /** Fingerprints of the cross-tool / neighbor-bucket / CWE-bridge
   * findings that collapsed into this one, when their own fingerprint
   * differed from `fingerprint`. Present only when such a merge fired.
   * Lets a suppression keyed on a contributing fingerprint still match
   * the merged finding (robust matching against dedup nondeterminism). */
  absorbedFingerprints?: string[];
}

/**
 * One collapsed-collision audit entry. Renders in `--detailed` so a
 * security reviewer can verify "yes, these two tools agreed on this
 * one finding" rather than wondering why a tool's findings count
 * differs from the report's surface count.
 */
export interface DedupCollision {
  canonicalRule: string;
  file: string;
  line: number;
  keptSeverity: Severity;
  collapsedFrom: ReadonlyArray<{
    tool: string;
    rule: string;
    line: number;
    severity: Severity;
  }>;
}

/**
 * Per-tool run-state provenance. Distinguishes "tool ran with zero
 * findings" from "tool didn't run." Drives the "(not run: …)" labels
 * on report tool-attribution lines and the security scorer's "scan
 * was partial" cap signal (D025e / D080 lineage).
 */
export interface AggregateProvenance {
  secrets: { tool: string | null; ran: boolean };
  codePatterns: { tool: string | null; ran: boolean };
  /** Ingested external-engine provenance. `tools` is the set of
   * engines whose findings were ingested this run (e.g. `['codeql']`,
   * `['snyk-code']`); `ran` is true when ingestion contributed. Always
   * populated by `buildSecurityAggregate`; optional in the type only so
   * pre-existing test mocks needn't be rewritten. */
  external?: { tools: string[]; ran: boolean };
  tlsBypass: { ran: boolean; patternCount: number };
  fileFindings: { ran: boolean };
  depVulns: { tool: string | null; available: boolean; unavailableReason: string };
}

/**
 * The canonical security aggregate. Every consumer reads from this;
 * consumers MUST NOT re-aggregate from raw envelope arrays. The
 * G_v4_8 architectural gate enforces this at commit time.
 */
export interface SecurityAggregate {
  /** Code-pattern findings by severity (semgrep + tls-bypass-registry
   * + any future per-pack code-pattern producers), post-dedup. */
  codeBySeverity: SeverityCounts;

  /** Dependency advisories by severity, derived from the
   * fingerprint-unique advisory set (NOT the per-pack envelope
   * count sum). Sums to `dependencyAdvisoryUniqueCount`. */
  depBySeverity: SeverityCounts;

  /** Secret + secret-adjacent findings (gitleaks + private-key files +
   * .env-in-git) by severity. Each axis stays separate so consumers
   * pick which they own. */
  secretsBySeverity: SeverityCounts;

  /** Code-pattern findings by severity, EXCLUDING findings an active
   * allowlist entry lifts from the score (`false-positive` /
   * `test-fixture`). The dimension scorer reads these; reports read the
   * raw `codeBySeverity`. Equal to `codeBySeverity` when no allowlist
   * was supplied or none of the findings are score-lifted. */
  scoreableCodeBySeverity: SeverityCounts;

  /** Secret + secret-adjacent findings by severity, EXCLUDING
   * score-lifting allowlisted findings. Scorer reads this; reports read
   * raw `secretsBySeverity`. */
  scoreableSecretsBySeverity: SeverityCounts;

  /** Dependency advisories by severity, EXCLUDING score-lifting
   * allowlisted dep-vulns (`false-positive` / `test-fixture`). The
   * dimension scorer reads this; reports read raw `depBySeverity`. Equal
   * to `depBySeverity` when no allowlist lifts a dep-vuln. */
  scoreableDepBySeverity: SeverityCounts;

  /** Findings partitioned by category, post-dedup. Renderers iterate
   * these — never iterate raw envelope arrays. `dependency` is the
   * fingerprint-unique advisory set. */
  findingsByCategory: {
    secret: ReadonlyArray<CodeFinding>;
    code: ReadonlyArray<CodeFinding>;
    config: ReadonlyArray<CodeFinding>;
    dependency: ReadonlyArray<DepVulnFinding>;
  };

  /**
   * The canonical user-facing advisory count: unique fingerprints
   * across every pack's findings. Use for the vuln-scan "Subtotal:"
   * line, BoM `totalAdvisories`, and the "Showing N of M" denominator.
   * Aligns with BoM's existing fingerprint-unique semantics (D076 /
   * D085) so vuln-scan and BoM never report different totals.
   */
  dependencyAdvisoryUniqueCount: number;

  /**
   * Diagnostic-only: per-pack envelope.findings.length sum BEFORE
   * fingerprint dedup. Surfaces in `--detailed` audit logs so the
   * delta vs `dependencyAdvisoryUniqueCount` is visible. Renderers
   * should NOT use this for any user-facing count.
   */
  dependencyFindingsRawCount: number;

  /** Audit trail of every cross-tool / cross-line-window collapse.
   * Empty in the no-collision case. */
  dedupCollisions: ReadonlyArray<DedupCollision>;

  /** Per-source provenance — drives "(not run: typescript)" labels. */
  provenance: AggregateProvenance;
}

// ─── Canonical-rule registry ──────────────────────────────────────────────

/**
 * Maps raw `(tool, rule)` pairs to a canonical rule id. Two raw
 * findings with the same canonical rule (and same file + line window)
 * collapse to one `CodeFinding` with `keptSeverity = max` and
 * `producedBy = [tool₁, tool₂, …]`.
 *
 * Unmapped pairs fall through to `raw:${tool}:${rule}` — never
 * accidentally collapses unrelated findings. Adding a new collapse
 * is a one-line addition here; no aggregator code changes.
 *
 * Initial entries close D091's observed TLS-bypass cross-tool
 * double-counting. Future entries land when a new language pack or
 * semgrep ruleset surfaces overlap with an existing finding type.
 */
// ─── Severity helpers ─────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function emptyCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function bumpCounts(counts: SeverityCounts, severity: Severity): void {
  counts[severity]++;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Input envelopes for `buildSecurityAggregate`. Each field maps 1:1
 * to a `gather*` function in `security/gather.ts`. The aggregator
 * never invokes I/O; it's a pure function over already-gathered
 * data, which keeps unit testing trivial.
 */
export interface SecurityAggregateInput {
  secrets: { findings: SecurityFinding[]; toolUsed: string | null };
  fileFindings: SecurityFinding[];
  codePatterns: { findings: SecurityFinding[]; toolUsed: string | null };
  /** Findings ingested from external interprocedural-SAST engines
   * (Snyk Code, CodeQL, …) via `src/ingest`. Already mapped to
   * `SecurityFinding` with the engine as the `tool`. They join the
   * same code-side dedup pipeline as native findings, so a Snyk and a
   * semgrep finding on the same line collapse to one `CodeFinding`.
   * Optional: absent (or empty) yields output identical to a run with
   * no ingestion configured. */
  external?: { findings: SecurityFinding[]; toolsUsed: string[] };
  tlsBypass: SecurityFinding[];
  /** Pattern count from `allTlsBypassPatterns()` — drives the
   * `provenance.tlsBypass.ran` flag (ran=false when no patterns were
   * registered, NOT when 0 findings matched against a non-empty
   * pattern set). */
  tlsBypassPatternCount: number;
  depVulns: {
    findings: DepVulnFinding[];
    tool: string | null;
    available: boolean;
    unavailableReason: string;
  };
  /** The repo's allowlist, loaded by the caller (the aggregator stays
   * pure / does no I/O). When present, each code/secret/config finding
   * is annotated with its active-allowlist status, and the `scoreable*`
   * severity buckets exclude findings allowlisted under a category that
   * lifts the score (`false-positive` / `test-fixture`). Absent/null →
   * `scoreable*` buckets equal the raw buckets. */
  allowlist?: AllowlistFile | null;
}

/**
 * Build the canonical aggregate from per-gatherer envelopes. Pure
 * function — same input always produces the same output.
 *
 * Dedup pipeline (code-side):
 * 1. Concat raw findings from secrets/fileFindings/codePatterns/tlsBypass.
 * 2. Group by `(canonicalRule, file, lineWindow)` key.
 * 3. For each group:
 * - Emit ONE `CodeFinding` with `keptSeverity = max(severities)`,
 * `producedBy` = unique sources.
 * - If the group had >1 raw finding, record a `DedupCollision`
 * audit entry.
 *
 * Dedup pipeline (dep-side):
 * - Group `depVulns.findings` by `fingerprint`.
 * - For each group: pick the highest-severity entry as the
 * representative; severity counts are derived from the unique
 * set so they match `dependencyAdvisoryUniqueCount`.
 * - Findings without a fingerprint pass through unchanged (defensive;
 * `stampFingerprints` in `gatherDepVulns` runs before this).
 */
export function buildSecurityAggregate(input: SecurityAggregateInput): SecurityAggregate {
  // ─── Code-side dedup ────────────────────────────────────────────────
  const rawCodeFindings: SecurityFinding[] = [
    ...input.secrets.findings,
    ...input.fileFindings,
    ...input.codePatterns.findings,
    ...(input.external?.findings ?? []),
    ...input.tlsBypass,
  ];

  // Group by (canonicalRule, file, lineWindow). Map value carries the
  // running collapsed shape so we don't have to do two passes.
  type Group = {
    fingerprint: string;
    canonicalRule: string;
    file: string;
    line: number;
    severity: Severity;
    category: FindingCategory;
    cwe: string;
    rule: string;
    title: string;
    tool: string;
    // Content-anchor material, carried from the representative finding.
    // The durable fingerprint anchors to this (not the line window) when
    // available; the line key below is still used for intra-run dedup
    // grouping. Code: the final anchor is built at emit from `spanHash` +
    // `scope` + `ordinal`. Secrets: from `ordinal` alone (value/salt-free,
    // see `secretContentAnchor`). Config + anchorless: line-window fallback.
    spanHash?: string;
    scope?: string;
    /** In-document-order ordinal that disambiguates findings sharing one
     * anchor bucket: code groups sharing `(file, scope, spanHash)`, and
     * secret groups sharing `(file, canonicalRule)`. Assigned after
     * grouping. Keeps identical constructs in one scope distinct. */
    ordinal?: number;
    producedBy: Set<string>;
    /** Each raw finding that merged into this group, carrying its own
     * anchor material so the emit pass can compute the content
     * fingerprint it WOULD have had as representative — recorded as an
     * `absorbedFingerprint` so a suppression keyed on it still matches
     * the merged finding (robust against cross-tool dedup nondeterminism
     * between runs). */
    raws: Array<{
      tool: string;
      rule: string;
      line: number;
      severity: Severity;
      spanHash?: string;
    }>;
  };
  const groups = new Map<string, Group>();

  // Cross-tool CWE index: `cwe \0 file \0 lineWindow` → the fingerprint of
  // the group occupying that spot. Lets two engines that flag the same
  // weakness at the same place under DIFFERENT rule names (so the
  // canonical-rule map doesn't bridge them) still collapse — provided
  // they agree on the CWE. Only ever bridges across tools; a single
  // tool's own findings are governed by the canonical-rule path above,
  // so this never collapses findings one tool intentionally reported
  // separately.
  const byCweLoc = new Map<string, string>();
  const cweLocKey = (cwe: string, file: string, line: number): string =>
    `${cwe}\0${file}\0${lineWindowFor(line)}`;

  for (const f of rawCodeFindings) {
    const canonicalRule = canonicalRuleFor(f.tool, f.rule);
    const naturalFingerprint = computeCodeFingerprint(canonicalRule, f.file, f.line);

    // C1.10: neighbor-bucket lookup. The 3-line fixed bucket misses
    // adjacent findings that straddle a multiple-of-3 line (the JS-heavy
    // customer frontend surfaced SetupConfigForm.js:43 + :45 → buckets 42
    // + 45 → different keys → no collapse pre-C1.10). Look up the natural
    // bucket first, then
    // the adjacent buckets (naturalBucket ± 3 via `line ± 3`). Same
    // canonical-rule + file + neighbor-bucket counts as a match; merges
    // into that group. Effective dedup window grows from "0-2 lines
    // within one bucket" to "3-5 lines across one bucket boundary."
    let fingerprint = naturalFingerprint;
    let existing = groups.get(fingerprint);
    if (!existing) {
      for (const offset of [-3, 3]) {
        const neighborFingerprint = computeCodeFingerprint(canonicalRule, f.file, f.line + offset);
        const candidate = groups.get(neighborFingerprint);
        if (candidate) {
          existing = candidate;
          fingerprint = neighborFingerprint;
          break;
        }
      }
    }
    // Cross-tool CWE fallback. Still no match and this finding has a CWE?
    // Join a group another tool already opened at the same file +
    // line-window with the same CWE. Gated to a DIFFERENT tool so one
    // tool's distinct same-CWE findings are never collapsed (those stay
    // governed by the canonical-rule path above).
    if (!existing && f.cwe) {
      for (const offset of [0, -3, 3]) {
        const fp = byCweLoc.get(cweLocKey(f.cwe, f.file, f.line + offset));
        const candidate = fp ? groups.get(fp) : undefined;
        if (candidate && !candidate.producedBy.has(f.tool)) {
          existing = candidate;
          fingerprint = candidate.fingerprint;
          break;
        }
      }
    }
    if (existing) {
      existing.severity = maxSeverity(existing.severity, f.severity);
      existing.producedBy.add(f.tool);
      existing.raws.push({
        tool: f.tool,
        rule: f.rule,
        line: f.line,
        severity: f.severity,
        spanHash: f.spanHash,
      });
      // Prefer the lower line number as the canonical line — semgrep
      // typically reports the declaration (earlier line) while
      // registry-grep reports the assignment; the declaration is the
      // more useful navigation target. Tie-break by category preserve.
      if (f.line < existing.line) {
        existing.line = f.line;
        existing.title = f.title;
        existing.rule = f.rule;
        existing.tool = f.tool;
        existing.cwe = f.cwe || existing.cwe;
        // Keep the anchor material aligned with the chosen representative.
        existing.spanHash = f.spanHash;
        existing.scope = f.scope;
      }
    } else {
      groups.set(fingerprint, {
        fingerprint,
        canonicalRule,
        file: f.file,
        line: f.line,
        severity: f.severity,
        category: f.category,
        cwe: f.cwe,
        rule: f.rule,
        title: f.title,
        tool: f.tool,
        spanHash: f.spanHash,
        scope: f.scope,
        producedBy: new Set([f.tool]),
        raws: [
          {
            tool: f.tool,
            rule: f.rule,
            line: f.line,
            severity: f.severity,
            spanHash: f.spanHash,
          },
        ],
      });
    }
    // Index this finding's CWE + location → its group, so a later
    // finding from another tool sharing the CWE can collapse into it.
    if (f.cwe) byCweLoc.set(cweLocKey(f.cwe, f.file, f.line), fingerprint);
  }

  // ─── Ordinal assignment ────────────────────────────────────────
  // Findings sharing one anchor bucket get a stable in-document-order
  // ordinal so identical constructs stay distinct:
  //   • code groups sharing (file, scope, spanHash) — three
  //     `eval(userInput)` in one function stay three findings;
  //   • secret groups sharing (file) — two leaked credentials in one file
  //     stay two findings. Keyed on file ALONE (not the per-tool rule):
  //     secret identity discriminates on the tool-independent
  //     SECRET_CANONICAL_RULE, so the ordinal must be unique per file
  //     across every secret regardless of which scanner/rule found it.
  // Config (file-stable line 0) and anchorless findings need no ordinal.
  // The bucket key is prefixed by category so the code and secret
  // namespaces can never collide. Deterministic regardless of Map
  // iteration order: sorted by line, then by the line-based group key.
  const ordinalBuckets = new Map<string, Group[]>();
  for (const g of groups.values()) {
    let key: string | undefined;
    if (g.category === 'code' && g.spanHash !== undefined) {
      key = `code\0${g.file}\0${g.scope ?? ''}\0${g.spanHash}`;
    } else if (g.category === 'secret') {
      key = `secret\0${g.file}`;
    }
    if (key !== undefined) {
      const list = ordinalBuckets.get(key) ?? [];
      list.push(g);
      ordinalBuckets.set(key, list);
    }
  }
  for (const list of ordinalBuckets.values()) {
    list.sort(
      (a, b) =>
        a.line - b.line ||
        (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
    );
    list.forEach((g, i) => {
      g.ordinal = i;
    });
  }

  // The durable content anchor for a group (scheme v2), or undefined when
  // none is resolvable → line-window fallback. Secrets: (ordinal) alone —
  // value/salt-free, so identity is tool- and environment-independent.
  // Code: (scope, spanHash, ordinal) when a span was captured. Config +
  // anchorless: undefined (config's line-0 identity is already
  // (canonicalRule, file)-stable, so it stays on the line path unchanged).
  const anchorFor = (g: Group): string | undefined => {
    if (g.category === 'secret') return secretContentAnchor(g.ordinal ?? 0);
    if (g.category === 'code' && g.spanHash !== undefined) {
      return codeContentAnchorFromHash(g.scope ?? '', g.spanHash, g.ordinal ?? 0);
    }
    return undefined;
  };
  const fingerprintFor = (
    canonicalRule: string,
    file: string,
    line: number,
    anchor: string | undefined,
  ): string =>
    anchor !== undefined
      ? computeContentFingerprint(canonicalRule, file, anchor)
      : computeCodeFingerprint(canonicalRule, file, line);

  // The rule discriminator used for IDENTITY (not display/grouping).
  // Secrets fold onto the tool-independent SECRET_CANONICAL_RULE so the same
  // leak fingerprints identically no matter which scanner/rule found it;
  // code/config keep their per-tool canonical rule. Mirrors the secret
  // branch in `identityFor` so the aggregator's stamped fingerprint and the
  // baseline producer's recomputed id always agree.
  const identityRuleFor = (g: Group): string =>
    g.category === 'secret' ? SECRET_CANONICAL_RULE : g.canonicalRule;

  const codeFindingsByCategory: Record<'secret' | 'code' | 'config', CodeFinding[]> = {
    secret: [],
    code: [],
    config: [],
  };
  const codeBySeverity = emptyCounts();
  const secretsBySeverity = emptyCounts();
  const dedupCollisions: DedupCollision[] = [];

  for (const g of groups.values()) {
    const anchor = anchorFor(g);
    const identityRule = identityRuleFor(g);
    const fingerprint = fingerprintFor(identityRule, g.file, g.line, anchor);

    // Absorbed fingerprints: the content fingerprint each merged raw WOULD
    // have had as representative (its own span/HMAC, the group's scope +
    // ordinal). Lets a suppression keyed on a contributing finding's
    // identity still match after the representative flips between runs.
    // Secrets fold onto SECRET_CANONICAL_RULE and a per-file ordinal, so
    // every secret raw in a group resolves to the SAME fingerprint — nothing
    // to absorb (the cross-tool divergence this guarded against is gone).
    const absorbed = new Set<string>();
    for (const raw of g.raws) {
      const rawCanonical =
        g.category === 'secret' ? SECRET_CANONICAL_RULE : canonicalRuleFor(raw.tool, raw.rule);
      let rawAnchor: string | undefined;
      if (g.category === 'secret') rawAnchor = secretContentAnchor(g.ordinal ?? 0);
      else if (g.category === 'code' && raw.spanHash !== undefined)
        rawAnchor = codeContentAnchorFromHash(g.scope ?? '', raw.spanHash, g.ordinal ?? 0);
      const rawFp = fingerprintFor(rawCanonical, g.file, raw.line, rawAnchor);
      if (rawFp !== fingerprint) absorbed.add(rawFp);
    }

    const finding: CodeFinding = {
      severity: g.severity,
      category: g.category,
      cwe: g.cwe,
      rule: g.rule,
      title: g.title,
      file: g.file,
      line: g.line,
      tool: g.tool,
      fingerprint,
      canonicalRule: g.canonicalRule,
      producedBy: [...g.producedBy].sort(),
      // Content-anchored identity: stamp the FINAL content anchor (the producer reads it back to
      // recompute the same identity). Omitted when absent (→ line fallback).
      ...(anchor !== undefined ? { contentAnchor: anchor } : {}),
      ...(g.spanHash !== undefined ? { spanHash: g.spanHash } : {}),
      ...(g.scope !== undefined ? { scope: g.scope } : {}),
      ...(absorbed.size > 0 ? { absorbedFingerprints: [...absorbed].sort() } : {}),
    };

    if (g.category === 'secret') {
      codeFindingsByCategory.secret.push(finding);
      bumpCounts(secretsBySeverity, g.severity);
    } else if (g.category === 'config') {
      codeFindingsByCategory.config.push(finding);
      // Config findings (`.env in git`) are secret-adjacent — they
      // share the secrets axis so the Security dimension treats them
      // as the same risk class. Pre-aggregator code paths agreed on
      // this; we preserve it.
      bumpCounts(secretsBySeverity, g.severity);
    } else {
      codeFindingsByCategory.code.push(finding);
      bumpCounts(codeBySeverity, g.severity);
    }

    if (g.raws.length > 1) {
      dedupCollisions.push({
        canonicalRule: g.canonicalRule,
        file: g.file,
        line: g.line,
        keptSeverity: g.severity,
        collapsedFrom: g.raws,
      });
    }
  }

  // ─── Allowlist annotation + scoreable buckets ───────────────────────
  // Mark every code/secret/config finding an active allowlist entry
  // covers (renderers show "(N allowlisted)"), then derive the
  // score-only buckets that EXCLUDE findings allowlisted under a
  // category that lifts the score. This is what lets a repo that has
  // reviewed-and-accepted its findings (false-positive / test-fixture)
  // score honestly instead of staying capped on noise — while still
  // counting accepted-risk / deferred, which accept a real exposure.
  const allCodeSideFindings = [
    ...codeFindingsByCategory.secret,
    ...codeFindingsByCategory.code,
    ...codeFindingsByCategory.config,
  ];
  annotateFindingsWithAllowlist(allCodeSideFindings, input.allowlist ?? null);

  const scoreableCodeBySeverity = emptyCounts();
  const scoreableSecretsBySeverity = emptyCounts();
  const scoreLifted = (f: CodeFinding): boolean =>
    !!f.allowlisted && allowlistLiftsScore(f.allowlistCategory);
  for (const f of codeFindingsByCategory.code) {
    if (!scoreLifted(f)) bumpCounts(scoreableCodeBySeverity, f.severity);
  }
  for (const f of [...codeFindingsByCategory.secret, ...codeFindingsByCategory.config]) {
    if (!scoreLifted(f)) bumpCounts(scoreableSecretsBySeverity, f.severity);
  }

  // ─── Dep-side dedup ─────────────────────────────────────────────────
  // Group by fingerprint. Findings without a fingerprint (defensive
  // path — shouldn't happen post-`stampFingerprints`) get a synthetic
  // unique key so they pass through individually.
  const depGroups = new Map<string, DepVulnFinding>();
  let syntheticFingerprintCounter = 0;
  for (const f of input.depVulns.findings) {
    const key = f.fingerprint ?? `__unstamped__${syntheticFingerprintCounter++}`;
    const existing = depGroups.get(key);
    if (!existing) {
      depGroups.set(key, f);
    } else {
      // Keep the higher-severity representative. Same advisory may
      // appear multiple times if cross-pack joins didn't already
      // collapse it (defensive).
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
        depGroups.set(key, f);
      }
    }
  }
  const uniqueDepFindings = [...depGroups.values()];
  const depBySeverity = emptyCounts();
  for (const f of uniqueDepFindings) {
    bumpCounts(depBySeverity, f.severity);
  }

  // Allowlist-annotate dep findings (kind `dep-vuln`) by their stamped
  // fingerprint, then derive the score-only bucket EXCLUDING score-lifting
  // allowlisted dep-vulns — mirror of the code/secret scoreable buckets, so
  // an accepted dep advisory neither drags the Security score nor is
  // suggested as a fix in top-actions. Reports read raw `depBySeverity`.
  annotateDepFindingsWithAllowlist(uniqueDepFindings, input.allowlist ?? null);
  const scoreableDepBySeverity = emptyCounts();
  for (const f of uniqueDepFindings) {
    if (!(f.allowlisted && allowlistLiftsScore(f.allowlistCategory))) {
      bumpCounts(scoreableDepBySeverity, f.severity);
    }
  }

  // ─── Provenance ─────────────────────────────────────────────────────
  const provenance: AggregateProvenance = {
    secrets: {
      tool: input.secrets.toolUsed,
      ran: input.secrets.toolUsed !== null,
    },
    codePatterns: {
      tool: input.codePatterns.toolUsed,
      ran: input.codePatterns.toolUsed !== null,
    },
    external: {
      tools: input.external?.toolsUsed ?? [],
      ran: (input.external?.toolsUsed.length ?? 0) > 0,
    },
    tlsBypass: {
      // ran=true means the registry walk happened (patterns existed).
      // ran=false means no pack registered TLS-bypass patterns — a
      // legitimate "nothing to scan" state on a repo with no active
      // packs declaring patterns.
      ran: input.tlsBypassPatternCount > 0,
      patternCount: input.tlsBypassPatternCount,
    },
    fileFindings: { ran: true },
    depVulns: {
      tool: input.depVulns.tool,
      available: input.depVulns.available,
      unavailableReason: input.depVulns.unavailableReason,
    },
  };

  return {
    codeBySeverity,
    depBySeverity,
    secretsBySeverity,
    scoreableCodeBySeverity,
    scoreableSecretsBySeverity,
    scoreableDepBySeverity,
    findingsByCategory: {
      secret: codeFindingsByCategory.secret,
      code: codeFindingsByCategory.code,
      config: codeFindingsByCategory.config,
      dependency: uniqueDepFindings,
    },
    dependencyAdvisoryUniqueCount: uniqueDepFindings.length,
    dependencyFindingsRawCount: input.depVulns.findings.length,
    dedupCollisions,
    provenance,
  };
}
