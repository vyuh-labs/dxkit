/**
 * Global capabilities — registered providers for tools that run once per
 * repo rather than per language pack (gitleaks, semgrep, jscpd, graphify).
 *
 * The provider interface is identical to per-pack (`CapabilityProvider<T>`).
 * What makes these "global" is only the registration site: a single instance
 * per capability, looked up by id rather than by iterating `LANGUAGES`. When
 * a global provider needs per-pack input (semgrep's rulesets come from each
 * active pack's `semgrepRulesets` declaration), it calls
 * `detectActiveLanguages(cwd)` inside its own `gather()` — no interface
 * extension needed.
 *
 * New global scanners (trufflehog, codeql, syft for SBOMs) join the same
 * slot their capability describes. The `GLOBAL_CAPABILITIES` singleton
 * wires a single provider per slot today; multi-provider merge is handled
 * by the descriptor's aggregate function (see `SECRETS.aggregate`) and
 * needs zero structural change.
 */

import { gitleaksProvider } from '../../analyzers/tools/gitleaks';
import { graphifyProvider } from '../../analyzers/tools/graphify';
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
  secrets?: CapabilityProvider<SecretsResult>;
  codePatterns?: CapabilityProvider<CodePatternsResult>;
  duplication?: CapabilityProvider<DuplicationResult>;
  structural?: CapabilityProvider<StructuralResult>;
}

/**
 * The single registered instance — providers live in their tool file
 * under `src/analyzers/tools/*.ts` and are imported here. Providers are
 * free-standing modules; they don't extend any class or know about each
 * other, so adding one is a pure registration edit.
 */
export const GLOBAL_CAPABILITIES: GlobalCapabilities = {
  secrets: gitleaksProvider,
  codePatterns: semgrepProvider,
  duplication: jscpdProvider,
  structural: graphifyProvider,
};
