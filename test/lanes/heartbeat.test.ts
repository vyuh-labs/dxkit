/**
 * The lane heartbeat: phases become log groups (under Actions) and a timer
 * makes long phases observably "working" rather than hung.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startPhaseReporter } from '../../src/lanes/heartbeat';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('startPhaseReporter', () => {
  it('emits ::group:: markers per phase under Actions and closes them', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const lines: string[] = [];
    const r = startPhaseReporter('remediate:fix-build', { write: (l) => lines.push(l) });
    r.phase('entry-floor');
    r.phase('agent');
    r.stop();
    expect(lines).toEqual([
      '::group::[remediate:fix-build] entry-floor',
      '::endgroup::',
      '::group::[remediate:fix-build] agent',
      '::endgroup::',
    ]);
  });

  it('degrades to plain phase lines outside Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    const lines: string[] = [];
    const r = startPhaseReporter('remediate:x', { write: (l) => lines.push(l) });
    r.phase('agent');
    r.stop();
    expect(lines).toEqual(['[remediate:x] phase: agent']);
  });

  it('prints a heartbeat inside a long phase, and stops with stop()', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.useFakeTimers();
    const lines: string[] = [];
    const r = startPhaseReporter('remediate:x', { write: (l) => lines.push(l), intervalMs: 1000 });
    r.phase('agent');
    vi.advanceTimersByTime(2500);
    const beats = lines.filter((l) => l.includes('still running'));
    expect(beats.length).toBe(2);
    expect(beats[0]).toContain('agent');
    r.stop();
    vi.advanceTimersByTime(5000);
    expect(lines.filter((l) => l.includes('still running')).length).toBe(2);
  });
});
