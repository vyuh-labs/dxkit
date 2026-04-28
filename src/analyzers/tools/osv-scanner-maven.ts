/**
 * osv-scanner against the Maven ecosystem — shared across JVM packs
 * (kotlin, java). CLAUDE.md rule #2 — the gather function lives once.
 * Extracted from src/languages/kotlin.ts in 10k.1.4 (Phase 10k.1
 * SSOT validation).
 *
 * osv-scanner is the established multi-ecosystem scanner; no Tier-1
 * native equivalent exists for Maven/Gradle (CLAUDE.md rule #5).
 * The typescript pack's `osv-scanner-fix.ts` uses the `fix`
 * subcommand for upgrade planning — different mode, no shared logic.
 *
 * Manifest gating: osv-scanner reads `pom.xml`, `gradle.lockfile`,
 * `gradle/verification-metadata.xml`, and (limited) `build.gradle`. Bare
 * `build.gradle.kts` is NOT a reliable input — gradle.lockfile is
 * preferred. Without any of these, we return `tool-missing` (matches
 * python/csharp's manifest-gating pattern).
 */
import { classifyOsvSeverity, extractOsvCvssScore, resolveCvssScores, type OsvVuln } from './osv';
import { fileExists, run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import type {
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
  SeverityCounts,
} from '../../languages/capabilities/types';

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
 * Pure parser for osv-scanner v2.x JSON output, scoped to Maven
 * findings only. Other ecosystems (npm, PyPI, Go) are filtered out so
 * polyglot repos don't double-count: the typescript pack handles npm,
 * the python pack handles PyPI, etc. JVM packs (kotlin, java) own
 * Maven via this shared parser.
 *
 * Returns counts + findings + the raw OSV vuln records for downstream
 * CVSS resolution. Exported for unit tests.
 */
export function parseOsvScannerMavenFindings(raw: string): {
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
      if (pkg.package?.ecosystem !== 'Maven') continue;
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
        if (cvss !== null) finding.cvssScore = cvss;
        if (aliases.length > 0) finding.aliases = aliases;
        if (vuln.summary) finding.summary = vuln.summary;
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
 * Single source of truth for osv-scanner Maven dep-vuln gathering.
 * Both kotlin and java packs delegate here.
 *
 * Manifest discovery order: lockfile > pom.xml > verification-metadata.
 * We pass the manifest explicitly via --lockfile so osv-scanner doesn't
 * fall back to its (unreliable) build.gradle.kts parser. Multi-module
 * Android/Java projects with per-module lockfiles are not yet handled —
 * first-module-found is the v1 behaviour.
 *
 * `scan source --lockfile <path>` is the v2.x form. JSON output to
 * stdout. Exit code is non-zero when findings exist — we ignore the
 * exit code and parse the JSON regardless (run() already swallows
 * non-zero exits cleanly via execSync's catch).
 *
 * CVSS alias-fallback: osv-scanner ships CVSS vectors when present, but
 * Maven advisories are inconsistent — some carry only
 * `database_specific.severity` strings. resolveCvssScores looks up via
 * CVE alias when the primary record lacks a vector.
 */
export async function gatherOsvScannerMavenDepVulnsResult(
  cwd: string,
  source: string,
): Promise<DepVulnGatherOutcome> {
  const manifestCandidates = ['gradle.lockfile', 'pom.xml', 'gradle/verification-metadata.xml'];
  let manifest: string | null = null;
  for (const rel of manifestCandidates) {
    if (fileExists(cwd, rel)) {
      manifest = rel;
      break;
    }
  }
  if (!manifest) return { kind: 'tool-missing' };

  const scanner = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!scanner.available || !scanner.path) return { kind: 'tool-missing' };

  const raw = run(
    `${scanner.path} scan source --lockfile ${manifest} --format json 2>/dev/null`,
    cwd,
    180000,
  );
  if (!raw) return { kind: 'no-output' };

  const { counts, findings, vulnsForCvss } = parseOsvScannerMavenFindings(raw);

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
  // Note: `source` is unused at the envelope level today — DepVulnResult
  // carries `tool: 'osv-scanner'` as the producer attribution. Reserved
  // for a future enhancement that distinguishes per-pack provenance
  // (e.g., when both kotlin and java packs run on a mixed monorepo and
  // we want to attribute findings to the originating pack).
  void source;
  return { kind: 'success', envelope };
}
