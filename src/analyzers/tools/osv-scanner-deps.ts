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
 * stdout. Exit code is non-zero when findings exist — we ignore the
 * exit code and parse the JSON regardless (run() already swallows
 * non-zero exits cleanly via execSync's catch).
 *
 * CVSS alias-fallback: osv-scanner ships CVSS vectors when present,
 * but advisory data quality varies by ecosystem — some carry only
 * `database_specific.severity` strings. resolveCvssScores looks up
 * via CVE alias when the primary record lacks a vector.
 */
export async function gatherOsvScannerDepVulnsResult(
  cwd: string,
  source: string,
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
  if (!manifest) return { kind: 'tool-missing' };

  const scanner = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!scanner.available || !scanner.path) return { kind: 'tool-missing' };

  const raw = run(
    `${scanner.path} scan source --lockfile ${manifest} --format json 2>/dev/null`,
    cwd,
    180000,
  );
  if (!raw) return { kind: 'no-output' };

  const { counts, findings, vulnsForCvss } = parseOsvScannerFindings(raw, ecosystem);

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
