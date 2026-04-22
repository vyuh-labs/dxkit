/**
 * Global capabilities — registered providers for tools that run once per
 * repo rather than per language pack (gitleaks, grep-secrets fallback,
 * semgrep, jscpd, graphify).
 *
 * The provider interface is identical to per-pack (`CapabilityProvider<T>`).
 * What makes these "global" is only the registration site: providers are
 * looked up by capability id rather than by iterating `LANGUAGES`. When a
 * global provider needs per-pack input (semgrep's rulesets come from each
 * active pack's `semgrepRulesets` declaration), it calls
 * `detectActiveLanguages(cwd)` inside its own `gather()` — no interface
 * extension needed.
 *
 * Each slot is an **array of providers** (Phase 10e.C.7.5). Multi-provider
 * merge is handled by the descriptor's `aggregate` function: SECRETS +
 * CODE_PATTERNS union findings and unique-join tool names; DUPLICATION
 * sums totals + re-weights percentage; STRUCTURAL is last-wins. That lets
 * us register a fallback provider alongside the primary (e.g. grep-secrets
 * behind gitleaks) or layer an opt-in commercial scanner (Snyk for
 * DEP_VULNS, Phase 10h.4) without structural change at the dispatch
 * layer.
 */

import { gitleaksProvider } from '../../analyzers/tools/gitleaks';
import { graphifyProvider } from '../../analyzers/tools/graphify';
import { grepSecretsProvider } from '../../analyzers/tools/grep-secrets';
import { jscpdProvider } from '../../analyzers/tools/jscpd';
import { semgrepProvider } from '../../analyzers/tools/semgrep';
import type { CapabilityProvider } from './provider';
import type {
  CodePatternsResult,
  DuplicationResult,
  SecretsResult,
  StructuralResult,
} from './types';

export interface GlobalCapabilities {
  secrets?: ReadonlyArray<CapabilityProvider<SecretsResult>>;
  codePatterns?: ReadonlyArray<CapabilityProvider<CodePatternsResult>>;
  duplication?: ReadonlyArray<CapabilityProvider<DuplicationResult>>;
  structural?: ReadonlyArray<CapabilityProvider<StructuralResult>>;
}

/**
 * Registered providers per capability. Providers live in their tool file
 * under `src/analyzers/tools/*.ts` and are imported here. Each is a
 * free-standing module — they don't extend any class or know about each
 * other, so adding one is a pure registration edit.
 *
 * `secrets` stacks gitleaks with a grep-based fallback (`grep-secrets`)
 * that returns null whenever gitleaks is installed. The fallback only
 * contributes on environments without gitleaks, preserving pre-C.7
 * "gitleaks dominates" semantics while still covering degraded setups.
 */
export const GLOBAL_CAPABILITIES: GlobalCapabilities = {
  secrets: [gitleaksProvider, grepSecretsProvider],
  codePatterns: [semgrepProvider],
  duplication: [jscpdProvider],
  structural: [graphifyProvider],
};
