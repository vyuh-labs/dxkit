/**
 * Lane progress reporting — the heartbeat that makes "working" observable
 * from a CI job log (the core observability requirement from the first
 * production remediate run: one monolithic step, 35+ minutes in-progress,
 * zero streamed output — indistinguishable from a hang).
 *
 * Under GitHub Actions each phase opens a `::group::` (collapsible per-phase
 * logs) and a timer prints an elapsed-time heartbeat line inside the current
 * phase every interval. Outside Actions the group markers degrade to plain
 * phase lines; the heartbeat still prints (a local 30-minute run is just as
 * opaque). Everything goes to STDERR unbuffered, so it streams regardless of
 * stdout buffering.
 */

const HEARTBEAT_INTERVAL_MS = 60_000;

export interface PhaseReporter {
  /** Enter a phase: closes the previous group, opens a new one, resets the
   *  phase clock. */
  phase(name: string): void;
  /** Stop the heartbeat and close any open group. Always call in finally. */
  stop(): void;
}

function inActions(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

function minutes(sinceMs: number): string {
  return `${Math.round((Date.now() - sinceMs) / 60_000)}m`;
}

/**
 * Create a reporter for one labeled run (e.g. a remediate task). Injectable
 * write/now for tests.
 */
export function startPhaseReporter(
  label: string,
  io?: {
    readonly write?: (line: string) => void;
    readonly intervalMs?: number;
  },
): PhaseReporter {
  const write = io?.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const intervalMs = io?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let current: string | undefined;
  let phaseStart = Date.now();
  const runStart = Date.now();

  const timer = setInterval(() => {
    if (current === undefined) return;
    write(
      `[${label}] still running: ${current} (${minutes(phaseStart)} in phase, ${minutes(runStart)} total)`,
    );
  }, intervalMs);
  // Never hold the process open for a heartbeat.
  timer.unref?.();

  return {
    phase(name: string) {
      if (current !== undefined && inActions()) write('::endgroup::');
      current = name;
      phaseStart = Date.now();
      if (inActions()) write(`::group::[${label}] ${name}`);
      else write(`[${label}] phase: ${name}`);
    },
    stop() {
      clearInterval(timer);
      if (current !== undefined && inActions()) write('::endgroup::');
      current = undefined;
    },
  };
}
