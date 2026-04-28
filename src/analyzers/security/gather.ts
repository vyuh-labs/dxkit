/**
 * Security finding gatherers — one function per tool, no overlap.
 *
 * Tool boundaries:
 *   gitleaks   → secrets (hardcoded credentials, API keys, private keys in source)
 *   find/git   → private key files on disk (.key, .pem), .env tracked in git
 *   semgrep    → code patterns (eval, exec, TLS, CORS, SQLi, XSS, SSRF, etc.)
 *   dispatcher → dependency CVEs unioned across every active language pack
 */
import { run } from '../tools/runner';
import { enrichEpss, extractCveId } from '../tools/epss';
import { stampFingerprints } from '../tools/fingerprint';
import { enrichKev } from '../tools/kev';
import { resolveAliases } from '../tools/osv';
import { buildReachablePackageSet, markReachable } from '../tools/reachability';
import { scoreFindings } from '../tools/risk-score';
import { resolveTransitiveUpgradePlans } from '../tools/upgrade-plan-resolver';
import { getFindExcludeFlags } from '../tools/exclusions';
import { SecurityFinding, DepVulnSummary } from './types';
import { defaultDispatcher } from '../dispatcher';
import { detectActiveLanguages } from '../../languages';
import {
  CODE_PATTERNS,
  DEP_VULNS,
  IMPORTS,
  SECRETS,
} from '../../languages/capabilities/descriptors';
import { providersFor } from '../../languages/capabilities';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
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
export async function gatherDepVulns(cwd: string): Promise<DepVulnSummary> {
  const providers: CapabilityProvider<DepVulnResult>[] = [];
  for (const lang of detectActiveLanguages(cwd)) {
    if (lang.capabilities?.depVulns) providers.push(lang.capabilities.depVulns);
  }
  if (providers.length === 0) return EMPTY_DEP_VULNS;

  const envelope = await defaultDispatcher.gather(cwd, DEP_VULNS, providers);
  if (!envelope) return EMPTY_DEP_VULNS;

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
  };
}
