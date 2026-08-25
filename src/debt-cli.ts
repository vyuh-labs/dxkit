/**
 * `vyuh-dxkit debt` — the one repair inventory a cleanup agent reads.
 *
 * The adoption arc this serves: arm the gates (regressions now block), then
 * deploy agents to burn the BASELINE down — and "the baseline" is two
 * different kinds of debt with two different homes:
 *
 *   - CORRECTNESS-FLOOR debt (broken build, failing tests). Never a
 *     fingerprinted finding (Rule 15 — you fix a syntax error, you don't
 *     grandfather it), so its ground truth is a LIVE floor run. The
 *     baseline's `floorDebt` envelope supplies provenance: which failures
 *     were already failing at capture ("baseline debt") vs appeared since
 *     (the gate's business, but named here too so nothing hides).
 *   - FINDING debt (secrets, CVEs, SAST, lint backlog…), fingerprinted in
 *     the committed baseline file, ranked by severity.
 *
 * The output ends with a SUGGESTED ORDER, built on one hard dependency:
 * while the build is broken, nothing else is reliably measurable — fix
 * compilation first, then tests, then findings by severity. Environment-
 * unobservable checks are listed with their remedy, never silently absent
 * (Rule 20).
 *
 * Informational, never a gate: exit code is always 0. Composes existing
 * canonical machinery only — `captureFloorDebt` (the same capture the
 * baseline write uses), `checkKey` (the one floor-check identity), the
 * baseline reader, and the canonical per-kind severity table.
 */
import * as fs from 'fs';
import * as logger from './logger';
import { pathForBaseline, readBaselineFile, type BaselineFile } from './baseline/baseline-file';
import { captureFloorDebt, failingFloorDebt, type FloorDebt } from './baseline/floor-debt';
import { checkKey } from './analyzers/correctness/attribution';
import { activeDeferredEntries, daysUntilDate, tryLoadAllowlist } from './allowlist/file';
import { KIND_DEFAULT_SEVERITY, describeEntryLocation } from './baseline/check';
import type { BaselineEntry, FindingSeverity } from './baseline/types';

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});

/** One live floor failure with its baseline provenance. */
export interface DebtFloorFailure {
  readonly pack: string;
  readonly label: string;
  readonly command: string;
  readonly output?: string;
  /** 'baseline' — already failing when the baseline was captured (the debt
   *  to clean); 'new' — failing now but not then (the gate's business);
   *  'unknown' — no baseline envelope to compare against. */
  readonly sinceBaseline: 'baseline' | 'new' | 'unknown';
}

export interface DebtFindingGroup {
  readonly kind: string;
  readonly severity: FindingSeverity;
  /**
   * Where `severity` came from (4.2): 'observed' — every entry carries its
   * captured severity and the group takes the highest; 'partial' — some
   * entries pre-date severity capture, highest observed wins; 'kind-default'
   * — no entry carries one (a pre-4.2 baseline), so this is the kind's
   * PRIORITY guess, not a measured severity. Disclosed so the burn-down
   * ordering never presents a default as a measurement.
   */
  readonly severitySource: 'observed' | 'partial' | 'kind-default';
  readonly count: number;
  /** Entry counts by observed severity (only severities present appear).
   *  Empty on a pre-4.2 baseline. */
  readonly bySeverity: Readonly<Partial<Record<FindingSeverity, number>>>;
  /** Up to three sample entries so an agent can orient without the file. */
  readonly samples: ReadonlyArray<{ fingerprint: string; locator: string }>;
}

/** An ACTIVE allowlist-deferred finding (#285): suppressed from the verdict
 *  until `expiresAt`, then it re-blocks — so it belongs in the repair
 *  inventory NOW. The live class: nine advisories were deferred with "the
 *  fix-vulns lane will fix them", the lane read this report, the deferrals
 *  were invisible to it, and the run completed as a no-op with the fix
 *  window silently wasted. */
export interface DebtDeferredEntry {
  readonly fingerprint: string;
  readonly kind: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly daysRemaining: number;
}

export interface DebtReport {
  readonly schema: 'dxkit.debt.v1';
  readonly baselinePresent: boolean;
  /** 'live' — the floor was re-run now (ground truth); 'stored' — the
   *  baseline's recorded envelope only (instant, possibly stale). */
  readonly floorSource: 'live' | 'stored';
  readonly floor: {
    readonly live: FloorDebt | null;
    readonly baseline: FloorDebt | null;
    readonly failures: ReadonlyArray<DebtFloorFailure>;
    readonly fixedSinceBaseline: ReadonlyArray<string>;
    readonly unobservable: ReadonlyArray<string>;
  };
  readonly findings: {
    readonly total: number;
    readonly groups: ReadonlyArray<DebtFindingGroup>;
  };
  /** Active deferrals (#285) — a DISTINCT section, never merged into the
   *  baseline groups: deferral means "do not GATE on this now", and must
   *  not also mean "hide it from the lane whose job is fixing it".
   *  Gating behavior is untouched (still suppressed until expiry). */
  readonly deferred: ReadonlyArray<DebtDeferredEntry>;
  readonly plan: ReadonlyArray<string>;
}

/** Build the composed debt report. Pure of process I/O; injectable floor
 *  capture for tests. */
export function buildDebtReport(
  cwd: string,
  opts: {
    readonly name?: string;
    readonly liveFloor?: (cwd: string) => FloorDebt | null;
    /** Skip the live floor run and read only the baseline's recorded
     *  envelope — instant, honest about its staleness. */
    readonly stored?: boolean;
    /** The clock for deferral expiry (injectable for tests). */
    readonly now?: Date;
  } = {},
): DebtReport {
  const name = opts.name ?? 'main';
  let baseline: BaselineFile | null = null;
  try {
    if (fs.existsSync(pathForBaseline(cwd, name))) {
      baseline = readBaselineFile(pathForBaseline(cwd, name));
    }
  } catch {
    baseline = null; // unreadable baseline → report proceeds without it
  }

  const storedFloor = baseline?.floorDebt ?? null;
  // Stored mode reads the envelope AS the floor state: every recorded
  // failure is by definition 'baseline' debt, and nothing can be credited
  // as fixed (we did not look). Live mode is ground truth.
  const live = opts.stored ? storedFloor : (opts.liveFloor ?? captureFloorDebt)(cwd);
  const storedByKey = new Map(
    (storedFloor?.checks ?? []).map((c) => [checkKey(c.pack, c.label), c.status]),
  );

  const failures: DebtFloorFailure[] = (live ? failingFloorDebt(live) : []).map((c) => {
    const stored = storedByKey.get(checkKey(c.pack, c.label));
    return {
      pack: c.pack,
      label: c.label,
      command: c.command,
      ...(c.output !== undefined ? { output: c.output } : {}),
      sinceBaseline: storedFloor === null ? 'unknown' : stored === 'fail' ? 'baseline' : 'new',
    };
  });
  const liveByKey = new Map((live?.checks ?? []).map((c) => [checkKey(c.pack, c.label), c]));
  const fixedSinceBaseline = (!opts.stored && storedFloor ? failingFloorDebt(storedFloor) : [])
    .filter((c) => {
      const now = liveByKey.get(checkKey(c.pack, c.label));
      return now !== undefined && now.status === 'pass';
    })
    .map((c) => `${c.pack} ${c.label}`);
  const unobservable = (live?.checks ?? [])
    .filter((c) => c.status.startsWith('skipped') && (c.unmet || c.output))
    .map((c) => `${c.pack} ${c.label}: ${c.unmet ?? c.output ?? ''}`);

  const byKind = new Map<string, BaselineEntry[]>();
  for (const e of baseline?.findings ?? []) {
    const arr = byKind.get(e.kind) ?? [];
    arr.push(e);
    byKind.set(e.kind, arr);
  }
  const groups: DebtFindingGroup[] = [...byKind.entries()]
    .map(([kind, entries]) => {
      // Severity is REAL where the baseline captured it (4.2): the group takes
      // the highest observed severity; only a pre-4.2 baseline falls back to
      // the kind default, and the source is disclosed either way so the
      // ordering never presents a priority guess as a measurement.
      const observed = entries
        .map((e) => (e as { severity?: FindingSeverity }).severity)
        .filter((s): s is FindingSeverity => s !== undefined);
      const bySeverity: Partial<Record<FindingSeverity, number>> = {};
      for (const s of observed) bySeverity[s] = (bySeverity[s] ?? 0) + 1;
      const severity =
        observed.length > 0
          ? observed.reduce((a, b) => (SEVERITY_RANK[b] < SEVERITY_RANK[a] ? b : a))
          : (KIND_DEFAULT_SEVERITY[kind as BaselineEntry['kind']] ?? 'medium');
      const severitySource: DebtFindingGroup['severitySource'] =
        observed.length === entries.length
          ? 'observed'
          : observed.length > 0
            ? 'partial'
            : 'kind-default';
      return {
        kind,
        severity,
        severitySource,
        count: entries.length,
        bySeverity,
        samples: entries.slice(0, 3).map((e) => ({
          fingerprint: e.id,
          locator: describeEntryLocation(e) || e.kind,
        })),
      };
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);

  // The one hard dependency the ordering encodes: a broken build makes
  // everything downstream unmeasurable — fix it before anything else.
  const plan: string[] = [];
  const buildFailures = failures.filter((f) => !/test/i.test(f.label));
  const testFailures = failures.filter((f) => /test/i.test(f.label));
  if (buildFailures.length > 0) {
    plan.push(
      `Fix the build first — nothing else is reliably measurable until it compiles: ${buildFailures
        .map((f) => `${f.pack} ${f.label} (${f.command})`)
        .join('; ')}`,
    );
  }
  if (testFailures.length > 0) {
    plan.push(
      `Fix the failing tests: ${testFailures
        .map((f) => `${f.pack} ${f.label} (${f.command})`)
        .join('; ')}`,
    );
  }
  for (const g of groups) {
    const breakdown = Object.entries(g.bySeverity)
      .sort(([a], [b]) => SEVERITY_RANK[a as FindingSeverity] - SEVERITY_RANK[b as FindingSeverity])
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');
    const uncaptured = g.count - Object.values(g.bySeverity).reduce((a, b) => a + (b ?? 0), 0);
    const sev =
      g.severitySource === 'kind-default'
        ? `${g.severity} — kind priority, not per-finding severity; re-baseline to capture it`
        : breakdown + (uncaptured > 0 ? `, ${uncaptured} without captured severity` : '');
    plan.push(
      `Burn down ${g.count} ${g.kind} finding(s) (${sev}) — fingerprints in the baseline file`,
    );
  }
  if (unobservable.length > 0) {
    plan.push(
      `Unmeasurable here (install the toolchain or rely on CI): ${unobservable.join('; ')}`,
    );
  }
  // Active deferrals (#285): unexpired allowlist entries in the 'deferred'
  // category. Each returns as a BLOCKER on its expiry, so it is repair
  // inventory now — the defer's forcing-function design only works if
  // something works the item during the window.
  const now = opts.now ?? new Date();
  const allowlist = tryLoadAllowlist(cwd);
  const deferred: DebtDeferredEntry[] = activeDeferredEntries(allowlist, now)
    .map((e) => ({
      fingerprint: e.fingerprint,
      kind: e.kind,
      reason: e.reason ?? '',
      expiresAt: e.expiresAt!,
      // The ONE expiry countdown (allowlist/file.ts) — doctor, the audit,
      // the lapse projection, and this report agree on the same date math.
      daysRemaining: daysUntilDate(e.expiresAt!, now),
    }))
    .filter((e) => e.daysRemaining >= 0)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
  if (deferred.length > 0) {
    const earliest = deferred[0];
    plan.push(
      `Fix the ${deferred.length} DEFERRED finding(s) — suppressed from the verdict until ` +
        `expiry, then they re-block (earliest: ${earliest.expiresAt}, ` +
        `${earliest.daysRemaining} day(s) away). Fixing them inside the window is the point ` +
        `of the defer.`,
    );
  }

  if (plan.length === 0)
    plan.push('No recorded debt — the floor is green and the baseline is empty.');

  return {
    schema: 'dxkit.debt.v1',
    baselinePresent: baseline !== null,
    floorSource: opts.stored ? 'stored' : 'live',
    floor: { live, baseline: storedFloor, failures, fixedSinceBaseline, unobservable },
    findings: { total: baseline?.findings.length ?? 0, groups },
    deferred,
    plan,
  };
}

/** Console rendering of a debt report. */
export function renderDebtConsole(report: DebtReport): string {
  const lines: string[] = [];
  lines.push('Repair inventory (informational — never gates; exit is always 0)');
  lines.push('');
  lines.push('CORRECTNESS FLOOR');
  if (report.floorSource === 'stored') {
    const cap = report.floor.baseline;
    lines.push(
      cap
        ? `  (recorded at baseline capture ${cap.capturedAt}${cap.capturedAtCommit ? ` @ ${cap.capturedAtCommit.slice(0, 12)}` : ''} — possibly stale; drop --stored for live state)`
        : '  (no recorded floor envelope in the baseline — drop --stored for a live run)',
    );
  }
  if (report.floor.live === null) {
    lines.push('  no active language pack provides a floor');
  } else if (report.floor.failures.length === 0) {
    lines.push('  all measurable checks pass');
  } else {
    for (const f of report.floor.failures) {
      const tag =
        f.sinceBaseline === 'baseline'
          ? 'failing since the baseline was captured'
          : f.sinceBaseline === 'new'
            ? 'NEW since the baseline (the gate blocks this as net-new)'
            : 'no baseline envelope to compare against';
      lines.push(`  ✗ ${f.pack} ${f.label} — ${tag}`);
      lines.push(`      repro: ${f.command}`);
      if (f.output) {
        for (const l of f.output.split('\n').slice(-8)) lines.push(`      ${l}`);
      }
    }
  }
  if (report.floor.fixedSinceBaseline.length > 0) {
    lines.push(`  fixed since baseline: ${report.floor.fixedSinceBaseline.join(', ')}`);
  }
  for (const u of report.floor.unobservable) lines.push(`  ~ ${u}`);
  lines.push('');
  lines.push(`FINDING DEBT (${report.findings.total} baselined finding(s))`);
  for (const g of report.findings.groups) {
    lines.push(`  ${g.severity.padEnd(8)} ${g.kind.padEnd(22)} ${g.count}`);
  }
  if (report.findings.groups.length === 0) {
    lines.push(
      report.baselinePresent
        ? '  none — the baseline is clean'
        : '  no baseline file — run `vyuh-dxkit baseline create` first',
    );
  }
  if (report.deferred.length > 0) {
    lines.push('');
    lines.push(
      `DEFERRED (${report.deferred.length} — suppressed until expiry, then they RE-BLOCK)`,
    );
    for (const d of report.deferred) {
      lines.push(
        `  ${d.kind.padEnd(12)} ${d.fingerprint}  returns ${d.expiresAt} ` +
          `(${d.daysRemaining} day(s)) — ${d.reason}`,
      );
    }
    lines.push('  Fixing these inside the window is the point of the defer.');
  }
  lines.push('');
  lines.push('SUGGESTED ORDER');
  report.plan.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
  return lines.join('\n');
}

/** CLI entry: render (or emit JSON) and always exit 0 — a report, not a gate. */
export async function runDebtCli(
  cwd: string,
  opts: { readonly json?: boolean; readonly name?: string; readonly stored?: boolean },
): Promise<void> {
  if (!opts.stored && !opts.json) {
    logger.info(
      'running the correctness floor (compile + tests) for live state — minutes on large repos; `--stored` reads the recorded inventory instantly',
    );
  }
  const report = buildDebtReport(cwd, { name: opts.name, stored: opts.stored });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    logger.info(renderDebtConsole(report));
  }
}
