/** Shared helpers for the dxkit benchmark pipeline. */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// This file lives at <repo-root>/benchmarks/lib.mjs.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCAL_DIST = path.join(REPO_ROOT, 'dist/index.js');
// Prefer a locally-built dxkit (fast, and exercises the current source). If the
// repo is not built, fall back to the published CLI. Override with the DXKIT env
// var, e.g. DXKIT="npx --yes @vyuhlabs/dxkit" or DXKIT="node /path/to/dist/index.js".
export const DXKIT =
  process.env.DXKIT || (fs.existsSync(LOCAL_DIST) ? `node ${LOCAL_DIST}` : 'npx --yes @vyuhlabs/dxkit');

// 10 min: a full baseline create / guardrail check runs osv over every
// dependency (network-variable on 150+ deps), and the wall-clock timer keeps
// counting if the machine suspends mid-command - 3 min was too tight and tripped
// ETIMEDOUT overnight.
export function sh(cmd, cwd, timeout = 600000) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
}

/** Run a command, return its exit code (0 = ok) without throwing. */
export function exitCode(cmd, cwd, timeout = 600000) {
  try {
    execSync(cmd, { cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

/** Reset the target to a pinned commit but PRESERVE `.dxkit/` (the baseline
 *  lives there, gitignored - a plain `git clean` would wipe it). */
export function resetTo(repoDir, commit) {
  sh(`git checkout -- . 2>/dev/null || true`, repoDir);
  sh(`git reset --hard ${commit} 2>/dev/null`, repoDir);
  sh(`git clean -fdq -e .dxkit 2>/dev/null || true`, repoDir);
}

// The benchmark deliberately uses committed-full mode. dxkit auto-selects
// ref-based mode on PUBLIC repos (NodeGoat is public), which writes NO baseline
// file and re-gathers the "prior" side from origin/master on demand - defeating
// the save/restore-a-frozen-baseline design and making every pre-existing
// finding read as net-new. Forcing the mode keeps the prior side a fixed file
// at the pinned commit.
export const BENCH_MODE = 'committed-full';

/** Create the committed baseline AND pre-flight assert it captured the repo's
 *  pre-existing debt. The exact bug this guards against (ref-based on a public
 *  repo) manifests as a MISSING baseline file → caught by the existence check;
 *  a sparse/empty file is caught by the entry check. Returns a kind breakdown
 *  so the caller can show the human that grandfathering is real. */
export function createBaseline(repoDir) {
  sh(`${DXKIT} baseline create --force --mode ${BENCH_MODE}`, repoDir);
  const file = path.join(repoDir, '.dxkit/baselines/main.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `baseline pre-flight FAILED: no committed baseline written at ${file}. ` +
        `dxkit likely auto-selected ref-based mode (public repo) despite ` +
        `--mode ${BENCH_MODE}; every prior finding would read as net-new.`,
    );
  }
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = b.entries || b.findings || [];
  if (entries.length === 0) {
    throw new Error(`baseline pre-flight FAILED: ${file} has 0 entries.`);
  }
  const byKind = {};
  for (const e of entries) {
    const k = e.kind || e.type || '?';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  return { total: entries.length, byKind };
}

/** Guardrail check at the frozen committed baseline (mode-locked). */
export function guardrailExitCode(repoDir) {
  return exitCode(`${DXKIT} guardrail check --mode ${BENCH_MODE}`, repoDir);
}

export function saveBaseline(repoDir, to) {
  const src = path.join(repoDir, '.dxkit/baselines/main.json');
  if (fs.existsSync(src)) fs.copyFileSync(src, to);
}
export function restoreBaseline(repoDir, from) {
  if (!fs.existsSync(from)) return;
  const dstDir = path.join(repoDir, '.dxkit/baselines');
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(from, path.join(dstDir, 'main.json'));
}

export function readJson(p, dflt = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
}
export function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

/** Count current code+secret findings via a vulnerabilities scan (used to
 *  detect "did this change introduce a new finding"). */
export function scanFindingCount(repoDir) {
  try {
    const out = sh(`${DXKIT} vulnerabilities --json 2>/dev/null`, repoDir);
    const json = JSON.parse(out);
    let n = 0;
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x.fingerprint === 'string' && typeof x.file === 'string') n++;
      for (const v of Object.values(x)) walk(v);
    })(json);
    return n;
  } catch {
    return -1;
  }
}
