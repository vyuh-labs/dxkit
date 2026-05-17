import { describe, it, expect } from 'vitest';
import {
  splitToolsUnavailable,
  renderToolsUnavailableLines,
} from '../src/analyzers/tools/tools-unavailable-prose';

describe('splitToolsUnavailable', () => {
  it('routes `(not installed)` entries to notInstalled with suffix stripped', () => {
    const split = splitToolsUnavailable(['jscpd (not installed)', 'graphify (not installed)']);
    expect(split.notInstalled).toEqual(['jscpd', 'graphify']);
    expect(split.failedAtRuntime).toEqual([]);
  });

  it('routes runtime-failure reasons to failedAtRuntime unchanged', () => {
    const split = splitToolsUnavailable([
      'jscpd (timed out at 600s (try narrowing scan scope via .dxkit-ignore))',
      'semgrep (exit code 137 (stderr: killed))',
      'graphify (no output)',
      'jscpd (parse error)',
    ]);
    expect(split.notInstalled).toEqual([]);
    expect(split.failedAtRuntime).toEqual([
      'jscpd (timed out at 600s (try narrowing scan scope via .dxkit-ignore))',
      'semgrep (exit code 137 (stderr: killed))',
      'graphify (no output)',
      'jscpd (parse error)',
    ]);
  });

  it('routes bare tool names (no reason suffix) to failedAtRuntime', () => {
    const split = splitToolsUnavailable(['jscpd', 'graphify']);
    expect(split.notInstalled).toEqual([]);
    expect(split.failedAtRuntime).toEqual(['jscpd', 'graphify']);
  });

  it('handles a mixed list', () => {
    const split = splitToolsUnavailable([
      'jscpd (not installed)',
      'semgrep (timed out at 600s)',
      'graphify (no output)',
    ]);
    expect(split.notInstalled).toEqual(['jscpd']);
    expect(split.failedAtRuntime).toEqual(['semgrep (timed out at 600s)', 'graphify (no output)']);
  });

  it('does NOT split entries with `not installed` mid-reason', () => {
    // Defensive: only matches the trailing `(not installed)` suffix
    // shape `pushUnavailable` emits, not arbitrary stderr text.
    const split = splitToolsUnavailable(['jscpd (stderr: "config not installed for project")']);
    expect(split.notInstalled).toEqual([]);
    expect(split.failedAtRuntime.length).toBe(1);
  });
});

describe('renderToolsUnavailableLines', () => {
  it('returns empty array for empty input', () => {
    expect(renderToolsUnavailableLines([])).toEqual([]);
  });

  it('emits only the not-installed line when failures are absent', () => {
    expect(renderToolsUnavailableLines(['jscpd (not installed)'])).toEqual([
      '**Tools not installed:** jscpd',
    ]);
  });

  it('emits only the failed-at-runtime line when not-installed is absent', () => {
    expect(renderToolsUnavailableLines(['jscpd (timed out at 600s)'])).toEqual([
      '**Tools that failed at runtime:** jscpd (timed out at 600s)',
    ]);
  });

  it('emits both lines when both categories are populated', () => {
    const lines = renderToolsUnavailableLines([
      'jscpd (not installed)',
      'semgrep (exit code 137 (stderr: killed))',
    ]);
    expect(lines).toEqual([
      '**Tools not installed:** jscpd',
      '**Tools that failed at runtime:** semgrep (exit code 137 (stderr: killed))',
    ]);
  });

  it('does NOT use the misleading "Tools unavailable" label', () => {
    const lines = renderToolsUnavailableLines(['jscpd (not installed)', 'graphify (no output)']);
    for (const line of lines) {
      expect(line).not.toMatch(/Tools unavailable/);
    }
  });
});
