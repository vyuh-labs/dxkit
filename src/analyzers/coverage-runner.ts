/**
 * Run `test-with-coverage` across every active language pack and
 * collect the outcome rows. Single source of truth shared by:
 *   - `vyuh-dxkit coverage` command  (cli.ts)
 *   - `vyuh-dxkit health --with-coverage` (D021 sub-piece 2)
 *   - `vyuh-dxkit test-gaps --with-coverage`  (D021 sub-piece 2)
 *   - `vyuh-dxkit report` orchestrator  (D021 sub-piece 3)
 *
 * The function is provider-driven — each pack's
 * `LanguagePackCapabilities.coverage.runTests` produces the artifact
 * its parser reads back later via `loadCoverage()`. Pre-D021 the
 * orchestration lived inline in cli.ts; extracting it here lets
 * `--with-coverage` reuse the exact flow without duplicating the
 * per-pack iteration / fail-fast / row-shape logic.
 */
import type { LanguageSupport } from '../languages/types';
import { detectActiveLanguages } from '../languages';

export type CoverageRunStatus = 'success' | 'unavailable' | 'failed' | 'skipped';

export interface CoverageRunRow {
  pack: string;
  status: CoverageRunStatus;
  durationMs: number;
  artifact: string | null;
  reason: string | null;
}

export interface CoverageRunOptions {
  /** Restrict to one pack id (matches `vyuh-dxkit coverage --lang <id>`). */
  langFilter?: string;
  /** Stop at the first `failed` row when true (mirrors the CLI default). */
  failFast?: boolean;
  /**
   * Streaming progress hook. Called once with `start` before each pack
   * runs and once with `done` after, regardless of outcome. CLI hosts
   * use this to print `→ <pack>: running tests with coverage...` lines
   * incrementally — the function itself stays silent.
   */
  onPackStart?: (packId: string) => void;
  onPackEnd?: (row: CoverageRunRow) => void;
}

export interface CoverageRunResult {
  rows: CoverageRunRow[];
  /** Packs that detect-active matched but failed the `langFilter` gate. */
  activePacks: LanguageSupport[];
}

/**
 * Iterate active packs and invoke each one's
 * `capabilities.coverage.runTests`, returning per-pack outcome rows.
 * Packs without a `runTests` implementation surface as `'skipped'` so
 * the caller can still render the full active-pack matrix.
 *
 * Fail-fast semantics match the legacy `coverage` command: a
 * `failed` outcome stops the iteration (caller handles exit code).
 * `unavailable` and `skipped` keep the loop running because they mean
 * "no artifact this run" rather than "the test run blew up."
 */
export async function runCoverageAcrossPacks(
  cwd: string,
  opts: CoverageRunOptions = {},
): Promise<CoverageRunResult> {
  const failFast = opts.failFast ?? true;
  const active = detectActiveLanguages(cwd);
  const candidates = active.filter((p) => !opts.langFilter || p.id === opts.langFilter);
  const rows: CoverageRunRow[] = [];

  for (const pack of candidates) {
    const provider = pack.capabilities?.coverage;
    if (!provider?.runTests) {
      const row: CoverageRunRow = {
        pack: pack.id,
        status: 'skipped',
        durationMs: 0,
        artifact: null,
        reason: 'no runTests() implementation yet (pack coverage capability is read-only)',
      };
      rows.push(row);
      opts.onPackEnd?.(row);
      continue;
    }
    opts.onPackStart?.(pack.id);
    const outcome = await provider.runTests(cwd);
    let row: CoverageRunRow;
    if (outcome.kind === 'success') {
      row = {
        pack: pack.id,
        status: 'success',
        durationMs: outcome.durationMs,
        artifact: outcome.artifact,
        reason: null,
      };
    } else if (outcome.kind === 'unavailable') {
      row = {
        pack: pack.id,
        status: 'unavailable',
        durationMs: 0,
        artifact: null,
        reason: outcome.reason,
      };
    } else {
      row = {
        pack: pack.id,
        status: 'failed',
        durationMs: outcome.durationMs,
        artifact: null,
        reason: outcome.reason,
      };
    }
    rows.push(row);
    opts.onPackEnd?.(row);
    if (row.status === 'failed' && failFast) break;
  }

  return { rows, activePacks: active };
}
