/**
 * Legibility for a failed tool install (CLAUDE.md Rule 20, problem C).
 *
 * When a pinned Python scanner won't install because the operator's package
 * index is stale (a corporate PyPI mirror months behind, an offline proxy), pip
 * emits a wall of "ERROR: Could not find a version that satisfies the
 * requirement …" / "No matching distribution found …" text. Read raw, that
 * looks like "the product is broken" — when the actual condition is "your index
 * can't reach this version, so dxkit will capture this class on CI instead."
 *
 * This module turns pip's own output into ONE sentence that names the root
 * cause and the remedy dxkit is already taking (defer to CI — the deferral
 * partition records the class). It is a pure classifier over captured stderr; it
 * returns null on anything that is not the stale-mirror signature, so a genuine
 * failure is never masked. Biased toward a false NEGATIVE (say nothing) over a
 * false POSITIVE (claim "behind a mirror" when the failure was something else).
 */

/** A recognized stale-mirror install failure. */
export interface StaleIndexDiagnosis {
  /** The package pip could not satisfy (e.g. `semgrep`). */
  readonly pkg: string;
  /** The pinned version requested, when the requirement carried one. */
  readonly wanted?: string;
  /** Newest version the index DID offer, parsed from pip's "from versions:"
   *  list — present ⇒ the package exists but the pin is unreachable (a mirror);
   *  absent / "none" ⇒ genuinely not in the index. */
  readonly newestAvailable?: string;
  /** The one legible sentence, ready to show in place of the raw wall. */
  readonly message: string;
}

// pip prints, e.g.:
//   ERROR: Could not find a version that satisfies the requirement semgrep==1.165.0
//     (from versions: 1.96.0, 1.97.0, 1.99.0)
//   ERROR: No matching distribution found for semgrep==1.165.0
const NO_MATCH = /No matching distribution found for\s+([A-Za-z0-9._-]+)(?:==([0-9][^\s)]*))?/;
const FROM_VERSIONS = /from versions:\s*([^)]*)/i;

/**
 * Classify a failed install's captured output. Returns the diagnosis when the
 * output is pip's unsatisfiable-requirement signature, else null.
 */
export function diagnoseStaleIndex(output: string): StaleIndexDiagnosis | null {
  if (!output) return null;
  const m = NO_MATCH.exec(output);
  if (!m) return null;
  const pkg = m[1];
  const wanted = m[2];

  let newestAvailable: string | undefined;
  const fv = FROM_VERSIONS.exec(output);
  if (fv) {
    const raw = fv[1].trim();
    if (raw && raw.toLowerCase() !== 'none') {
      // pip lists oldest→newest; the last entry is the newest the index offers.
      const versions = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      newestAvailable = versions[versions.length - 1];
    }
  }

  const want = wanted ? `${pkg} ${wanted}` : pkg;
  let message: string;
  if (newestAvailable) {
    message =
      `${want} isn't in your package index (newest it offers: ${newestAvailable}) — you're ` +
      `likely behind a mirror or an offline proxy. dxkit captures this class on CI instead, ` +
      `where the toolchain is guaranteed. No action needed.`;
  } else {
    message =
      `${want} isn't available from your package index — likely a mirror or offline proxy that ` +
      `can't reach it. dxkit captures this class on CI instead, where the toolchain is ` +
      `guaranteed. No action needed.`;
  }
  return {
    pkg,
    ...(wanted ? { wanted } : {}),
    ...(newestAvailable ? { newestAvailable } : {}),
    message,
  };
}
