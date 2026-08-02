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
import { readPolicyObjectSafe } from '../baseline/policy-text';
import { readBaselineFile } from '../baseline/baseline-file';

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
}

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

function readBaselineSummaries(cwd: string): LearnRepoStatus['baselines'] {
  const dir = path.join(cwd, '.dxkit', 'baselines');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const name = f.replace(/\.json$/, '');
        try {
          // The one baseline reader (schema-validating) — never a second parse.
          const file = readBaselineFile(path.join(dir, f));
          return { name, capturedAt: file.createdAt, entryCount: file.findings.length };
        } catch {
          // Unreadable / other-schema file: shown as present with no detail.
          return { name, entryCount: 0 };
        }
      });
  } catch {
    return [];
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

  return {
    cwd,
    installed,
    doctor,
    policy: readPolicySummary(cwd),
    baselines: readBaselineSummaries(cwd),
    lastVerdict,
  };
}
