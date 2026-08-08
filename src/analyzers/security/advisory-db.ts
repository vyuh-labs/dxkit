/**
 * The offline advisory snapshot (4.4.0 P1-4) — ONE home for what a
 * `--advisory-db` value means.
 *
 * Air-gapped deployments cannot query OSV.dev (or any registry) at gate
 * time. They ship a pre-downloaded osv-scanner vulnerability database
 * through their own versioned reference-data channel and point the gate
 * at it. Two consequences the rest of the machine enforces:
 *
 *   - the snapshot VERSION is a Rule 19 RECALL INPUT (a newer snapshot
 *     sees more advisories — blaming that delta on a developer is the
 *     exact misattribution Rule 19 exists to kill) and is named in the
 *     verdict;
 *   - an ABSENT or unusable snapshot makes the dep-vuln check a
 *     disclosed SKIP with cause, never a silent pass and never a
 *     fallback to the network (falling back would silently break the
 *     air-gap guarantee the flag exists to give).
 */

import * as fs from 'fs';
import * as path from 'path';

/** A resolved advisory snapshot. */
export interface AdvisoryDbSpec {
  /** Absolute directory osv-scanner reads as its local DB cache. */
  readonly dir: string;
  /** Snapshot version — the recall input + the verdict's name for the
   *  feed state. From the `path@version` suffix, else the snapshot's
   *  `VERSION` file, else `'unversioned'` (still disclosed; drift then
   *  cannot distinguish snapshot updates — the channel should version). */
  readonly version: string;
}

/** Why a supplied advisory-db value is unusable (disclosed cause). */
export interface AdvisoryDbError {
  readonly error: string;
}

/**
 * Parse `--advisory-db <path>` / `<path>@<version>`. The `@version`
 * split applies only when the prefix is an existing directory, so a
 * path that legitimately contains `@` (scoped registries, home dirs)
 * still resolves whole.
 */
export function resolveAdvisoryDb(raw: string, cwd: string): AdvisoryDbSpec | AdvisoryDbError {
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const dir = abs(raw.slice(0, at));
    const version = raw.slice(at + 1).trim();
    if (version.length > 0 && isDir(dir)) {
      return { dir, version };
    }
  }
  const dir = abs(raw);
  if (!isDir(dir)) {
    return {
      error:
        `advisory snapshot not found: ${dir} is not a directory. The dep-vuln check is ` +
        `SKIPPED (never silently run against the network in snapshot mode).`,
    };
  }
  const versionFile = ['VERSION', 'version.txt']
    .map((f) => path.join(dir, f))
    .find((f) => fs.existsSync(f));
  const version = versionFile ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  return { dir, version: version.length > 0 ? version : 'unversioned' };
}

export function isAdvisoryDbError(v: AdvisoryDbSpec | AdvisoryDbError): v is AdvisoryDbError {
  return 'error' in v;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
