/**
 * Persisted deep-SAST configuration, read from `.vyuh-dxkit.json`.
 *
 * So a customer configures the engine + Snyk project ONCE (committed,
 * non-secret — the token never lives here) instead of repeating
 * `--org`/`--project` on every `ingest`. CLI flags always override
 * config; config overrides nothing it doesn't set.
 *
 * Shape (all optional):
 *   {
 *     "deepSast": {
 *       "engine": "snyk-code" | "codeql",
 *       "snyk": { "orgId": "...", "projectId": "..." }
 *     }
 *   }
 *
 * Fail-open: a missing or malformed manifest yields an empty config —
 * ingestion must never break on a config-read error.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DeepSastConfig {
  engine?: 'snyk-code' | 'codeql';
  snyk?: { orgId?: string; projectId?: string };
}

/** Read `.vyuh-dxkit.json:deepSast`, or `{}` when absent/unreadable. */
export function readDeepSastConfig(cwd: string): DeepSastConfig {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.vyuh-dxkit.json'), 'utf-8');
    const manifest = JSON.parse(raw) as { deepSast?: DeepSastConfig };
    return manifest.deepSast ?? {};
  } catch {
    return {};
  }
}
