import { describe, expect, it, vi } from 'vitest';
import { CapabilityDispatcher } from '../src/analyzers/dispatcher';
import { DEP_VULNS, LINT } from '../src/languages/capabilities/descriptors';
import type { CapabilityProvider } from '../src/languages/capabilities/provider';
import type { DepVulnResult, LintResult } from '../src/languages/capabilities/types';

function depVulnProvider(
  source: string,
  result: DepVulnResult | null,
): CapabilityProvider<DepVulnResult> {
  return { source, gather: async () => result };
}

function throwingProvider(source: string, err: unknown): CapabilityProvider<DepVulnResult> {
  return {
    source,
    gather: async () => {
      throw err;
    },
  };
}

const sample = (counts: DepVulnResult['counts'], tool = 't'): DepVulnResult => ({
  schemaVersion: 1,
  tool,
  enrichment: null,
  counts,
});

describe('CapabilityDispatcher.gather', () => {
  it('returns null when no providers are passed', async () => {
    const d = new CapabilityDispatcher();
    expect(await d.gather('/cwd', DEP_VULNS, [])).toBeNull();
  });

  it('returns null when every provider returns null', async () => {
    const d = new CapabilityDispatcher();
    const out = await d.gather('/cwd', DEP_VULNS, [
      depVulnProvider('a', null),
      depVulnProvider('b', null),
    ]);
    expect(out).toBeNull();
  });

  it('returns the descriptor-aggregated envelope when providers succeed', async () => {
    const d = new CapabilityDispatcher();
    const out = await d.gather('/cwd', DEP_VULNS, [
      depVulnProvider('a', sample({ critical: 1, high: 0, medium: 0, low: 0 }, 'npm-audit')),
      depVulnProvider('b', sample({ critical: 0, high: 2, medium: 0, low: 0 }, 'pip-audit')),
    ]);
    expect(out?.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });
    expect(out?.tool).toBe('npm-audit, pip-audit');
  });

  it('isolates provider failures and continues with the rest', async () => {
    const onErr = vi.fn();
    const d = new CapabilityDispatcher({ onProviderError: onErr });
    const out = await d.gather('/cwd', DEP_VULNS, [
      throwingProvider('boom', new Error('nope')),
      depVulnProvider('ok', sample({ critical: 0, high: 0, medium: 0, low: 5 }, 'npm-audit')),
    ]);
    expect(out?.counts.low).toBe(5);
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(onErr).toHaveBeenCalledWith('depVulns', 'boom', expect.any(Error));
  });

  it('returns null when every provider rejects', async () => {
    const d = new CapabilityDispatcher();
    const out = await d.gather('/cwd', DEP_VULNS, [
      throwingProvider('a', new Error('a')),
      throwingProvider('b', new Error('b')),
    ]);
    expect(out).toBeNull();
  });

  it('dedups concurrent calls for the same (cwd, capability)', async () => {
    const d = new CapabilityDispatcher();
    const gather = vi
      .fn()
      .mockResolvedValue(sample({ critical: 1, high: 0, medium: 0, low: 0 }, 'npm-audit'));
    const provider: CapabilityProvider<DepVulnResult> = { source: 'a', gather };
    const [out1, out2] = await Promise.all([
      d.gather('/cwd', DEP_VULNS, [provider]),
      d.gather('/cwd', DEP_VULNS, [provider]),
    ]);
    expect(gather).toHaveBeenCalledTimes(1);
    expect(out1).toBe(out2);
  });

  it('reuses the cached promise for serial calls in the same dispatcher', async () => {
    const d = new CapabilityDispatcher();
    const gather = vi
      .fn()
      .mockResolvedValue(sample({ critical: 0, high: 0, medium: 0, low: 1 }, 'npm-audit'));
    const provider: CapabilityProvider<DepVulnResult> = { source: 'a', gather };
    await d.gather('/cwd', DEP_VULNS, [provider]);
    await d.gather('/cwd', DEP_VULNS, [provider]);
    expect(gather).toHaveBeenCalledTimes(1);
  });

  it('uses a separate cache slot per cwd', async () => {
    const d = new CapabilityDispatcher();
    const gather = vi
      .fn()
      .mockResolvedValue(sample({ critical: 0, high: 0, medium: 0, low: 0 }, 'npm-audit'));
    const provider: CapabilityProvider<DepVulnResult> = { source: 'a', gather };
    await d.gather('/repo-a', DEP_VULNS, [provider]);
    await d.gather('/repo-b', DEP_VULNS, [provider]);
    expect(gather).toHaveBeenCalledTimes(2);
  });

  it('uses a separate cache slot per capability', async () => {
    const d = new CapabilityDispatcher();
    const dvProvider: CapabilityProvider<DepVulnResult> = {
      source: 'a',
      gather: async () => sample({ critical: 0, high: 0, medium: 0, low: 0 }, 'npm-audit'),
    };
    const lintProvider: CapabilityProvider<LintResult> = {
      source: 'a',
      gather: async () => ({
        schemaVersion: 1,
        tool: 'eslint',
        counts: { critical: 0, high: 0, medium: 0, low: 0 },
      }),
    };
    const dv = await d.gather('/cwd', DEP_VULNS, [dvProvider]);
    const lint = await d.gather('/cwd', LINT, [lintProvider]);
    expect(dv?.tool).toBe('npm-audit');
    expect(lint?.tool).toBe('eslint');
  });

  it('clearCache() forces re-execution', async () => {
    const d = new CapabilityDispatcher();
    const gather = vi
      .fn()
      .mockResolvedValue(sample({ critical: 0, high: 0, medium: 0, low: 0 }, 'npm-audit'));
    const provider: CapabilityProvider<DepVulnResult> = { source: 'a', gather };
    await d.gather('/cwd', DEP_VULNS, [provider]);
    d.clearCache();
    await d.gather('/cwd', DEP_VULNS, [provider]);
    expect(gather).toHaveBeenCalledTimes(2);
  });
});
