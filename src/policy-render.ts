/**
 * `vyuh-dxkit policy render [--check|--apply]` — the reconciliation primitive
 * behind "policy.json is the interface" (4.3.4).
 *
 * The managed workflows are RENDERED from the committed policy; a policy edit
 * that lands without a re-render leaves the repo running yesterday's
 * schedule while the file claims today's. This command is the ONE primitive
 * every reconciliation surface calls:
 *
 *   - `--check` (CI parity gate, pre-push hook): render in memory-safe
 *     fashion — snapshot the managed artifacts, run update's OWN refresh
 *     lane, diff, RESTORE — and exit 1 with a per-file unified diff when
 *     anything drifts. The working tree is byte-identical afterwards, so it
 *     is safe on a dirty tree and inside hooks.
 *   - `--apply` (the fix, local or the opt-in render-bot workflow): run the
 *     same refresh and keep the result.
 *
 * The render path is update's `refreshManagedSurfaces` (Rule 2 — a second
 * renderer would drift from update's provenance rules); flags resolve
 * through `resolveInstallFlags`, so a policy-enabled lane renders its
 * workflow exactly as `update` would. Rendering executes NOTHING from the
 * repo: policy values reach the templates only through their strict
 * validators (the cadence grammar's cron allowlist, branch-name detection),
 * so `--check` is safe on any tree, including untrusted ones.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import * as logger from './logger';
import { dxkitCli } from './self-invocation';
import { refreshManagedSurfaces, managedGatedArtifacts } from './managed-artifacts';
import { resolveInstallFlags } from './update';
import type { Manifest } from './types';

export interface PolicyRenderOptions {
  readonly mode: 'check' | 'apply';
  readonly json?: boolean;
}

export interface PolicyRenderOutcome {
  readonly ok: boolean;
  /** True when nothing drifted (check) / nothing needed writing (apply). */
  readonly clean: boolean;
  readonly message: string;
  /** Repo-relative managed files whose rendered content differs from disk. */
  readonly drifted: readonly string[];
  /** Unified diffs per drifted file (check mode; capped for PR comments). */
  readonly diffs: readonly string[];
}

/** Max diff lines carried per file — the PR comment needs the shape of the
 *  change, not an unbounded wall (the 65,536-byte comment limit again). */
const MAX_DIFF_LINES_PER_FILE = 60;

function readOrNull(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** Best-effort unified diff via `git diff --no-index` (repo-state-free);
 *  falls back to a plain marker when git is unavailable. */
function unifiedDiff(
  cwd: string,
  rel: string,
  before: Buffer | null,
  after: Buffer | null,
): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-render-'));
  try {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.writeFileSync(a, before ?? Buffer.alloc(0));
    fs.writeFileSync(b, after ?? Buffer.alloc(0));
    try {
      execFileSync('git', ['diff', '--no-index', '--', a, b], { encoding: 'utf8' });
      return ''; // identical (git exits 0)
    } catch (err) {
      const out = (err as { stdout?: string }).stdout ?? '';
      const lines = out
        .split('\n')
        // Strip the temp-path headers; keep hunks.
        .filter((l) => !l.startsWith('diff --git') && !l.startsWith('index '))
        .map((l) =>
          l.startsWith('--- ') ? `--- ${rel}` : l.startsWith('+++ ') ? `+++ ${rel}` : l,
        );
      const capped =
        lines.length > MAX_DIFF_LINES_PER_FILE
          ? [
              ...lines.slice(0, MAX_DIFF_LINES_PER_FILE),
              `… (${lines.length - MAX_DIFF_LINES_PER_FILE} more lines)`,
            ]
          : lines;
      return capped.join('\n');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Pure-ish core (writes are snapshot-restored in check mode). Exported for
 * tests and the render-bot workflow.
 */
export function resolvePolicyRender(cwd: string, mode: 'check' | 'apply'): PolicyRenderOutcome {
  const manifestPath = path.join(cwd, '.vyuh-dxkit.json');
  if (!fs.existsSync(manifestPath)) {
    // Nothing dxkit-managed to render: a policy-only checkout is clean by
    // definition (the parity gate must pass on repos without an install).
    return {
      ok: true,
      clean: true,
      message: 'no dxkit install here (.vyuh-dxkit.json absent) — nothing to render',
      drifted: [],
      diffs: [],
    };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
  } catch {
    return {
      ok: false,
      clean: false,
      message: '.vyuh-dxkit.json is unreadable — run `' + dxkitCli('update') + '` to repair',
      drifted: [],
      diffs: [],
    };
  }

  const { flags } = resolveInstallFlags(manifest, cwd);
  // Snapshot every artifact a managed surface could touch, so check mode can
  // restore byte-for-byte (safe on a dirty tree, safe in a hook).
  const candidates = [...new Set(managedGatedArtifacts(flags))];
  const snapshot = new Map<string, Buffer | null>(
    candidates.map((rel) => [rel, readOrNull(path.join(cwd, rel))]),
  );

  // A hand-modified managed file makes the refresh emit a SIDECAR rather than
  // overwrite (update's provenance rule) — that is deliberate user divergence,
  // not drift, so the canonical file compares equal and the gate passes. The
  // sidecars written during a CHECK are cleaned up below (they are
  // regenerable dxkit output; the check must leave the tree as it found it).
  const sidecarsWritten: string[] = [];
  refreshManagedSurfaces(cwd, { force: false, flags }, (r) => {
    sidecarsWritten.push(...r.sidecars);
  });

  const drifted: string[] = [];
  const diffs: string[] = [];
  for (const rel of candidates) {
    const before = snapshot.get(rel) ?? null;
    const after = readOrNull(path.join(cwd, rel));
    const same =
      (before === null && after === null) ||
      (before !== null && after !== null && before.equals(after));
    if (same) continue;
    drifted.push(rel);
    if (mode === 'check') diffs.push(unifiedDiff(cwd, rel, before, after));
  }

  if (mode === 'check') {
    // Restore: the check must leave the tree untouched, drift or not.
    for (const rel of drifted) {
      const before = snapshot.get(rel) ?? null;
      const abs = path.join(cwd, rel);
      if (before === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, before);
    }
    for (const rel of new Set(sidecarsWritten)) {
      fs.rmSync(path.join(cwd, rel), { force: true, recursive: true });
    }
  }

  if (drifted.length === 0) {
    return {
      ok: true,
      clean: true,
      message:
        mode === 'check'
          ? 'managed files match the policy — nothing drifts'
          : 'managed files already match the policy — nothing written',
      drifted: [],
      diffs: [],
    };
  }
  return {
    ok: mode === 'apply',
    clean: false,
    message:
      mode === 'check'
        ? `${drifted.length} managed file(s) drift from .dxkit/policy.json — ` +
          `run \`${dxkitCli('policy render --apply')}\` (or \`${dxkitCli('update')}\`) and commit the result`
        : `re-rendered ${drifted.length} managed file(s) from the policy`,
    drifted,
    diffs,
  };
}

export function runPolicyRender(cwd: string, opts: PolicyRenderOptions): void {
  const out = resolvePolicyRender(cwd, opts.mode);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { clean: out.clean, drifted: out.drifted, message: out.message, diffs: out.diffs },
        null,
        2,
      ) + '\n',
    );
  } else {
    (out.ok ? (out.clean ? logger.success : logger.success) : logger.fail)(out.message);
    for (const rel of out.drifted) logger.info(`  ${rel}`);
    for (const d of out.diffs) if (d) process.stdout.write(d + '\n');
  }
  if (!out.ok) process.exitCode = 1;
}
