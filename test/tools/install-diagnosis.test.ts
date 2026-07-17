/**
 * Stale-index install diagnosis (CLAUDE.md Rule 20, problem C).
 *
 * Turns pip's unsatisfiable-requirement wall into one legible sentence naming
 * the root cause (a mirror / offline proxy) and the remedy (defer to CI). Biased
 * toward a false NEGATIVE — a non-pip failure keeps its raw text.
 */

import { describe, it, expect } from 'vitest';
import { diagnoseStaleIndex } from '../../src/analyzers/tools/install-diagnosis';

describe('diagnoseStaleIndex', () => {
  it('reads the pin + the newest available version and names the mirror cause', () => {
    const out = [
      'ERROR: Could not find a version that satisfies the requirement semgrep==1.165.0',
      '  (from versions: 1.96.0, 1.97.0, 1.99.0)',
      'ERROR: No matching distribution found for semgrep==1.165.0',
    ].join('\n');
    const d = diagnoseStaleIndex(out);
    expect(d).not.toBeNull();
    expect(d!.pkg).toBe('semgrep');
    expect(d!.wanted).toBe('1.165.0');
    expect(d!.newestAvailable).toBe('1.99.0');
    expect(d!.message).toContain('1.99.0');
    expect(d!.message).toMatch(/mirror|proxy/i);
    expect(d!.message).toMatch(/CI/);
    // Never a raw pip line.
    expect(d!.message).not.toContain('No matching distribution');
  });

  it('handles a package genuinely absent from the index (no from-versions list)', () => {
    const out = 'ERROR: No matching distribution found for pip-audit==2.10.1';
    const d = diagnoseStaleIndex(out);
    expect(d).not.toBeNull();
    expect(d!.pkg).toBe('pip-audit');
    expect(d!.wanted).toBe('2.10.1');
    expect(d!.newestAvailable).toBeUndefined();
    expect(d!.message).toMatch(/mirror|proxy/i);
  });

  it('treats "from versions: none" as genuinely absent (not a newest)', () => {
    const out = [
      'ERROR: Could not find a version that satisfies the requirement foopkg==1.0.0 (from versions: none)',
      'ERROR: No matching distribution found for foopkg==1.0.0',
    ].join('\n');
    const d = diagnoseStaleIndex(out);
    expect(d!.newestAvailable).toBeUndefined();
  });

  it('returns null on an unrelated failure (a real error keeps its raw text)', () => {
    expect(diagnoseStaleIndex('bash: pip: command not found')).toBeNull();
    expect(diagnoseStaleIndex('Connection timed out after 30000ms')).toBeNull();
    expect(diagnoseStaleIndex('')).toBeNull();
  });

  it('handles a bare requirement with no pinned version', () => {
    const d = diagnoseStaleIndex('ERROR: No matching distribution found for coverage');
    expect(d).not.toBeNull();
    expect(d!.pkg).toBe('coverage');
    expect(d!.wanted).toBeUndefined();
  });
});
