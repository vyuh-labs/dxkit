import { describe, expect, it } from 'vitest';
import { CAPABILITY_REGISTRY, type CapabilityId } from '../src/languages/capabilities/descriptors';
import { LANGUAGES } from '../src/languages';
import type { LanguagePackCapabilities, LanguageSupport } from '../src/languages/types';

/**
 * Compile-time type assertion: `LanguagePackCapabilities` slots and
 * `CAPABILITY_REGISTRY` keys must be the same set. If a future commit
 * adds a slot to one without the other, this fails to type-check.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type PackCapKeys = keyof Required<LanguagePackCapabilities>;
type RegistryKeys = keyof typeof CAPABILITY_REGISTRY;
const _typeAssertion: Equals<PackCapKeys, RegistryKeys> = true;
void _typeAssertion;

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

  it('exposes the capability slots registered through Phase 10e.B.4', () => {
    const expected: CapabilityId[] = ['depVulns', 'lint', 'coverage', 'testFramework', 'imports'];
    for (const id of expected) {
      expect(CAPABILITY_REGISTRY[id]).toBeDefined();
    }
  });
});

describe.each(LANGUAGES as LanguageSupport[])('capability provider shape: $id', (lang) => {
  it('declared capability slots are valid descriptor keys', () => {
    if (!lang.capabilities) return;
    for (const key of Object.keys(lang.capabilities)) {
      expect(CAPABILITY_REGISTRY).toHaveProperty(key);
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
