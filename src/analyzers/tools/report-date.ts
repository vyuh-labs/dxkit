/**
 * Canonical "today" string (YYYY-MM-DD) for report filenames.
 *
 * Honors `DXKIT_REPORT_DATE` from the environment so the orchestrator
 * can snapshot the date once at startup and propagate it to every
 * subcommand it spawns. Without the snapshot, a long `report` run
 * crossing UTC midnight produces a mix of `*-2026-05-17.md` (written
 * before midnight) and `*-2026-05-18.md` (written after), and the
 * orchestrator's post-step file-existence checks miss the rolled-
 * forward files — reports are on disk but the parent reports them
 * as failed.
 *
 * Standalone subcommand invocations (with no env var set) keep their
 * pre-existing behavior: compute today fresh at write time.
 */
export function getReportDate(): string {
  const fromEnv = process.env.DXKIT_REPORT_DATE;
  if (fromEnv && /^\d{4}-\d{2}-\d{2}$/.test(fromEnv)) {
    return fromEnv;
  }
  return new Date().toISOString().slice(0, 10);
}
