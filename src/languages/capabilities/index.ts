/**
 * Capability barrel + provider resolver.
 *
 * Analyzers call `providersFor(SECRETS)` rather than hand-iterating
 * `LANGUAGES` or reading `GLOBAL_CAPABILITIES` directly. One lookup
 * function hides the per-pack vs global split so analyzer code reads
 * identically regardless of which registry hosts the capability.
 */

import { LANGUAGES } from '../index';
import { type CapabilityDescriptor, GLOBAL_REGISTRY, PER_PACK_REGISTRY } from './descriptors';
import { GLOBAL_CAPABILITIES, type GlobalCapabilities } from './global';
import type { CapabilityProvider } from './provider';
import type { CapabilityEnvelope } from './types';
import type { LanguagePackCapabilities } from '../types';

/**
 * Resolve the concrete provider list for a capability descriptor.
 *
 * For per-pack capabilities (depVulns, lint, coverage, testFramework,
 * imports): collected from every LanguageSupport that declared a provider
 * in `capabilities.<id>`. Inactive packs (detect() returns false for this
 * repo) still contribute — each provider is responsible for returning
 * null when it has nothing to do. The dispatcher filters nulls before
 * aggregating.
 *
 * For global capabilities (secrets, codePatterns, duplication, structural):
 * a single-element array with the registered global provider, or empty
 * if nothing is wired yet.
 */
export function providersFor<T extends CapabilityEnvelope>(
  cap: CapabilityDescriptor<T>,
): ReadonlyArray<CapabilityProvider<T>> {
  // The casts through `unknown` are safe at runtime because PER_PACK_REGISTRY
  // and GLOBAL_REGISTRY are typed such that `cap.id` being in a registry
  // implies the providers under that key produce exactly T. TypeScript can't
  // prove that across the two branches without heavier type-level machinery.
  if (cap.id in GLOBAL_REGISTRY) {
    const p = GLOBAL_CAPABILITIES[cap.id as keyof GlobalCapabilities];
    return p ? [p as unknown as CapabilityProvider<T>] : [];
  }
  if (cap.id in PER_PACK_REGISTRY) {
    const key = cap.id as keyof LanguagePackCapabilities;
    const providers: CapabilityProvider<T>[] = [];
    for (const lang of LANGUAGES) {
      const p = lang.capabilities?.[key];
      if (p) providers.push(p as unknown as CapabilityProvider<T>);
    }
    return providers;
  }
  return [];
}

export { GLOBAL_CAPABILITIES, type GlobalCapabilities } from './global';
