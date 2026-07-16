/**
 * Persisted ingestion snapshots under `.dxkit/external/`.
 *
 * `vyuh-dxkit ingest` writes one snapshot file per engine
 * (`.dxkit/external/<engine>.json`). The snapshot is committed to the
 * repo so every developer and every CI run reads the ingested findings
 * WITHOUT needing the engine's token — only the one CI refresh job that
 * produced it needs `SNYK_TOKEN` (or a CodeQL license). This is what
 * makes "an admin adds the token once and everyone benefits" true.
 *
 * The snapshot is the normalized `ExternalFinding[]` plus light
 * metadata for provenance/diagnostics. It deliberately carries no
 * engine-token or account identifier — only finding data — so it is
 * safe to commit.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SourceEngine, ExternalFinding } from './types';

/** Directory (relative to repo root) where ingestion snapshots live. */
export const EXTERNAL_DIR = path.join('.dxkit', 'external');

export interface ExternalSnapshot {
  schemaVersion: 1;
  engine: SourceEngine;
  /** ISO timestamp the snapshot was produced. Stamped by the caller so
   *  this module stays free of clock access (testability). */
  generatedAt: string;
  /** Commit the snapshot was produced against, when known. */
  commitSha?: string;
  findings: ExternalFinding[];
}

/** Absolute path to an engine's snapshot file. */
function snapshotPath(cwd: string, engine: string): string {
  return path.join(cwd, EXTERNAL_DIR, `${engine}.json`);
}

/**
 * Read one engine's snapshot. Fail-open: missing, unreadable, or
 * malformed → null. Consumers: the ingest CLI's graceful-degradation
 * path ("does a prior snapshot exist to fall back to?") and doctor's
 * staleness check (accepts the string engine names `snapshotEngines`
 * lists from disk, hence the wider param type).
 */
export function readSnapshot(cwd: string, engine: string): ExternalSnapshot | null {
  try {
    const raw = fs.readFileSync(snapshotPath(cwd, engine), 'utf-8');
    const snap = JSON.parse(raw) as ExternalSnapshot;
    if (!Array.isArray(snap.findings) || typeof snap.generatedAt !== 'string') return null;
    return snap;
  } catch {
    return null;
  }
}

/** Write (overwrite) an engine's snapshot. Creates `.dxkit/external/`
 *  if needed. */
export function writeSnapshot(cwd: string, snapshot: ExternalSnapshot): string {
  const dir = path.join(cwd, EXTERNAL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = snapshotPath(cwd, snapshot.engine);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  return file;
}

/**
 * Read every snapshot under `.dxkit/external/` and return the union of
 * their findings. Fail-open: a missing directory, an unreadable file,
 * or a malformed snapshot yields no findings from that file rather than
 * throwing — ingestion is optional and must never break a scan.
 */
export function readAllSnapshots(cwd: string): ExternalFinding[] {
  const dir = path.join(cwd, EXTERNAL_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ExternalFinding[] = [];
  for (const name of entries) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
      const snap = JSON.parse(raw) as ExternalSnapshot;
      if (Array.isArray(snap.findings)) out.push(...snap.findings);
    } catch {
      // skip unreadable / malformed snapshot
    }
  }
  return out;
}

/** Distinct engines present in `.dxkit/external/` (for provenance). */
export function snapshotEngines(cwd: string): string[] {
  const dir = path.join(cwd, EXTERNAL_DIR);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
