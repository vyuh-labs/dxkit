import { describe, it, expect } from 'vitest';
import { BASELINE_MODES, parseBaselineMode, resolveBaselineMode } from '../../src/baseline/modes';
import type { ResolveModeOptions } from '../../src/baseline/modes';

/**
 * Build a base options object for the resolver — every field is
 * optional in `ResolveModeOptions`, so this just lifts the
 * `cwd` and lets each test stamp on the fields it cares about.
 *
 * The two probe injections (`probeVisibility`, `probeDefaultRef`)
 * are stamped to deterministic stubs in EVERY test so no test
 * accidentally shells out to `gh` or `git`.
 */
function opts(overrides: Partial<ResolveModeOptions> = {}): ResolveModeOptions {
  return {
    cwd: '/fixture',
    probeVisibility: () => 'unknown',
    probeDefaultRef: () => undefined,
    ...overrides,
  };
}

describe('BASELINE_MODES', () => {
  it('exports the three canonical modes in declared order', () => {
    expect(BASELINE_MODES).toEqual(['committed-full', 'committed-sanitized', 'ref-based']);
  });
});

describe('parseBaselineMode', () => {
  it('accepts each canonical mode', () => {
    for (const mode of BASELINE_MODES) {
      expect(parseBaselineMode(mode)).toBe(mode);
    }
  });

  it('rejects unknown values', () => {
    expect(parseBaselineMode('full')).toBeNull();
    expect(parseBaselineMode('Committed-Full')).toBeNull();
    expect(parseBaselineMode('')).toBeNull();
    expect(parseBaselineMode('ref')).toBeNull();
  });
});

describe('resolveBaselineMode — precedence', () => {
  it('CLI flag wins over policy + visibility', () => {
    const result = resolveBaselineMode(
      opts({
        cliMode: 'committed-sanitized',
        policyMode: 'committed-full',
        probeVisibility: () => 'public',
      }),
    );
    expect(result.mode).toBe('committed-sanitized');
    expect(result.source).toBe('cli');
    expect(result.explanation).toContain('--mode flag');
  });

  it('policy wins over visibility when no CLI flag', () => {
    const result = resolveBaselineMode(
      opts({
        policyMode: 'committed-sanitized',
        probeVisibility: () => 'public',
      }),
    );
    expect(result.mode).toBe('committed-sanitized');
    expect(result.source).toBe('policy');
    expect(result.explanation).toContain('policy.json');
  });

  it('visibility=public auto-picks ref-based', () => {
    const result = resolveBaselineMode(
      opts({
        probeVisibility: () => 'public',
        probeDefaultRef: () => 'origin/main',
      }),
    );
    expect(result.mode).toBe('ref-based');
    expect(result.source).toBe('auto-public');
    expect(result.ref).toBe('origin/main');
  });

  it('visibility=private auto-picks committed-full', () => {
    const result = resolveBaselineMode(opts({ probeVisibility: () => 'private' }));
    expect(result.mode).toBe('committed-full');
    expect(result.source).toBe('auto-private');
    expect(result.ref).toBeUndefined();
  });

  it('visibility=internal auto-picks committed-full (not ref-based)', () => {
    const result = resolveBaselineMode(opts({ probeVisibility: () => 'internal' }));
    expect(result.mode).toBe('committed-full');
    expect(result.source).toBe('auto-internal');
  });

  it('visibility=unknown auto-picks committed-full with safe-default explanation', () => {
    const result = resolveBaselineMode(opts({ probeVisibility: () => 'unknown' }));
    expect(result.mode).toBe('committed-full');
    expect(result.source).toBe('auto-unknown');
    expect(result.explanation).toContain('not detectable');
  });
});

describe('resolveBaselineMode — ref resolution for ref-based', () => {
  it('CLI ref wins over policy + probe', () => {
    const result = resolveBaselineMode(
      opts({
        cliMode: 'ref-based',
        cliRef: 'origin/release-2024',
        policyRef: 'origin/main',
        probeDefaultRef: () => 'origin/develop',
      }),
    );
    expect(result.ref).toBe('origin/release-2024');
  });

  it('policy ref wins over probe when no CLI ref', () => {
    const result = resolveBaselineMode(
      opts({
        cliMode: 'ref-based',
        policyRef: 'origin/main',
        probeDefaultRef: () => 'origin/develop',
      }),
    );
    expect(result.ref).toBe('origin/main');
  });

  it('probe wins over hardcoded fallback when reachable', () => {
    const result = resolveBaselineMode(
      opts({
        cliMode: 'ref-based',
        probeDefaultRef: () => 'origin/trunk',
      }),
    );
    expect(result.ref).toBe('origin/trunk');
  });

  it('falls back to origin/main when probe returns undefined', () => {
    const result = resolveBaselineMode(
      opts({
        cliMode: 'ref-based',
        probeDefaultRef: () => undefined,
      }),
    );
    expect(result.ref).toBe('origin/main');
  });

  it('does not resolve a ref when mode is committed-full', () => {
    const result = resolveBaselineMode(
      opts({
        cliMode: 'committed-full',
        policyRef: 'origin/main',
        probeDefaultRef: () => 'origin/main',
      }),
    );
    expect(result.ref).toBeUndefined();
  });

  it('does not resolve a ref when mode is committed-sanitized', () => {
    const result = resolveBaselineMode(opts({ cliMode: 'committed-sanitized' }));
    expect(result.ref).toBeUndefined();
  });
});

describe('resolveBaselineMode — never auto-picks committed-sanitized', () => {
  it('public does not become sanitized', () => {
    const result = resolveBaselineMode(opts({ probeVisibility: () => 'public' }));
    expect(result.mode).not.toBe('committed-sanitized');
  });

  it('private does not become sanitized', () => {
    const result = resolveBaselineMode(opts({ probeVisibility: () => 'private' }));
    expect(result.mode).not.toBe('committed-sanitized');
  });

  it('only reaches committed-sanitized via explicit CLI or policy', () => {
    expect(resolveBaselineMode(opts({ cliMode: 'committed-sanitized' })).mode).toBe(
      'committed-sanitized',
    );
    expect(resolveBaselineMode(opts({ policyMode: 'committed-sanitized' })).mode).toBe(
      'committed-sanitized',
    );
  });
});
