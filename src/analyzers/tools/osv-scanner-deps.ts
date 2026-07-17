/**
 * osv-scanner against any OSV ecosystem — shared across language packs
 * that use osv-scanner as their canonical depVulns source. CLAUDE.md
 * rule #2 — the gather function lives once.
 *
 * History: extracted from `src/languages/kotlin.ts` in 10k.1.4 (Phase
 * 10k.1 SSOT validation), originally Maven-only. Generalized to all
 * OSV ecosystems in 10k.2.6a (Ruby pack work) — caller passes the
 * ecosystem string + manifest candidate list, parser filters
 * accordingly so polyglot repos don't double-count across packs.
 *
 * Current consumers:
 *   - kotlin pack — `Maven` ecosystem, gradle.lockfile + pom.xml + verification-metadata.xml
 *   - java pack — `Maven` ecosystem (same manifest set)
 *   - ruby pack — `RubyGems` ecosystem, Gemfile.lock
 *
 * osv-scanner is the established multi-ecosystem scanner; no Tier-1
 * native equivalent exists for several of the ecosystems above
 * (CLAUDE.md rule #5 — bundler-audit's JSON is unstable, so Ruby
 * intentionally uses osv-scanner-only rather than dual-source).
 * The typescript pack's `osv-scanner-fix.ts` uses the `fix`
 * subcommand for upgrade planning — different mode, no shared logic.
 *
 * Manifest gating: caller supplies the candidate list. First
 * existing candidate wins. Without any of them, returns
 * `tool-missing` (matches python/csharp's manifest-gating pattern).
 */
import {
  classifyOsvSeverity,
  extractOsvCvssScore,
  extractOsvFixVersion,
  resolveCvssScores,
  type OsvVuln,
} from './osv';
import { isMaliciousAdvisory } from '../security/malicious';
import { fileExists, runWithExit } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import type {
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
  SeverityCounts,
} from '../../languages/capabilities/types';
import type { LanguageId } from '../../types';

/** Per-package shape from osv-scanner v2.x JSON output. */
interface OsvScannerPackage {
  package: { name?: string; version?: string; ecosystem?: string };
  vulnerabilities?: OsvVuln[];
}

interface OsvScannerResult {
  source?: { path?: string; type?: string };
  packages?: OsvScannerPackage[];
}

interface OsvScannerOutput {
  results?: OsvScannerResult[];
}

/**
 * Pure parser for osv-scanner v2.x JSON output, scoped to a single
 * ecosystem. Other ecosystems are filtered out so polyglot repos
 * don't double-count: each pack handles its own ecosystem (typescript
 * → npm, python → PyPI, kotlin/java → Maven, ruby → RubyGems, etc.).
 *
 * The ecosystem parameter is matched against the OSV record's
 * `package.ecosystem` field verbatim — use the exact strings OSV
 * emits (`'Maven'`, `'RubyGems'`, `'PyPI'`, `'npm'`, `'Go'`, etc.).
 *
 * Returns counts + findings + the raw OSV vuln records for downstream
 * CVSS resolution. Exported for unit tests.
 */
export function parseOsvScannerFindings(
  raw: string,
  ecosystem: string,
  packId?: LanguageId,
): {
  counts: SeverityCounts;
  findings: DepVulnFinding[];
  vulnsForCvss: Array<{ primaryId: string; embeddedCvss: number | null; aliases: string[] }>;
} {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings: DepVulnFinding[] = [];
  const vulnsForCvss: Array<{
    primaryId: string;
    embeddedCvss: number | null;
    aliases: string[];
  }> = [];
  let data: OsvScannerOutput;
  try {
    data = JSON.parse(raw) as OsvScannerOutput;
  } catch {
    return { counts, findings, vulnsForCvss };
  }
  // Dedup at the source: osv-scanner can list the same advisory twice
  // when a transitive dep is reachable through multiple top-level deps.
  // Same (package, version, id) → same fingerprint, so collapse here.
  const seen = new Set<string>();
  for (const result of data.results ?? []) {
    for (const pkg of result.packages ?? []) {
      if (pkg.package?.ecosystem !== ecosystem) continue;
      const pkgName = pkg.package.name ?? 'unknown';
      const pkgVersion = pkg.package.version;
      for (const vuln of pkg.vulnerabilities ?? []) {
        if (!vuln.id) continue;
        const dedupKey = `${pkgName}\0${pkgVersion ?? ''}\0${vuln.id}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const sev = classifyOsvSeverity(vuln);
        const tier: keyof SeverityCounts =
          sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low'
            ? sev
            : 'medium';
        counts[tier]++;

        const cvss = extractOsvCvssScore(vuln);
        const aliases = (vuln.aliases ?? []).filter((a) => a && a.length > 0);
        const finding: DepVulnFinding = {
          id: vuln.id,
          package: pkgName,
          installedVersion: pkgVersion,
          tool: 'osv-scanner',
          severity: tier,
        };
        // G_v4_4 (2.4.7): stamp the producing pack so `buildUpgradeCommand`
        // can dispatch to the right `LanguageSupport.upgradeCommand` without
        // a hardcoded switch on `tool`. Caller passes the pack id; absent
        // (`undefined`) only on legacy paths we haven't migrated yet.
        if (packId) finding.packId = packId;
        if (cvss !== null) finding.cvssScore = cvss;
        if (aliases.length > 0) finding.aliases = aliases;
        if (vuln.summary) finding.summary = vuln.summary;
        // D042: surface the patch version when OSV's `affected[].
        // ranges[].events[].fixed` is populated. This is the customer's
        // actionable next-step (e.g. "upgrade Newtonsoft.Json from
        // 9.0.1 to 13.0.1 to clear GHSA-5crp-9r3c-p9vr"). Pre-D042 the
        // standalone scan rendered `Fix: —` for every osv-scanner-
        // sourced finding because this field went unread.
        const fixVersion = extractOsvFixVersion(vuln);
        if (fixVersion) finding.fixedVersion = fixVersion;
        // OSV.dev hosts a canonical page per id — synthesize when the
        // record's `references[]` is empty, otherwise keep the
        // tool-supplied URLs.
        const refUrls = (vuln.references ?? []).map((r) => r.url).filter((u): u is string => !!u);
        finding.references =
          refUrls.length > 0 ? refUrls : [`https://osv.dev/vulnerability/${vuln.id}`];
        findings.push(finding);

        vulnsForCvss.push({
          primaryId: vuln.id,
          embeddedCvss: cvss,
          aliases,
        });
      }
    }
  }
  return { counts, findings, vulnsForCvss };
}

/**
 * Single source of truth for osv-scanner-driven dep-vuln gathering.
 * Caller supplies:
 *   - cwd: project root
 *   - source: pack id for envelope attribution (currently reserved —
 *     see note at end of function)
 *   - ecosystem: OSV ecosystem string (`'Maven'`, `'RubyGems'`, ...)
 *   - manifestCandidates: ordered list of manifest filenames to probe.
 *     First existing one is passed via `--lockfile`. Lockfiles
 *     preferred over higher-level manifests (kotlin: gradle.lockfile
 *     before pom.xml; ruby: Gemfile.lock).
 *
 * `scan source --lockfile <path>` is the v2.x form. JSON output to
 * stdout. Exit codes disambiguate completeness (VERIFY-40 F-7): 0 = clean,
 * 1 = vulnerabilities found — BOTH mean the scan finished and its output is
 * the whole observation. Anything else means the scan itself errored
 * (network/API degradation, bad input) and any JSON on stdout may be a
 * PARTIAL result — recording it as complete writes a baseline that
 * under-observes and false-blocks the next check, so those exits are
 * `unavailable` (disclosed), never parsed.
 *
 * CVSS alias-fallback: osv-scanner ships CVSS vectors when present,
 * but advisory data quality varies by ecosystem — some carry only
 * `database_specific.severity` strings. resolveCvssScores looks up
 * via CVE alias when the primary record lacks a vector.
 */
export async function gatherOsvScannerDepVulnsResult(
  cwd: string,
  packId: LanguageId,
  ecosystem: string,
  manifestCandidates: string[],
): Promise<DepVulnGatherOutcome> {
  let manifest: string | null = null;
  for (const rel of manifestCandidates) {
    if (fileExists(cwd, rel)) {
      manifest = rel;
      break;
    }
  }
  if (!manifest) {
    return {
      kind: 'no-manifest',
      reason: `no lockfile found (looked for: ${manifestCandidates.join(', ')})`,
    };
  }

  const scanner = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!scanner.available || !scanner.path) {
    return { kind: 'unavailable', reason: 'osv-scanner not installed' };
  }

  const { code, stdout: raw } = runWithExit(
    `${scanner.path} scan source --lockfile ${manifest} --format json`,
    cwd,
    180000,
  );
  if (code !== 0 && code !== 1) {
    return {
      kind: 'unavailable',
      reason:
        `osv-scanner exited ${code ?? 'without a code (timeout/spawn failure)'} — the scan ` +
        `errored, so its output may be partial and was discarded rather than recorded as a ` +
        `complete observation`,
    };
  }
  if (!raw) return { kind: 'unavailable', reason: 'osv-scanner produced no output' };

  const { counts, findings, vulnsForCvss } = parseOsvScannerFindings(raw, ecosystem, packId);

  if (findings.length > 0) {
    const resolved = await resolveCvssScores(vulnsForCvss);
    for (const f of findings) {
      const score = resolved.get(f.id);
      if (score !== null && score !== undefined) f.cvssScore = score;
    }
  }

  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool: 'osv-scanner',
    enrichment: 'osv.dev',
    counts,
    findings,
  };
  // `packId` is forwarded into `parseOsvScannerFindings` so each finding
  // carries the producing pack, which `buildUpgradeCommand` dispatches on.
  // Envelope-level `tool: 'osv-scanner'` stays as the tool-attribution
  // string used in `toolsUsed`.
  return { kind: 'success', envelope };
}

/**
 * Overlay the ecosystem-maintained malicious-package feed onto a native
 * scanner's result — the canonical-source answer to malware detection.
 *
 * Several packs use a native Tier-1 scanner (npm audit, cargo-audit,
 * govulncheck, `dotnet list --vulnerable`) whose advisory feed does NOT
 * carry OSV's `MAL-*` malicious-package entries, fed by OpenSSF's
 * malicious-packages database. Those packs run osv-scanner as a
 * best-effort second source and merge JUST the malicious findings in via
 * this helper, so the `newMaliciousDependency` gate rule rides the
 * maintained database on every path — never a list dxkit maintains.
 * (Packs whose canonical scanner already IS osv-scanner — java, kotlin,
 * ruby — and pip-audit, which queries OSV natively, need no overlay.)
 *
 * Merge semantics, deliberately narrow:
 *   - ONLY findings the canonical `isMaliciousAdvisory` predicate flags
 *     are appended. Ordinary advisories both scanners see would
 *     double-count, and the native scanner stays the richer source for
 *     them (embedded CVSS, fix targets).
 *   - A malicious finding already represented in the base (same package
 *     with an overlapping advisory id or alias) is skipped.
 *   - Counts are recomputed to include the appended findings, keeping
 *     the envelope's counts consistent with its findings.
 *
 * Pure; callers treat the overlay as best-effort (an unavailable
 * osv-scanner never degrades the native result — fail-open on
 * infrastructure, per the gate's standing policy).
 */
export function mergeMaliciousOsvFindings(
  base: DepVulnResult,
  overlay: DepVulnResult,
): DepVulnResult {
  const overlayFindings = overlay.findings ?? [];
  if (overlayFindings.length === 0) return base;

  const seen = new Set<string>();
  for (const f of base.findings ?? []) {
    seen.add(`${f.package} ${f.id}`);
    for (const a of f.aliases ?? []) seen.add(`${f.package} ${a}`);
  }

  const appended = overlayFindings.filter((f) => {
    if (!isMaliciousAdvisory(f)) return false;
    if (seen.has(`${f.package} ${f.id}`)) return false;
    if ((f.aliases ?? []).some((a) => seen.has(`${f.package} ${a}`))) return false;
    return true;
  });
  if (appended.length === 0) return base;

  const counts = { ...base.counts };
  for (const f of appended) {
    if (f.severity in counts) counts[f.severity as keyof typeof counts] += 1;
  }
  return {
    ...base,
    counts,
    findings: [...(base.findings ?? []), ...appended],
  };
}
