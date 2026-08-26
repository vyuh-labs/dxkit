/**
 * The DEFERRAL JOIN (split from `gather.ts` at the module-size bar): active
 * deferred allowlist entries joined to what they suppress — a live/BoM/
 * injected dependency-scan finding first (the richer copy: fixed version,
 * reachability), the baseline entry as fallback, or nothing (disclosed as
 * unjoined by the planner). The scan is paid only when a dep-vuln deferral
 * exists, and a fresh persisted BoM artifact (`.dxkit/bom.json`) is
 * preferred over a live audit, disclosed either way.
 */
import * as fs from 'fs';
import * as path from 'path';
import { gatherDepVulnsWithAvailability } from '../../analyzers/security/gather';
import { activeDeferredEntries, type AllowlistFile } from '../../allowlist/file';
import type { RichBaselineEntry } from '../../baseline/types';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import type { AdvisoryInput, DeferredInput } from './planner';
import type { GatherWorkOrderOptions } from './gather';

/** Which source answered the deferral join. */
export type DepScanSource = 'bom-artifact' | 'live-scan' | 'injected' | 'not-needed';

/** How long a persisted BoM artifact counts as fresh for the deferral join.
 *  Deferral windows are days; a week-old fixed-version fact is still the
 *  right starting point, and the disclosure names the age either way. */
export const BOM_FRESHNESS_DAYS = 7;

function advisoryFromLive(f: DepVulnFinding): AdvisoryInput {
  return {
    id: f.fingerprint!,
    package: f.package,
    ...(f.installedVersion !== undefined ? { installedVersion: f.installedVersion } : {}),
    advisoryId: f.id,
    ...(f.severity !== undefined ? { severity: f.severity } : {}),
    ...(f.fixedVersion !== undefined ? { fixedVersion: f.fixedVersion } : {}),
    ...(f.reachable !== undefined ? { reachable: f.reachable } : {}),
    ...(f.packId !== undefined ? { pack: f.packId } : {}),
  };
}

function advisoryFromEntry(e: Extract<RichBaselineEntry, { kind: 'dep-vuln' }>): AdvisoryInput {
  return {
    id: e.id,
    package: e.package,
    ...(e.installedVersion !== undefined ? { installedVersion: e.installedVersion } : {}),
    advisoryId: e.advisoryId,
    ...(e.severity !== undefined ? { severity: e.severity } : {}),
  };
}

/** A fresh persisted BoM artifact's findings, when one exists (the scan the
 *  repo already paid for), else null. Defensive: any shape surprise reads as
 *  absent, never a crash. */
function bomArtifactFindings(
  cwd: string,
  now: Date,
): { findings: DepVulnFinding[]; ageDays: number } | null {
  try {
    const p = path.join(cwd, '.dxkit', 'bom.json');
    if (!fs.existsSync(p)) return null;
    const bom = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      analyzedAt?: string;
      entries?: ReadonlyArray<{ vulns?: DepVulnFinding[] }>;
    };
    if (typeof bom.analyzedAt !== 'string' || !Array.isArray(bom.entries)) return null;
    const ageDays = (now.getTime() - Date.parse(bom.analyzedAt)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > BOM_FRESHNESS_DAYS) return null;
    const findings = bom.entries.flatMap((e) => e.vulns ?? []).filter((v) => v && v.fingerprint);
    return { findings, ageDays };
  } catch {
    return null;
  }
}

export async function joinDeferrals(
  cwd: string,
  allowlist: AllowlistFile | null,
  byId: ReadonlyMap<string, RichBaselineEntry>,
  opts: GatherWorkOrderOptions,
  disclosures: string[],
): Promise<{ deferred: DeferredInput[]; depScanSource: DepScanSource }> {
  const now = opts.now ?? new Date();
  const deferred = activeDeferredEntries(allowlist, now);
  const needsScan = deferred.some((d) => d.kind === 'dep-vuln');
  const scanned = new Map<string, DepVulnFinding>();
  let depScanSource: DepScanSource = 'not-needed';
  if (needsScan) {
    if (opts.scanDepVulns) {
      depScanSource = 'injected';
      for (const f of (await opts.scanDepVulns(cwd)) ?? []) {
        if (f.fingerprint) scanned.set(f.fingerprint, f);
      }
    } else {
      const bom = bomArtifactFindings(cwd, now);
      if (bom) {
        depScanSource = 'bom-artifact';
        disclosures.push(
          `deferral join read the persisted BoM artifact (.dxkit/bom.json, ` +
            `${bom.ageDays.toFixed(1)} day(s) old) instead of paying a live dependency audit`,
        );
        for (const f of bom.findings) scanned.set(f.fingerprint!, f);
      } else {
        depScanSource = 'live-scan';
        disclosures.push(
          'deferral join ran a live dependency audit (no fresh .dxkit/bom.json artifact to read)',
        );
        const result = await gatherDepVulnsWithAvailability(cwd);
        for (const f of result.envelope?.findings ?? []) {
          if (f.fingerprint) scanned.set(f.fingerprint, f);
        }
      }
    }
  }
  const joined = deferred.map((d): DeferredInput => {
    const base = { fingerprint: d.fingerprint, expiresAt: d.expiresAt! };
    const hit = scanned.get(d.fingerprint);
    if (hit) return { ...base, kind: 'dep-vuln', advisory: advisoryFromLive(hit) };
    const entry = byId.get(d.fingerprint);
    if (!entry) return { ...base, kind: 'unjoined', declaredKind: d.kind };
    if (entry.kind === 'dep-vuln')
      return { ...base, kind: 'dep-vuln', advisory: advisoryFromEntry(entry) };
    if (entry.kind === 'custom-check') return { ...base, kind: 'custom-check', entry };
    return { ...base, kind: 'other', entry };
  });
  return { deferred: joined, depScanSource };
}
