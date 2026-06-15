/**
 * AnalysisResult cache — the cross-process persistence layer for the
 * canonical analysis envelope.
 *
 * Two layers of caching:
 *
 *   1. **In-memory** (`Map<cacheKey, Promise<AnalysisResult>>`).
 *      Dedupes concurrent calls within one process. Survives across
 *      subcommands that share a Node process; cleared on process exit.
 *
 *   2. **On-disk JSON** under `<cwd>/.dxkit/cache/`. Persists across
 *      processes so a second subcommand minutes later can skip the
 *      gather entirely. Keyed by short commit SHA.
 *
 * Invalidation triggers (any one forces a rebuild + overwrites the
 * cached file):
 *
 *   - Commit SHA differs from the cached file's `commitSha`.
 *   - `.dxkit-ignore` mtime differs (changes affect what gets scanned).
 *   - Cached file's `dxkitVersion` differs from the running version
 *     (new tools or scoring formulas can change metrics).
 *   - Cached file's `schemaVersion` differs from
 *     `ANALYSIS_RESULT_SCHEMA_VERSION` (incompatible envelope shape).
 *   - Caller passes `rescan: true`.
 *
 * Dirty-tree behavior:
 *
 *   Working-tree-dirty results are NEVER persisted to disk and are
 *   NOT read back from disk. The commit SHA doesn't reflect the on-
 *   disk state, so a disk cache keyed by SHA would alias two genuinely-
 *   different states. In-memory caching still applies, so multiple
 *   subcommands within one process share the rebuild without thrashing.
 *
 * The cache module never invokes a gather itself. Callers supply a
 * `build` function returning `AnalysisResultBody`; the module stamps
 * provenance and handles persistence. This keeps the gather pipeline
 * decoupled from the cache layer and makes both unit-testable in
 * isolation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import {
  ANALYSIS_RESULT_SCHEMA_VERSION,
  type AnalysisResult,
  type AnalysisResultBody,
} from '../analysis-result';
import { VERSION as DXKIT_VERSION } from '../constants';

const IGNORE_FILE = '.dxkit-ignore';
const CACHE_SUBDIR = path.join('.dxkit', 'cache');

// `.dxkit/`-resident analysis INPUTS that the working-tree-dirty check
// cannot observe — `isWorkingTreeDirty` excludes the entire `.dxkit/`
// prefix so dxkit's own OUTPUT writes (reports, this cache, dashboard,
// salt) never make a run look dirty. These inputs live under that same
// excluded prefix, so a change to any of them would otherwise be served
// stale until the commit SHA changed. They are folded into the cache key
// via a content digest instead. (`.dxkit-ignore` is handled separately by
// `ignoreFileMtime` — it does NOT live under the excluded prefix.)
// These reference the input files only to content-hash their raw bytes for
// cache invalidation — not to read/parse their data — so they bypass the
// canonical loaders (no schema validation or sidecar merge is wanted here).
const ALLOWLIST_FILE = path.join('.dxkit', 'allowlist.json'); // allowlist-io-ok
const POLICY_FILE = path.join('.dxkit', 'policy.json');
const EXTERNAL_SUBDIR = path.join('.dxkit', 'external'); // ingest-snapshot-ok

/**
 * Provenance fields the cache resolves before deciding hit vs miss.
 * Separate from `AnalysisResult` so the cache can compute it without
 * a build, then compare against the cached file's persisted shape.
 */
export interface ResolvedProvenance {
  commitSha: string;
  branch: string;
  cwd: string;
  dxkitVersion: string;
  ignoreFileMtime: number | null;
  inputsDigest: string | null;
  workingTreeDirty: boolean;
}

/**
 * Builder contract. The cache calls this when it needs to (re)build
 * the body. Implementations live alongside the consumers that
 * orchestrate the gather pipeline (`analyzeHealthInternal` and
 * friends).
 */
export type AnalysisResultBuilder = (cwd: string) => Promise<AnalysisResultBody>;

export interface ReadOrBuildOptions {
  /** Force a rebuild even on cache hit. Mirrors the CLI `--rescan` flag. */
  rescan?: boolean;

  /** Override cache directory location. Defaults to `<cwd>/.dxkit/cache`.
   *  Tests use this to isolate cache state in a tmpdir; production
   *  callers should never set it. */
  cacheDir?: string;

  /** Override the provenance resolver. Tests use this to inject SHA /
   *  dirty-flag without spawning git. Production callers should never
   *  set it. */
  resolveProvenance?: (cwd: string) => ResolvedProvenance;

  /** Override the wall-clock used for `builtAt`. Tests use this to
   *  produce deterministic timestamps. Defaults to `new Date()`. */
  now?: () => Date;
}

// In-memory dedup across subcommands sharing a process. Keyed by the
// resolved provenance so a SHA change inside one process (rare but
// possible — e.g. a long-running daemon) correctly misses.
const inMemoryCache = new Map<string, Promise<AnalysisResult>>();

/**
 * Resolve provenance fields needed to compute the cache key. Reads
 * git state via `git rev-parse` + `git status --porcelain`,
 * `.dxkit-ignore` mtime via `fs.statSync`, and pulls dxkit version
 * from the package constant.
 */
export function resolveProvenance(cwd: string): ResolvedProvenance {
  return {
    commitSha: gitRevParse(cwd, '--short', 'HEAD'),
    branch: gitRevParse(cwd, '--abbrev-ref', 'HEAD'),
    cwd: path.resolve(cwd),
    dxkitVersion: DXKIT_VERSION,
    ignoreFileMtime: readIgnoreFileMtime(cwd),
    inputsDigest: computeInputsDigest(cwd),
    workingTreeDirty: isWorkingTreeDirty(cwd),
  };
}

/**
 * Main entry. Returns a cached `AnalysisResult` when the cache key
 * still matches, or rebuilds via `build` and persists. Dirty trees
 * bypass disk persistence; the in-memory layer still applies.
 */
export async function readOrBuildAnalysisResult(args: {
  cwd: string;
  build: AnalysisResultBuilder;
  opts?: ReadOrBuildOptions;
}): Promise<AnalysisResult> {
  const { cwd, build } = args;
  const opts = args.opts ?? {};
  const provenance = (opts.resolveProvenance ?? resolveProvenance)(cwd);
  const cacheDir = opts.cacheDir ?? path.join(provenance.cwd, CACHE_SUBDIR);
  const cacheKey = buildCacheKey(provenance);

  // In-memory short-circuit. Same provenance, same process: one rebuild.
  if (!opts.rescan) {
    const cached = inMemoryCache.get(cacheKey);
    if (cached) return cached;
  }

  const promise = (async () => {
    // Disk read — only when the tree is clean (otherwise the cached SHA
    // doesn't represent the gathered state) and the caller didn't ask
    // for a forced rebuild.
    if (!opts.rescan && !provenance.workingTreeDirty) {
      const fromDisk = readDiskCache(cacheDir, provenance);
      if (fromDisk) return fromDisk;
    }

    // Build, stamp provenance, persist (when clean).
    const body = await build(cwd);
    const now = (opts.now ?? (() => new Date()))();
    const result: AnalysisResult = {
      ...body,
      commitSha: provenance.commitSha,
      branch: provenance.branch,
      cwd: provenance.cwd,
      builtAt: now.toISOString(),
      dxkitVersion: provenance.dxkitVersion,
      schemaVersion: ANALYSIS_RESULT_SCHEMA_VERSION,
      ignoreFileMtime: provenance.ignoreFileMtime,
      inputsDigest: provenance.inputsDigest,
      workingTreeDirty: provenance.workingTreeDirty,
    };
    if (!provenance.workingTreeDirty) {
      writeDiskCache(cacheDir, result);
    }
    return result;
  })();

  inMemoryCache.set(cacheKey, promise);
  // Drop the in-memory entry if the build itself threw — keep the cache
  // honest, don't poison subsequent calls with a rejected Promise.
  promise.catch(() => inMemoryCache.delete(cacheKey));
  return promise;
}

/** Test seam — drop in-memory dedup state between test cases. */
export function clearInMemoryCache(): void {
  inMemoryCache.clear();
}

// ─── Internals ────────────────────────────────────────────────────────────

function buildCacheKey(p: ResolvedProvenance): string {
  // Including dirty-flag means a dirty rebuild doesn't get reused as a
  // clean-tree hit after the user stashes/commits without restarting
  // the process. Including version + schema keeps long-running daemons
  // honest across an in-place dxkit upgrade.
  return [
    p.cwd,
    p.commitSha || 'no-sha',
    p.workingTreeDirty ? 'dirty' : 'clean',
    p.dxkitVersion,
    String(ANALYSIS_RESULT_SCHEMA_VERSION),
    p.ignoreFileMtime ?? 'no-ignore',
    p.inputsDigest ?? 'no-inputs',
  ].join('::');
}

function cacheFilePath(cacheDir: string, commitSha: string): string {
  const sha = commitSha || 'no-sha';
  return path.join(cacheDir, `analysis-result-${sha}.json`);
}

function readDiskCache(cacheDir: string, expected: ResolvedProvenance): AnalysisResult | null {
  const file = cacheFilePath(cacheDir, expected.commitSha);
  if (!fs.existsSync(file)) return null;
  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisResult;
  } catch {
    // Corrupt cache file — drop it and force a rebuild rather than
    // crashing the caller. Defensive: a partial write or manual edit
    // shouldn't break dxkit.
    safeUnlink(file);
    return null;
  }
  if (!isCacheStillValid(parsed, expected)) {
    safeUnlink(file);
    return null;
  }
  return parsed;
}

function isCacheStillValid(cached: AnalysisResult, expected: ResolvedProvenance): boolean {
  if (cached.schemaVersion !== ANALYSIS_RESULT_SCHEMA_VERSION) return false;
  if (cached.dxkitVersion !== expected.dxkitVersion) return false;
  if (cached.commitSha !== expected.commitSha) return false;
  if (cached.ignoreFileMtime !== expected.ignoreFileMtime) return false;
  // Allowlist / policy / external-snapshot edits live under the
  // dirty-check's excluded `.dxkit/` prefix, so the digest is the only
  // signal that they changed. A pre-digest cache file (field absent →
  // undefined) never matches a computed digest, so it invalidates once.
  if ((cached.inputsDigest ?? null) !== expected.inputsDigest) return false;
  // A persisted result is always clean (we don't write dirty ones).
  // Defensive: refuse to honor any persisted record claiming dirty.
  if (cached.workingTreeDirty) return false;
  return true;
}

function writeDiskCache(cacheDir: string, result: AnalysisResult): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = cacheFilePath(cacheDir, result.commitSha);
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf-8');
  } catch {
    // Persistence failure is non-fatal — the caller already has a
    // valid in-memory result. Logging is deferred to a future
    // observability pass; silent failure here matches the broader
    // "cache is best-effort" posture.
  }
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* file already gone — fine */
  }
}

function gitRevParse(cwd: string, ...args: string[]): string {
  try {
    return execSync(`git rev-parse ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

function isWorkingTreeDirty(cwd: string): boolean {
  try {
    // `--untracked-files=all` expands every untracked file to its own
    // line. The default behavior collapses an untracked directory to
    // a single entry for its parent — which would hide a nested
    // `.dxkit/` under a non-dxkit collapsed parent and leak it past
    // the segment filter below. `=all` is also resilient to git's
    // future grouping rules.
    const out = execSync('git status --porcelain --untracked-files=all', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    // `.dxkit/` (analysis reports + this cache file + dashboard
    // renders) and `.dxkit-ignore` (dxkit's own config file) are
    // dxkit-owned paths. Untracked entries for either — at ANY depth
    // in the tree — can't invalidate the cache the cache itself
    // populates. Customer repos that haven't added `.dxkit/` to their
    // `.gitignore` would otherwise always look dirty and the cache
    // would never persist across processes. Nested cases matter too:
    // a monorepo may have analysis state at `Code/Source/.dxkit/`
    // alongside the root `.dxkit/`, and both should be filtered.
    //
    // Narrow exclusion — anything else under the tree (new source
    // files, build artifacts, editor state) still flags dirty
    // because it CAN change gather output. We match exact path
    // segments to avoid masking unrelated names that merely contain
    // the substring (e.g. a hypothetical `my.dxkit.json` file would
    // not match the `.dxkit` segment check).
    const lines = out.split('\n').filter((line) => {
      if (!line.trim()) return false;
      const m = /^\?\? (.+)$/.exec(line);
      if (!m) return true;
      const segments = stripTrailingSlash(m[1]).split('/');
      // `.dxkit/external/` holds ingested external-engine findings
      // (Snyk Code, CodeQL). Unlike dxkit's self-populated outputs
      // (cache/, reports/, dashboard/), these are a gather INPUT — they
      // add findings to the aggregate — so a new/changed snapshot MUST
      // invalidate the cache. Without this, `ingest` followed by
      // `vulnerabilities` / `health` / `baseline` silently reuses a
      // pre-ingest cache and the ingested findings never surface.
      // Handles nesting (a monorepo's `Code/.dxkit/external/`).
      const isExternalSnapshot = segments.some(
        (seg, i) => seg === '.dxkit' && segments[i + 1] === 'external',
      );
      if (isExternalSnapshot) return true;
      return !segments.some((seg) => seg === '.dxkit' || seg === '.dxkit-ignore');
    });
    return lines.length > 0;
  } catch {
    // Not in a git repo (or git missing) — treat as dirty so we never
    // persist a result we can't invalidate by SHA. Same posture as the
    // dirty-tree path: in-memory cache still applies.
    return true;
  }
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

function readIgnoreFileMtime(cwd: string): number | null {
  try {
    const stat = fs.statSync(path.join(cwd, IGNORE_FILE));
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Content digest over the `.dxkit/`-resident analysis inputs the
 * dirty-check can't see (allowlist, policy, external snapshots). Content
 * hash rather than mtime — mtime is unreliable across `git checkout` /
 * `git stash`, which rewrite files to identical content with a fresh
 * timestamp. Returns `null` when none of the inputs exist so a repo that
 * has never allowlisted anything keys identically before and after the
 * feature ships. Best-effort: an unreadable file contributes nothing
 * rather than throwing (the cache stays a performance optimization, never
 * a correctness dependency).
 */
function computeInputsDigest(cwd: string): string | null {
  // SHA-1 of (relpath, content) pairs; NOT a finding identity — this is a
  // cache-input fingerprint, exempt from the Rule 9 createHash ban.
  const h = createHash('sha1'); // fingerprint-helper-ok
  let any = false;
  const feed = (rel: string): void => {
    try {
      const buf = fs.readFileSync(path.join(cwd, rel));
      h.update(rel);
      h.update('\0');
      h.update(buf);
      h.update('\0');
      any = true;
    } catch {
      /* absent / unreadable — contributes nothing */
    }
  };
  feed(ALLOWLIST_FILE);
  feed(POLICY_FILE);
  // External-engine snapshots, sorted for a stable digest regardless of
  // readdir order.
  try {
    const names = fs.readdirSync(path.join(cwd, EXTERNAL_SUBDIR)).sort();
    for (const name of names) {
      if (name.endsWith('.json')) feed(path.join(EXTERNAL_SUBDIR, name));
    }
  } catch {
    /* no external dir */
  }
  return any ? h.digest('hex') : null;
}
