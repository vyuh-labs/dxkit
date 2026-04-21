/**
 * Capability provider contract.
 *
 * Anything that can produce a capability result implements this — language
 * packs (`LanguageSupport.capabilities.depVulns`, …) and global gatherers
 * (`gitleaks`, `semgrep`, …) alike. Returning `null` means "this provider
 * has nothing to contribute for this cwd" (e.g. the Python pack on a
 * Go-only repo); the dispatcher filters nulls before aggregating.
 */

import type { CapabilityEnvelope } from './types';

export interface CapabilityProvider<T extends CapabilityEnvelope> {
  /** Source name for attribution in logs and errors (usually the language id). */
  readonly source: string;
  gather(cwd: string): Promise<T | null>;
}
