// Renderer-side prose split for the `toolsUnavailable` list.
//
// `pushUnavailable` (in health.ts) builds entries shaped `<tool>
// (<reason>)`, where `<reason>` comes from the provider's outcome
// channel — `not installed` / `timed out at <N>s` / `exit code N
// (stderr: ...)` / `no output (stderr: ...)` / `no output` /
// `parse error` / etc. The reason text is honest; the historical
// renderer header "Tools unavailable" wasn't — a reader reasonably
// concluded the tool needed installing, when in fact it was attempted
// and failed at runtime.
//
// This module categorizes entries by reading the suffix and routes
// them to two honest headers:
//
//   - "Tools not installed"         → reason `(not installed)`
//                                      → user action: `tools install`
//   - "Tools that failed at runtime" → any other reason
//                                      → user action: investigate the run
//                                        (e.g. narrow scan scope, raise
//                                        memory, check stderr first line)
//
// Every renderer prose surface that previously printed
// `**Tools unavailable:** <flat list>` now calls
// `renderToolsUnavailableLines` so the prose split is applied
// uniformly across cli, tests, security, quality, bom, health/detailed.
// The xlsx BoM emits two worksheet rows via `splitToolsUnavailable`
// for the same effect.

export interface ToolsUnavailableSplit {
  notInstalled: string[];
  failedAtRuntime: string[];
}

/**
 * Split a flat `toolsUnavailable` list into the two honesty categories.
 * Entries shaped `<tool> (not installed)` route to `notInstalled` with
 * the suffix stripped; everything else (including bare tool names with
 * no `(<reason>)` suffix at all) routes to `failedAtRuntime` unchanged.
 */
export function splitToolsUnavailable(entries: string[]): ToolsUnavailableSplit {
  const notInstalled: string[] = [];
  const failedAtRuntime: string[] = [];
  for (const entry of entries) {
    if (/ \(not installed\)\s*$/.test(entry)) {
      notInstalled.push(entry.replace(/ \(not installed\)\s*$/, ''));
    } else {
      failedAtRuntime.push(entry);
    }
  }
  return { notInstalled, failedAtRuntime };
}

/**
 * Render the two honest header lines for markdown renderers. Returns
 * an empty array when both categories are empty (so callers can spread
 * the result into a `lines.push(...)` without an explicit length guard).
 */
export function renderToolsUnavailableLines(entries: string[]): string[] {
  if (entries.length === 0) return [];
  const { notInstalled, failedAtRuntime } = splitToolsUnavailable(entries);
  const lines: string[] = [];
  if (notInstalled.length > 0) {
    lines.push(`**Tools not installed:** ${notInstalled.join(', ')}`);
  }
  if (failedAtRuntime.length > 0) {
    lines.push(`**Tools that failed at runtime:** ${failedAtRuntime.join(', ')}`);
  }
  return lines;
}
