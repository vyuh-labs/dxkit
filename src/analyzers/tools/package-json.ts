/**
 * `package.json`-derived metrics — the two TypeScript-only signals that
 * don't fit the capability model (every capability is language-agnostic
 * by design; npm scripts and Node engine pins are Node-specific by
 * definition).
 *
 * Phase 10e.C.5 extracted these from `typescript.ts:gatherMetrics` when
 * the legacy Layer 1 channel was retired. The helper replaces the prior
 * `node -e "require('./package.json')..."` subprocess pair with a single
 * `fs.readFileSync` + `JSON.parse`.
 *
 * Absent or unparseable `package.json` returns the zero / null pair —
 * the scoring dimensions treat that as "no scripts" / "no engine pinned"
 * rather than as a distinct missing-data state.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PackageJsonMetrics {
  npmScriptsCount: number;
  nodeEngineVersion: string | null;
}

export function gatherPackageJsonMetrics(cwd: string): PackageJsonMetrics {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, unknown>;
      engines?: { node?: string };
    };
    return {
      npmScriptsCount: pkg.scripts ? Object.keys(pkg.scripts).length : 0,
      nodeEngineVersion: pkg.engines?.node ?? null,
    };
  } catch {
    return { npmScriptsCount: 0, nodeEngineVersion: null };
  }
}
