/**
 * Repo-mode data for the learn page — LIVE status assembled from the
 * canonical sources, never re-derived (Rule 2.30):
 *
 *   - `runDoctor(cwd, { quiet: true })` IS the probe engine: wiring checks,
 *     credential gaps (bot token, the Actions PR-create setting), branch
 *     protection, baseline staleness, each with its fix. The setup panel is
 *     a RENDERING of the doctor report's failing checks + the registry's
 *     recommendations; learn adds no probe of its own.
 *   - policy / baseline / last-verdict facts come from their one readers.
 *
 * Everything here is fail-open per field: a missing artifact yields null
 * (rendered as "not set up" / "unknown"), never a throw — the zero-repo
 * page must render from an empty directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runDoctor, type DoctorReport } from '../doctor';
import { readVerdictForTree, type CachedVerdict } from '../baseline/verdict-cache';
import { readPolicyObjectSafe, readPolicyRoot } from '../baseline/policy-text';
import { readBaselineFile } from '../baseline/baseline-file';
import { failingFloorDebt } from '../baseline/floor-debt';
import { collectJobs } from '../jobs-cli';
import { tryLoadGraph, GRAPH_REPORT_PATH } from '../explore/load';
import { graphProfile, type GraphProfileHub } from '../explore/queries';

export interface LearnRepoStatus {
  cwd: string;
  /** Is dxkit installed here (manifest present)? */
  installed: boolean;
  /** The full doctor report — checks, fixable subset, recommendations. */
  doctor: DoctorReport | null;
  /** Loop preset / lint / lanes summary out of `.dxkit/policy.json` (raw
   *  fields only; rendering decides prose). Null when no policy. */
  policy: {
    preset?: string;
    checksCount: number;
    lintEnabled: boolean;
    lanes: string[];
  } | null;
  /** Committed baseline metadata (name → captured info). */
  baselines: Array<{ name: string; capturedAt?: string; entryCount: number }>;
  /** The last same-tree guardrail verdict, when cached. */
  lastVerdict: CachedVerdict | null;
  /** Every installed dxkit workflow: name, triggers, next cron fire. From
   *  the ONE jobs collector (`jobs-cli.ts:collectJobs`, Rule 2.30) with the
   *  gh last-run probe disabled — the page renders offline-fast; live run
   *  conclusions stay `vyuh-dxkit jobs`' job. */
  jobs: Array<{
    workflow: string;
    name: string;
    triggers: string[];
    nextRunUtc?: string;
    dispatchable: boolean;
  }>;
  /** The committed policy file, verbatim — sent to the provider ONLY under
   *  the explicit detail toggle (it can carry custom check commands). */
  rawPolicyText?: string;
  /** The bounded repo profile (tier-1 repo intelligence): cheap artifact
   *  reads with freshness stamps, computed once at gather time. Each field
   *  is null when its artifact is absent — the renderer/grounding then
   *  carries the exact enable command instead (never silence). */
  profile: LearnRepoProfile;
}

/** Tier-1 repo profile. Everything here is an ARTIFACT read (graph.json,
 *  the committed baseline, the newest health report) — learn never runs an
 *  analyzer (serve start stays fast and strictly read-only). */
export interface LearnRepoProfile {
  /** Code-graph shape + freshness. Null = graph not set up. */
  graph: {
    functionCount: number;
    fileCount: number;
    callEdgeCount: number;
    /** Top hub functions by call fan-in. Symbol names + file paths are
     *  repo content: grounding sends them only under the detail toggle. */
    hubs: GraphProfileHub[];
    /** Artifact mtime, ISO. Absent when unreadable. */
    refreshedAt?: string;
    /** Older than STALE_GRAPH_DAYS — the grounding states the refresh
     *  command alongside the numbers. */
    stale: boolean;
  } | null;
  /** Grandfathered-debt shape from the committed baseline(s) plus the
   *  failing floor checks. Null = no baseline. */
  debt: {
    total: number;
    byKind: Record<string, number>;
    /** Counts by observed severity; entries without one land in
     *  'unrated' (pre-4.2 baselines disclose the fallback). */
    bySeverity: Record<string, number>;
    /** Failing floor checks (pack + label only — product-phrased). */
    floorFailing: Array<{ pack: string; label: string }>;
  } | null;
  /** The newest committed health report's headline + ranked actions.
   *  Null = no health report artifact. */
  health: {
    overallScore: number;
    rating: string;
    /** The report's own timestamp — always stated next to derived facts. */
    analyzedAt?: string;
    /** Best action per dimension, ranked by uplift, capped. Reasons are
     *  product-phrased scoring strings (same class as doctor labels). */
    topActions: Array<{ dimension: string; reason: string; upliftIfFixed?: number }>;
  } | null;
}

/** A graph artifact older than this reads as stale (design 2026-08-03). */
const STALE_GRAPH_DAYS = 14;

/** Which lane workflows are installed (filename presence, read-only). */
function installedLanes(cwd: string): string[] {
  const lanes: Array<[string, string]> = [
    ['baseline refresh', 'dxkit-baseline-refresh.yml'],
    ['dependency bump', 'dxkit-dep-bump.yml'],
    ['remediation', 'dxkit-remediate.yml'],
  ];
  const out: string[] = [];
  for (const [label, file] of lanes) {
    if (fs.existsSync(path.join(cwd, '.github', 'workflows', file))) out.push(label);
  }
  return out;
}

function readPolicySummary(cwd: string): LearnRepoStatus['policy'] {
  // The ONE policy file reader (JSONC-aware, fail-open) — never a second
  // JSON.parse of policy.json (Rule 2.30).
  const raw = readPolicyObjectSafe(cwd);
  if (!raw) return null;
  const loop = raw.loop as Record<string, unknown> | undefined;
  const lint = raw.lint as Record<string, unknown> | undefined;
  return {
    preset: typeof loop?.preset === 'string' ? loop.preset : undefined,
    checksCount: Array.isArray(raw.checks) ? raw.checks.length : 0,
    lintEnabled: !!lint?.enabled,
    lanes: installedLanes(cwd),
  };
}

/** One pass over the committed baselines yields BOTH the per-file
 *  summaries and the aggregate debt shape (no double read). */
function readBaselines(cwd: string): {
  summaries: LearnRepoStatus['baselines'];
  debt: LearnRepoProfile['debt'];
} {
  const dir = path.join(cwd, '.dxkit', 'baselines');
  const summaries: LearnRepoStatus['baselines'] = [];
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const floorFailing: Array<{ pack: string; label: string }> = [];
  let total = 0;
  let anyRead = false;
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const name = f.replace(/\.json$/, '');
      try {
        // The one baseline reader (schema-validating) — never a second parse.
        const file = readBaselineFile(path.join(dir, f));
        summaries.push({ name, capturedAt: file.createdAt, entryCount: file.findings.length });
        anyRead = true;
        total += file.findings.length;
        for (const entry of file.findings) {
          byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
          const sev = 'severity' in entry && entry.severity ? entry.severity : 'unrated';
          bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
        }
        if (file.floorDebt) {
          for (const c of failingFloorDebt(file.floorDebt)) {
            floorFailing.push({ pack: c.pack, label: c.label });
          }
        }
      } catch {
        // Unreadable / other-schema file: shown as present with no detail.
        summaries.push({ name, entryCount: 0 });
      }
    }
  } catch {
    return { summaries: [], debt: null };
  }
  return {
    summaries,
    debt: anyRead ? { total, byKind, bySeverity, floorFailing } : null,
  };
}

/** Graph profile from the committed artifact via the canonical loader +
 *  query (Rule 12). Null when the graph is not set up. */
function readGraphProfile(cwd: string): LearnRepoProfile['graph'] {
  const graph = tryLoadGraph(cwd);
  if (!graph) return null;
  const p = graphProfile(graph);
  let refreshedAt: string | undefined;
  let stale = false;
  try {
    const mtime = fs.statSync(path.join(cwd, GRAPH_REPORT_PATH)).mtime;
    refreshedAt = mtime.toISOString();
    stale = Date.now() - mtime.getTime() > STALE_GRAPH_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    // Artifact readable via the loader but unstattable: no stamp, not stale.
  }
  return { ...p, ...(refreshedAt ? { refreshedAt } : {}), stale };
}

/** Headline + ranked actions from the NEWEST committed health report.
 *  First reader of this artifact; date-named files sort lexically so the
 *  newest is the last name. Fail-open: any shape surprise yields null. */
function readHealthSummary(cwd: string): LearnRepoProfile['health'] {
  const dir = path.join(cwd, '.dxkit', 'reports');
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => /^health-audit-\d{4}-\d{2}-\d{2}-detailed\.json$/.test(f))
      .sort()
      .pop();
    if (!newest) return null;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf-8')) as {
      analyzedAt?: string;
      summary?: { overallScore?: number; rating?: string };
      dimensions?: Record<
        string,
        { topActions?: Array<{ reason?: string; upliftIfFixed?: number }> }
      >;
    };
    if (typeof raw.summary?.overallScore !== 'number' || typeof raw.summary.rating !== 'string') {
      return null;
    }
    const topActions: Array<{ dimension: string; reason: string; upliftIfFixed?: number }> = [];
    for (const [dimension, dim] of Object.entries(raw.dimensions ?? {})) {
      const best = dim.topActions?.[0];
      if (!best || typeof best.reason !== 'string') continue;
      topActions.push({
        dimension,
        reason: best.reason,
        ...(typeof best.upliftIfFixed === 'number' ? { upliftIfFixed: best.upliftIfFixed } : {}),
      });
    }
    topActions.sort((a, b) => (b.upliftIfFixed ?? 0) - (a.upliftIfFixed ?? 0));
    return {
      overallScore: raw.summary.overallScore,
      rating: raw.summary.rating,
      ...(typeof raw.analyzedAt === 'string' ? { analyzedAt: raw.analyzedAt } : {}),
      topActions: topActions.slice(0, 6),
    };
  } catch {
    return null;
  }
}

export async function gatherLearnRepoStatus(cwd: string): Promise<LearnRepoStatus | null> {
  // Zero-context path: not a repo dxkit knows anything about → no status
  // section at all (the page is the pure capability guide).
  const installed = fs.existsSync(path.join(cwd, '.vyuh-dxkit.json'));
  const hasDxkitDir = fs.existsSync(path.join(cwd, '.dxkit'));
  const hasGit = fs.existsSync(path.join(cwd, '.git'));
  if (!installed && !hasDxkitDir && !hasGit) return null;

  let doctor: DoctorReport | null = null;
  try {
    doctor = await runDoctor(cwd, { quiet: true });
  } catch {
    doctor = null;
  }

  let lastVerdict: CachedVerdict | null = null;
  try {
    lastVerdict = readVerdictForTree(cwd);
  } catch {
    lastVerdict = null;
  }

  // The ONE policy reader again (Rule 2.30): readPolicyRoot returns the raw
  // text alongside the parsed root, so no second file read exists.
  const policyRead = readPolicyRoot(path.join(cwd, '.dxkit', 'policy.json'));
  const rawPolicyText = policyRead.status === 'ok' ? policyRead.text.slice(0, 20_000) : undefined;

  let jobs: LearnRepoStatus['jobs'] = [];
  try {
    jobs = collectJobs(cwd, { lastRunProbe: () => undefined }).map((j) => ({
      workflow: j.workflow,
      name: j.name,
      triggers: [...j.triggers],
      ...(j.nextRunUtc ? { nextRunUtc: j.nextRunUtc } : {}),
      dispatchable: j.dispatchable,
    }));
  } catch {
    jobs = [];
  }

  const { summaries, debt } = readBaselines(cwd);

  return {
    cwd,
    installed,
    doctor,
    policy: readPolicySummary(cwd),
    baselines: summaries,
    lastVerdict,
    jobs,
    rawPolicyText,
    profile: {
      graph: readGraphProfile(cwd),
      debt,
      health: readHealthSummary(cwd),
    },
  };
}
