/**
 * Security finding gatherers — one function per tool, no overlap.
 *
 * Tool boundaries:
 *   gitleaks   → secrets (hardcoded credentials, API keys, private keys in source)
 *   find/git   → private key files on disk (.key, .pem), .env tracked in git
 *   semgrep    → code patterns (eval, exec, TLS, CORS, SQLi, XSS, SSRF, etc.)
 *   dispatcher → dependency CVEs unioned across every active language pack
 */
import * as fs from 'fs';
import { run } from '../tools/runner';
import { enrichEpss, extractCveId } from '../tools/epss';
import { stampFingerprints } from '../tools/fingerprint';
import { enrichKev } from '../tools/kev';
import { resolveAliases } from '../tools/osv';
import { buildReachablePackageSet, markReachable } from '../tools/reachability';
import { scoreFindings } from '../tools/risk-score';
import { resolveTransitiveUpgradePlans } from '../tools/upgrade-plan-resolver';
import { getFindExcludeFlags } from '../tools/exclusions';
import { walkSourceFiles, commentSyntaxFor, isCommentLine } from '../tools/walk-source-files';
import * as path from 'path';
import { SecurityFinding, DepVulnSummary, Severity } from './types';
import { buildSecurityAggregate, type SecurityAggregate } from './aggregator';
import { defaultDispatcher } from '../dispatcher';
import { allTlsBypassPatterns, detectActiveLanguages } from '../../languages';
import {
  CODE_PATTERNS,
  DEP_VULNS,
  IMPORTS,
  SECRETS,
} from '../../languages/capabilities/descriptors';
import { providersFor } from '../../languages/capabilities';
import type { DepVulnResult } from '../../languages/capabilities/types';

// ─── dispatcher-driven secrets gather ────────────────────────────────────────

/**
 * Secrets are a global capability: one scanner (gitleaks today) runs once
 * per repo and the dispatcher aggregates its envelope through the SECRETS
 * descriptor. Exclusions + suppressions are already applied inside the
 * provider (see tools/gitleaks.ts), so this layer only maps the envelope
 * into the SecurityFinding shape used by the security report.
 */
export async function gatherSecrets(cwd: string): Promise<{
  findings: SecurityFinding[];
  toolUsed: string | null;
}> {
  const result = await defaultDispatcher.gather(cwd, SECRETS, providersFor(SECRETS, cwd));
  if (!result) return { findings: [], toolUsed: null };

  const findings: SecurityFinding[] = result.findings.map((f) => ({
    severity: f.severity,
    category: 'secret' as const,
    cwe: 'CWE-798',
    rule: f.rule,
    title: f.title ?? `Secret detected: ${f.rule}`,
    file: f.file,
    line: f.line,
    tool: result.tool,
  }));
  return { findings, toolUsed: result.tool };
}

// ─── find/git: private key files, .env in git ───────────────────────────────

export function gatherFileFindings(cwd: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const EXCLUDE = getFindExcludeFlags(cwd, false); // don't exclude source paths for security scanning

  // Private key / cert files on disk
  const keyFiles = run(`find . \\( -name "*.key" -o -name "*.pem" \\) ${EXCLUDE} 2>/dev/null`, cwd);
  if (keyFiles) {
    for (const f of keyFiles.split('\n').filter((l) => l.trim())) {
      findings.push({
        severity: 'critical',
        category: 'secret',
        cwe: 'CWE-798',
        rule: 'private-key-file',
        title: `Private key or certificate file: ${f.replace('./', '')}`,
        file: f.replace('./', ''),
        line: 0,
        tool: 'find',
      });
    }
  }

  // .env tracked in git
  const envFiles = run('git ls-files .env .env.* 2>/dev/null', cwd);
  if (envFiles) {
    for (const f of envFiles.split('\n').filter((l) => l.trim())) {
      findings.push({
        severity: 'high',
        category: 'config',
        cwe: 'CWE-798',
        rule: 'env-in-git',
        title: `.env file tracked in git: ${f}`,
        file: f,
        line: 0,
        tool: 'git',
      });
    }
  }

  return findings;
}

// ─── TLS / certificate-validation bypass gather (D045 / D034) ──────────────

/**
 * D045 (2.4.7): surface TLS-bypass idioms as first-class
 * `SecurityFinding[]` entries with file:line attribution. Each pack
 * declares its language-specific patterns via
 * `LanguageSupport.tlsBypassPatterns` (D034); this gather runs the
 * unioned alternation across every registered pack's source
 * extensions and emits one finding per matching line.
 *
 * Architecture note (why this is independent of semgrep): semgrep's
 * `p/security-audit` ruleset does not include per-language TLS-bypass
 * idioms (`ServerCertificateValidationCallback`,
 * `DangerousAcceptAnyServerCertificateValidator`,
 * `InsecureSkipVerify: true`, `danger_accept_invalid_certs`,
 * `TrustAllX509TrustManager`, `OpenSSL::SSL::VERIFY_NONE`, etc.). The
 * registry-driven per-pack patterns ARE the source of truth for these
 * checks; both the health-side `tlsDisabledCount` metric and the
 * standalone vuln-scan Code Findings table flow through the same
 * patterns. False-positive rate is near zero — these are tight
 * class/method tokens, not loose word matches.
 *
 * Pre-D045 dpl-studio surfaced `tlsDisabledCount: 1` in
 * `gatherGenericMetrics` (via `countTlsBypassLines`), but the
 * standalone vuln scan's Code Findings table reported `_Sources:
 * (none)_` with all zeros — the count never reached the standalone
 * scan because TLS-bypass wasn't a first-class finding source. This
 * gather closes that gap.
 *
 * Severity assignment: `high`. CWE: 295 (Improper Certificate
 * Validation).
 *
 * Empty patterns array → returns []. Empty grep output → returns [].
 * Both are legitimate "no TLS-bypass idioms in this codebase" states.
 */
/**
 * G_v4_7 (2.4.7): route TLS-bypass discovery through the canonical
 * walker + per-file in-process line scan. Eliminates the `grep -rnEf`
 * shell path (no maxBuffer ceiling, no per-finding shell escaping).
 * D074 closure: skip comment lines so a commented-out
 * `// NODE_TLS_REJECT_UNAUTHORIZED=0` no longer renders as a HIGH
 * SecurityFinding (the platform vuln-scan false-positive class).
 *
 * `includeTests: true` preserves pre-migration scope — TLS-bypass
 * idioms inside test fixtures were detected before; still are.
 */
export function gatherTlsBypassFindings(cwd: string): SecurityFinding[] {
  const patterns = allTlsBypassPatterns();
  if (patterns.length === 0) return [];
  const compiled = patterns.map((p) => new RegExp(p));
  const files = walkSourceFiles(cwd, { includeTests: true });
  const findings: SecurityFinding[] = [];
  for (const relPath of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, relPath), 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const syntax = commentSyntaxFor(relPath);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (syntax !== 'none' && isCommentLine(line, syntax)) continue;
      let matched = false;
      for (const re of compiled) {
        re.lastIndex = 0;
        if (re.test(line)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      const trimmed = line.trim();
      const snippet = trimmed.length > 100 ? `${trimmed.slice(0, 97)}…` : trimmed;
      findings.push({
        severity: 'high',
        category: 'code',
        cwe: 'CWE-295',
        rule: 'tls-validation-disabled',
        title: `TLS / certificate validation bypass: ${snippet}`,
        file: relPath,
        line: i + 1,
        tool: 'tls-bypass-registry',
      });
    }
  }
  return findings;
}

// ─── dispatcher-driven codePatterns gather ──────────────────────────────────

/**
 * Code-pattern findings are a global capability: the CODE_PATTERNS
 * dispatcher routes to `semgrepProvider` (tools/semgrep.ts) which
 * applies exclusions, suppressions, and the low-confidence filter
 * internally. This layer only reshapes the envelope into
 * `SecurityFinding[]` for the security report.
 */
export async function gatherCodePatterns(cwd: string): Promise<{
  findings: SecurityFinding[];
  toolUsed: string | null;
}> {
  const result = await defaultDispatcher.gather(
    cwd,
    CODE_PATTERNS,
    providersFor(CODE_PATTERNS, cwd),
  );
  if (!result) return { findings: [], toolUsed: null };

  const findings: SecurityFinding[] = result.findings.map((f) => ({
    severity: f.severity,
    category: 'code' as const,
    cwe: f.cwe,
    rule: f.rule,
    title: f.title,
    file: f.file,
    line: f.line,
    tool: result.tool,
  }));
  return { findings, toolUsed: result.tool };
}

// ─── dependency CVEs via the capabilities dispatcher ────────────────────────

const EMPTY_DEP_VULNS: DepVulnSummary = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  total: 0,
  tool: null,
  findings: [],
  // No active pack → genuinely "nothing to scan" (not "scan failed"). The
  // security scorer should not cap the dimension in this case; e.g. a
  // pure-static-asset repo with no language packs active legitimately
  // has no deps to audit. available=true preserves this.
  available: true,
  unavailableReason: '',
};

/**
 * Aggregates dependency vulnerabilities across every active language pack
 * via the capability dispatcher. Replaces the prior hardcoded `npm audit`
 * implementation that silently ignored Python/Go/Rust/C# deps.
 *
 * Returns `EMPTY_DEP_VULNS` when no active pack exposes a depVulns
 * provider, or when every provider returned null (no tool installed
 * / nothing to audit).
 */
/**
 * Shared primitive for availability-aware dep-vuln aggregation. Used by
 * both `gatherDepVulns` (standalone scan + BoM, with enrichment) and
 * `gatherCapabilityReport` in health.ts (no enrichment). Bypassing the
 * dispatcher is the whole point — the dispatcher's `gather()` path
 * collapses every non-success outcome to null, which makes the scorer
 * blind to "tool unavailable" vs "no findings" (the F4 dpl-studio
 * customer-credibility lie). Calling `gatherOutcome` directly preserves
 * the discriminant, then we aggregate via the existing DEP_VULNS
 * descriptor's aggregator.
 *
 * Returned envelope is null only when NO success outcomes occurred;
 * `available` is false when at least one active pack returned
 * `unavailable`. `no-manifest` outcomes do NOT degrade availability —
 * polyglot repos where one pack activates but has nothing to scan are
 * a clean "we checked, found nothing here" state.
 */
export async function gatherDepVulnsWithAvailability(cwd: string): Promise<{
  envelope: DepVulnResult | null;
  available: boolean;
  unavailableReason: string;
}> {
  const activePacks = detectActiveLanguages(cwd).filter((l) => l.capabilities?.depVulns);
  if (activePacks.length === 0) {
    return { envelope: null, available: true, unavailableReason: '' };
  }

  const outcomes = await Promise.allSettled(
    activePacks.map((l) => l.capabilities!.depVulns!.gatherOutcome(cwd)),
  );
  const successEnvelopes: DepVulnResult[] = [];
  let firstUnavailable: { pack: string; reason: string } | null = null;
  for (let i = 0; i < outcomes.length; i++) {
    const r = outcomes[i];
    if (r.status === 'rejected') {
      if (!firstUnavailable) {
        firstUnavailable = {
          pack: activePacks[i].id,
          reason: `provider threw: ${(r.reason as Error)?.message ?? 'unknown error'}`,
        };
      }
      continue;
    }
    const outcome = r.value;
    if (outcome.kind === 'success') {
      successEnvelopes.push(outcome.envelope);
    } else if (outcome.kind === 'unavailable' && !firstUnavailable) {
      firstUnavailable = { pack: activePacks[i].id, reason: outcome.reason };
    }
  }

  const envelope = successEnvelopes.length > 0 ? DEP_VULNS.aggregate(successEnvelopes) : null;
  // G_v4_8 (2.4.7 Phase C1.3): stamp fingerprints on the envelope's
  // findings here, in the shared primitive, so BOTH the health path
  // and the enrichment path (`gatherDepVulns`) produce fingerprint-
  // stamped findings. The aggregator's dep-side dedup needs the
  // fingerprint key; without it, unstamped findings each get a
  // synthetic unique key (no dedup), and health's
  // `depBySeverity` / `dependencyAdvisoryUniqueCount` would drift
  // from vuln-scan's. Idempotent — re-stamping in `gatherDepVulns`
  // produces the same hashes.
  if (envelope?.findings) {
    stampFingerprints(envelope.findings);
  }
  return {
    envelope,
    available: firstUnavailable === null,
    unavailableReason: firstUnavailable
      ? `${firstUnavailable.pack}: ${firstUnavailable.reason}`
      : '',
  };
}

export async function gatherDepVulns(cwd: string): Promise<DepVulnSummary> {
  // D025b (2.4.7): delegates to `gatherDepVulnsWithAvailability` for
  // the availability-aware aggregation; this function adds the
  // enrichment passes (EPSS, KEV, reachability, risk scoring) on top.
  // Health audit calls the shared primitive directly without enrichment;
  // standalone vuln scan + BoM call this function for the enriched path.
  const { envelope, available, unavailableReason } = await gatherDepVulnsWithAvailability(cwd);

  if (!envelope) {
    return {
      ...EMPTY_DEP_VULNS,
      available,
      unavailableReason,
    };
  }

  // Cross-pack EPSS enrichment. Every pack's dep-vuln provider emits
  // findings with an `id` + optional `aliases` list; we hoist CVE IDs
  // across the whole batch, fetch once, then attach `epssScore` in
  // place. Done here rather than per-pack so (a) one session cache
  // serves all packs, (b) the EPSS endpoint sees at most one batched
  // request per analyzer run, (c) non-CVE primaries (GHSA, RUSTSEC,
  // GO-YYYY-NNNN) fall back to aliases uniformly.
  //
  // Two-step lookup: npm-audit only surfaces GHSA IDs with no CVE
  // aliases. When `extractCveId` comes up empty, we fall back to
  // OSV.dev's `/v1/vulns/<GHSA>` which returns a properly-populated
  // alias list including the CVE. One OSV roundtrip resolves the
  // whole batch; one EPSS roundtrip scores them all.
  const findings = envelope.findings ?? [];
  // Stamp durable identity on every finding before enrichment. The hash
  // inputs are package/version/id only, so stamping is independent of
  // EPSS/KEV/reachability results — keeps `fingerprint` stable across
  // runs even if enrichment tooling changes underneath.
  stampFingerprints(findings);
  if (findings.length > 0) {
    const cveByFinding = new Map<number, string>();
    const needsAliasLookup: Array<{ idx: number; primary: string }> = [];
    for (let i = 0; i < findings.length; i++) {
      const direct = extractCveId(findings[i]);
      if (direct) {
        cveByFinding.set(i, direct);
      } else {
        needsAliasLookup.push({ idx: i, primary: findings[i].id });
      }
    }
    if (needsAliasLookup.length > 0) {
      const aliasMap = await resolveAliases(needsAliasLookup.map((x) => x.primary));
      for (const { idx, primary } of needsAliasLookup) {
        const aliases = aliasMap.get(primary) ?? [];
        const cve = aliases.find((a) => a.startsWith('CVE-'));
        if (cve) cveByFinding.set(idx, cve);
      }
    }
    if (cveByFinding.size > 0) {
      const uniqueCves = [...new Set(cveByFinding.values())];
      // EPSS + KEV run in parallel — one roundtrip each, independent
      // endpoints. KEV catalog is a single bulk fetch (~200KB, 1300
      // entries), so subsequent lookups in the same session are free.
      const [scores, kevHits] = await Promise.all([enrichEpss(uniqueCves), enrichKev(uniqueCves)]);
      for (const [idx, cve] of cveByFinding) {
        const score = scores.get(cve);
        if (score !== undefined) findings[idx].epssScore = score;
        if (kevHits.has(cve)) findings[idx].kev = true;
      }
    }

    // Reachability — does the repo's source actually import any of
    // these vulnerable packages? Dispatches the IMPORTS capability
    // (which packs populate from their per-file specifier extraction)
    // once, unions into a name set, then marks every finding. When
    // no pack contributes imports (no source files / all packs
    // declined), leaves `reachable` unset rather than mass-classify
    // everything as false.
    //
    // Intentionally NOT stack-filtered (post-D010): the BoM aggregates
    // across multiple project roots (e.g. `test/fixtures/benchmarks/*`)
    // and findings come from all languages. Reachability needs to walk
    // every pack's imports — filtering by the outer cwd's active packs
    // would silently drop cross-language reachability for findings
    // attributed to inactive-pack roots. Each provider already returns
    // null when its source files don't exist; the cost is a few empty
    // `find` walks at most.
    const importsProviders = providersFor(IMPORTS);
    if (importsProviders.length > 0) {
      const importsEnvelope = await defaultDispatcher.gather(cwd, IMPORTS, importsProviders);
      if (importsEnvelope && importsEnvelope.extracted.size > 0) {
        const reachable = buildReachablePackageSet(importsEnvelope);
        markReachable(findings, reachable);
      }
    }

    // Cross-pack upgrade-plan resolver (Phase 10h.6.4). Runs after
    // per-pack Tier-2 tools have stamped what they can, and before
    // risk scoring so the composite riskScore can factor in the
    // "actionable" bit (future 10h.9.2 CI gate uses it too). Fills
    // gaps by (a) reconciling advisories across plans' `patches[]`
    // lists and (b) parsing the npm-audit transitive-fix free-text
    // template into a structured plan when no tool produced one.
    resolveTransitiveUpgradePlans(findings);

    // Composite riskScore = f(cvss, epss, kev, reachable). Runs last
    // so every signal is populated. Formula is documented in
    // risk-score.ts; skipped for findings without CVSS so we don't
    // fabricate severity from partial data.
    scoreFindings(findings);
  }

  const { critical, high, medium, low } = envelope.counts;
  return {
    critical,
    high,
    medium,
    low,
    total: critical + high + medium + low,
    tool: envelope.tool,
    findings,
    // Even with successful envelopes from some packs, ONE pack returning
    // unavailable means the overall scan was partial — cap honesty
    // applies. The dpl-studio shape post-D025f (sub-branch #3) will have
    // csharp surfacing real CVEs AND any other unavailable pack still
    // capping; that's the architecturally-correct outcome.
    available,
    unavailableReason,
  };
}

// ─── Shared aggregate builder for health (G_v4_8 / C1.3) ─────────────────────

/**
 * Build the canonical `SecurityAggregate` from inputs available to the
 * health analyzer. Re-uses the capability envelopes already gathered by
 * `gatherCapabilityReport` (no double-shells — dispatcher cache hits
 * are free), additionally invoking the two finders not represented in
 * the capability layer (TLS-bypass-registry walk, file findings for
 * private keys + `.env`-in-git).
 *
 * D086 closure foundation: health's `scoreSecurityDimension` reads
 * from this aggregate via `c.securityAggregate?.codeBySeverity`,
 * which is the SAME field the standalone vuln-scan reads after C1.2.
 * Two consumers, one source — no drift possible.
 */
export async function buildSecurityAggregateForHealth(
  cwd: string,
  secrets:
    | {
        tool: string;
        findings: ReadonlyArray<{
          severity: Severity;
          rule: string;
          title?: string;
          file: string;
          line: number;
        }>;
      }
    | undefined,
  codePatterns:
    | {
        tool: string;
        findings: ReadonlyArray<{
          severity: Severity;
          rule: string;
          title: string;
          file: string;
          line: number;
          cwe: string;
        }>;
      }
    | undefined,
  depVulnsEnvelope: DepVulnResult | undefined,
  depVulnsAvailable: boolean,
  depVulnsUnavailableReason: string,
): Promise<SecurityAggregate> {
  // The two gathers not represented in CapabilityReport (vuln-scan-only).
  // Both are cheap: `gatherTlsBypassFindings` is a JS line-scan via
  // `walkSourceFiles`; `gatherFileFindings` is one `find` + one `git
  // ls-files`. Total ~0.5s on a 500-file repo.
  const tlsBypass = gatherTlsBypassFindings(cwd);
  const fileFindings = gatherFileFindings(cwd);

  const secretFindings: SecurityFinding[] = secrets
    ? secrets.findings.map((f) => ({
        severity: f.severity,
        category: 'secret' as const,
        cwe: 'CWE-798',
        rule: f.rule,
        title: f.title ?? `Secret detected: ${f.rule}`,
        file: f.file,
        line: f.line,
        tool: secrets.tool,
      }))
    : [];

  const codeFindings: SecurityFinding[] = codePatterns
    ? codePatterns.findings.map((f) => ({
        severity: f.severity,
        category: 'code' as const,
        cwe: f.cwe,
        rule: f.rule,
        title: f.title,
        file: f.file,
        line: f.line,
        tool: codePatterns.tool,
      }))
    : [];

  return buildSecurityAggregate({
    secrets: { findings: secretFindings, toolUsed: secrets?.tool ?? null },
    fileFindings,
    codePatterns: { findings: codeFindings, toolUsed: codePatterns?.tool ?? null },
    tlsBypass,
    tlsBypassPatternCount: allTlsBypassPatterns().length,
    depVulns: {
      findings: depVulnsEnvelope?.findings ?? [],
      tool: depVulnsEnvelope?.tool ?? null,
      available: depVulnsAvailable,
      unavailableReason: depVulnsUnavailableReason,
    },
  });
}
