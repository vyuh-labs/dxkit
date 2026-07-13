/**
 * Per-step progress + timing for the analyzer pipeline (F-UX-2).
 *
 * Pre-2.4.7, `timed` / `timedAsync` only emitted output under
 * `--verbose` — and only AFTER the step completed. Real users
 * running `health` on a 1.8GB-node_modules repo (Friction #20) sat
 * for tens of minutes staring at a static banner with no indication
 * whether dxkit was working or hung.
 *
 * Post-F-UX-2, the start of every step always prints a `→ <name>`
 * line to stderr — including in non-verbose mode — so the user can
 * see exactly which step is running. The elapsed time still only
 * prints under `--verbose`. Stdout stays clean so `--json` is
 * unaffected.
 *
 * Scope note: this is the per-top-level-step minimal version from
 * the friction tracker. Fuller streaming inside long capabilities
 * (e.g. semgrep across 8 rulesets, OSV.dev lookups across N
 * advisories) can land in 2.4.8.
 */

import * as logger from '../../logger';

function startLine(name: string): void {
  // Honor a surface that has muted ordinary output (e.g. the init finishing
  // arc, which reuses the scan pipeline but drives its own step UI) — otherwise
  // these per-phase lines bleed through it.
  if (logger.isQuiet()) return;
  // Indent to match the rest of the CLI's stderr framing (logger.info
  // uses the same "  → " prefix). Stays on stderr in all modes so it
  // never pollutes `--json` stdout.
  process.stderr.write(`  → ${name}\n`);
}

function timingLine(name: string, start: number): void {
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  process.stderr.write(`    [${elapsed}s] ${name}\n`);
}

export function timed<T>(name: string, verbose: boolean, fn: () => T): T {
  startLine(name);
  const start = Date.now();
  const result = fn();
  if (verbose) timingLine(name, start);
  return result;
}

export async function timedAsync<T>(
  name: string,
  verbose: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  startLine(name);
  const start = Date.now();
  const result = await fn();
  if (verbose) timingLine(name, start);
  return result;
}
