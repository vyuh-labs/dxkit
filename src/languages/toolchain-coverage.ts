/**
 * "Is the repo's OWN language toolchain present?" — the ONE pack-driven signal
 * (Rule 2 + Rule 6) behind an honest coverage claim.
 *
 * A language pack's deep analysis (its lint gate, license inventory, and the
 * `dotnet build` / `go build` correctness floor) needs the pack's toolchain
 * binary on PATH. When it is absent, those classes are UNMEASURED — captured as
 * a silent gap, not a clean scan. A real onboarding surfaced the cost:
 * a pure-C# repo baselined with NO `dotnet` on PATH, yet the finish arc printed
 * an unqualified "You're gated ✓" and pointed remediation at `tools install`
 * (which can't install the SDK either — a loop). doctor already reported the
 * gap honestly via each pack's `cliBinaries`; the finish arc reduced it to a
 * one-line footnote because it had no shared signal to read.
 *
 * This module is that shared signal: doctor's per-language toolchain check AND
 * the init finish-arc honesty both resolve it here, so a partial baseline can
 * never be presented as full coverage on one surface while the other tells the
 * truth. Purely PATH-derived (`commandExists`) so it is cheap and side-effect
 * free.
 */

import { commandExists } from '../analyzers/tools/runner';
import type { LanguageSupport } from './types';

/** One active language pack whose toolchain is (partly) absent from PATH. */
export interface LanguageToolchainGap {
  /** Pack id (e.g. `csharp`). */
  readonly language: string;
  /** Human label for messaging (e.g. `C#`). */
  readonly displayName: string;
  /** The pack's `cliBinaries` that are NOT resolvable on PATH — the toolchain
   *  drivers whose absence makes the pack's deep classes unmeasured. */
  readonly missingBinaries: readonly string[];
}

/**
 * For each active pack, the `cliBinaries` missing from PATH. A pack with no
 * `cliBinaries`, or all present, contributes nothing. Deterministic order
 * (input order); the caller decides how loudly to surface it.
 */
export function assessLanguageToolchains(
  activeLanguages: readonly LanguageSupport[],
): LanguageToolchainGap[] {
  const gaps: LanguageToolchainGap[] = [];
  for (const lang of activeLanguages) {
    const missing = (lang.cliBinaries ?? []).filter((bin) => !commandExists(bin));
    if (missing.length > 0) {
      gaps.push({ language: lang.id, displayName: lang.displayName, missingBinaries: missing });
    }
  }
  return gaps;
}

/**
 * Whether an active pack's toolchain is missing — the boolean that disqualifies
 * an unqualified "You're gated ✓". True iff at least one active pack has an
 * absent `cliBinary`.
 */
export function primaryLanguageUnmeasured(gaps: readonly LanguageToolchainGap[]): boolean {
  return gaps.length > 0;
}
