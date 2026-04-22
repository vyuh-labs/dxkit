import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REGISTRY,
  GLOBAL_REGISTRY,
  PER_PACK_REGISTRY,
  type CapabilityId,
} from '../src/languages/capabilities/descriptors';
import { LANGUAGES } from '../src/languages';
import { GLOBAL_CAPABILITIES } from '../src/languages/capabilities/global';
import { providersFor } from '../src/languages/capabilities';
import { SECRETS } from '../src/languages/capabilities/descriptors';
import type { GlobalCapabilities } from '../src/languages/capabilities/global';
import type { LanguagePackCapabilities, LanguageSupport } from '../src/languages/types';

/**
 * Compile-time type assertions: each half of the registry must match
 * the keys of its hosting type exactly. If a future commit adds a slot
 * to one without the other, this fails to type-check.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type PackCapKeys = keyof Required<LanguagePackCapabilities>;
type PerPackRegistryKeys = keyof typeof PER_PACK_REGISTRY;
const _perPackAssertion: Equals<PackCapKeys, PerPackRegistryKeys> = true;
void _perPackAssertion;

type GlobalCapKeys = keyof Required<GlobalCapabilities>;
type GlobalRegistryKeys = keyof typeof GLOBAL_REGISTRY;
const _globalAssertion: Equals<GlobalCapKeys, GlobalRegistryKeys> = true;
void _globalAssertion;

describe('capability registry consistency', () => {
  it('every descriptor.id matches its registry key', () => {
    for (const [key, desc] of Object.entries(CAPABILITY_REGISTRY)) {
      expect(desc.id, `registry slot "${key}" maps to descriptor with id "${desc.id}"`).toBe(key);
    }
  });

  it('descriptor ids are unique', () => {
    const ids = Object.values(CAPABILITY_REGISTRY).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes the capability slots registered through Phase 10e.B.9', () => {
    const expected: CapabilityId[] = [
      'depVulns',
      'lint',
      'coverage',
      'testFramework',
      'imports',
      'secrets',
      'codePatterns',
      'duplication',
      'structural',
    ];
    for (const id of expected) {
      expect(CAPABILITY_REGISTRY[id]).toBeDefined();
    }
  });

  it('per-pack and global halves are disjoint', () => {
    const perPackKeys = new Set(Object.keys(PER_PACK_REGISTRY));
    const globalKeys = new Set(Object.keys(GLOBAL_REGISTRY));
    for (const k of perPackKeys) {
      expect(globalKeys.has(k), `"${k}" appears in both halves`).toBe(false);
    }
  });
});

describe.each(LANGUAGES as LanguageSupport[])('capability provider shape: $id', (lang) => {
  it('declared capability slots are valid per-pack descriptor keys', () => {
    if (!lang.capabilities) return;
    for (const key of Object.keys(lang.capabilities)) {
      expect(PER_PACK_REGISTRY).toHaveProperty(key);
    }
  });

  it('every declared provider has a non-empty source string and a gather function', () => {
    if (!lang.capabilities) return;
    for (const [key, provider] of Object.entries(lang.capabilities)) {
      if (!provider) continue;
      expect(typeof provider.source, `${lang.id}.${key}.source`).toBe('string');
      expect((provider.source as string).length).toBeGreaterThan(0);
      expect(typeof provider.gather, `${lang.id}.${key}.gather`).toBe('function');
    }
  });
});

describe('global capabilities shape', () => {
  it('declared global providers match GLOBAL_REGISTRY keys', () => {
    for (const key of Object.keys(GLOBAL_CAPABILITIES)) {
      expect(GLOBAL_REGISTRY).toHaveProperty(key);
    }
  });

  it('every registered global provider has source + gather()', () => {
    // Phase 10e.C.7.5: each slot holds an array of providers (multiple
    // providers per capability — e.g. SECRETS stacks gitleaks + the
    // grep-secrets fallback).
    for (const [key, providers] of Object.entries(GLOBAL_CAPABILITIES)) {
      if (!providers) continue;
      expect(Array.isArray(providers), `global.${key} is an array`).toBe(true);
      for (const provider of providers) {
        expect(typeof provider.source, `global.${key}[].source`).toBe('string');
        expect((provider.source as string).length).toBeGreaterThan(0);
        expect(typeof provider.gather, `global.${key}[].gather`).toBe('function');
      }
    }
  });
});

describe('providersFor()', () => {
  it('returns the per-pack provider list for a per-pack capability', () => {
    // Every pack has a depVulns provider today; use that as the canary.
    const providers = providersFor(PER_PACK_REGISTRY.depVulns);
    expect(providers.length).toBe(LANGUAGES.length);
  });

  it('returns the registered global providers for a global capability', () => {
    // SECRETS stacks gitleaksProvider + grepSecretsProvider (Phase 10e.C.7.5).
    const providers = providersFor(SECRETS);
    const sources = providers.map((p) => p.source).sort();
    expect(sources).toEqual(['gitleaks', 'grep-secrets']);
  });
});
