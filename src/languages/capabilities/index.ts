/**
 * Capability barrel + provider resolver.
 *
 * Analyzers call `providersFor(SECRETS)` rather than hand-iterating
 * `LANGUAGES` or reading `GLOBAL_CAPABILITIES` directly. One lookup
 * function hides the per-pack vs global split so analyzer code reads
 * identically regardless of which registry hosts the capability.
 */

import { LANGUAGES } from '../index';
import type { LanguageSupport } from '../types';
import { type CapabilityDescriptor, GLOBAL_REGISTRY, PER_PACK_REGISTRY } from './descriptors';
import { GLOBAL_CAPABILITIES, type GlobalCapabilities } from './global';
import type { CapabilityProvider } from './provider';
import type { CapabilityEnvelope } from './types';
import type { LanguagePackCapabilities } from '../types';

/**
 * Module-local memo for active-pack detection. `providersFor()` is called
 * once per capability (~9 times) per dxkit run; without memoization,
 * each call re-walks the project tree to evaluate every pack's
 * `detect(cwd)` (kotlin's `hasKotlinSourceWithinDepth` alone is a depth-3
 * filesystem traversal). With six packs × nine capabilities = 54 detect
 * walks per analyzer run; memoizing collapses this to six.
 *
 * The cache is keyed on `cwd`, never invalidates inside the process —
 * `detect()` is supposed to depend only on the project's file layout,
 * which doesn't change mid-run. Tests reset via `clearProvidersForCache`.
 */
const detectCache = new Map<string, ReadonlyArray<LanguageSupport>>();

function activePacksFor(cwd: string): ReadonlyArray<LanguageSupport> {
  let cached = detectCache.get(cwd);
  if (!cached) {
    cached = LANGUAGES.filter((l) => l.detect(cwd));
    detectCache.set(cwd, cached);
  }
  return cached;
}

/** Test seam — drop the active-pack cache between runs. */
export function clearProvidersForCache(): void {
  detectCache.clear();
}

/**
 * Resolve the concrete provider list for a capability descriptor.
 *
 * For per-pack capabilities (depVulns, lint, coverage, testFramework,
 * imports): collected from LanguageSupport entries that declared a
 * provider in `capabilities.<id>`. When a `cwd` is given, filter to
 * packs whose `detect(cwd)` returns true — this is the stack-aware
 * path that closes D010 (inactive-pack `toolsUsed` pollution + the
 * gather-time cost of inactive packs' providers running and bailing
 * fast on every analyzer dispatch). When `cwd` is omitted, every
 * registered pack's provider is returned — this is the path the
 * pack-shape contract tests use to assert "every pack ships X."
 *
 * For global capabilities (secrets, codePatterns, duplication,
 * structural): the registered provider array (Phase 10e.C.7.5),
 * unconditional. Globals are stack-agnostic — gitleaks scans regardless
 * of which packs are active — so the `cwd` parameter is ignored on
 * this branch.
 *
 * SECRETS stacks gitleaks + grep-secrets fallback, DEP_VULNS is set up
 * for a future Snyk opt-in (Phase 10h.4). The descriptor's `aggregate`
 * function merges envelopes across providers. Returns `[]` when the
 * capability id isn't in either registry.
 */
export function providersFor<T extends CapabilityEnvelope>(
  cap: CapabilityDescriptor<T>,
  cwd?: string,
): ReadonlyArray<CapabilityProvider<T>> {
  // The casts through `unknown` are safe at runtime because PER_PACK_REGISTRY
  // and GLOBAL_REGISTRY are typed such that `cap.id` being in a registry
  // implies the providers under that key produce exactly T. TypeScript can't
  // prove that across the two branches without heavier type-level machinery.
  if (cap.id in GLOBAL_REGISTRY) {
    const slot = GLOBAL_CAPABILITIES[cap.id as keyof GlobalCapabilities];
    return (slot ?? []) as unknown as ReadonlyArray<CapabilityProvider<T>>;
  }
  if (cap.id in PER_PACK_REGISTRY) {
    const key = cap.id as keyof LanguagePackCapabilities;
    const candidates = cwd !== undefined ? activePacksFor(cwd) : LANGUAGES;
    const providers: CapabilityProvider<T>[] = [];
    for (const lang of candidates) {
      const p = lang.capabilities?.[key];
      if (p) providers.push(p as unknown as CapabilityProvider<T>);
    }
    return providers;
  }
  return [];
}

export { GLOBAL_CAPABILITIES, type GlobalCapabilities } from './global';
