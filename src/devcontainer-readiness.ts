/**
 * The devcontainer readiness record: what the generated `post-create.sh`
 * concluded about the environment it provisioned. The script (writer) runs
 * every step, collects each failure with its reason and remedy, prints one
 * summary, exits non-zero when not ready, and writes this record; `doctor`
 * (reader) surfaces it, so an agent that opens a terminal in the container
 * later can ask dxkit why the environment is not ready instead of finding
 * the post-create log.
 *
 * ONE path constant shared by the writer (rendered into the script by the
 * devcontainer installer) and the reader, under the gitignored runtime
 * cache so it never rides a commit.
 */
import * as fs from 'fs';
import * as path from 'path';

export const DEVCONTAINER_READINESS_RECORD = '.dxkit/cache/devcontainer-readiness.json';

export interface DevcontainerReadinessFailure {
  readonly step: string;
  readonly reason: string;
  readonly remedy: string;
}

export interface DevcontainerReadiness {
  readonly ready: boolean;
  /** The dxkit version that generated the post-create script. */
  readonly generatedBy: string;
  /** The dxkit version post-create resolved and put on PATH, if any. */
  readonly dxkit: string | null;
  readonly finishedAt: string;
  readonly failures: readonly DevcontainerReadinessFailure[];
  /** True when the container was built from an older devcontainer.json (an
   *  existing install whose scripts `update` refreshed): the failures are
   *  reported as advice and post-create did not fail. */
  readonly advisory?: boolean;
}

/** The record at `cwd`, or null when no post-create wrote one (not a
 *  devcontainer, or a post-create older than 4.5.0). */
export function readDevcontainerReadiness(cwd: string): DevcontainerReadiness | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(cwd, DEVCONTAINER_READINESS_RECORD), 'utf8'),
    ) as Partial<DevcontainerReadiness> & { schema?: unknown };
    if (raw.schema !== 'dxkit.devcontainer-readiness.v1' || typeof raw.ready !== 'boolean') {
      return null;
    }
    const failures = Array.isArray(raw.failures)
      ? raw.failures.filter(
          (f): f is DevcontainerReadinessFailure =>
            typeof f === 'object' && f !== null && typeof f.step === 'string',
        )
      : [];
    return {
      ready: raw.ready && failures.length === 0,
      generatedBy: String(raw.generatedBy ?? ''),
      dxkit: typeof raw.dxkit === 'string' ? raw.dxkit : null,
      finishedAt: String(raw.finishedAt ?? ''),
      failures,
      ...(raw.advisory === true ? { advisory: true } : {}),
    };
  } catch {
    return null;
  }
}

/** One-line doctor label for a record. */
export function describeDevcontainerReadiness(r: DevcontainerReadiness): string {
  if (r.ready) return `devcontainer post-create: ready (dxkit ${r.dxkit ?? r.generatedBy})`;
  const steps = r.failures.map((f) => `${f.step}: ${f.reason}`).join('; ');
  const advice = r.advisory
    ? ' [advice only: the container was built from an older devcontainer.json; adopt the current one to make this strict]'
    : '';
  return `devcontainer post-create: NOT ready (${steps})${advice}`;
}
