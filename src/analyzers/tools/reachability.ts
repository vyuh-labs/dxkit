/**
 * Reachability analysis for dependency vulnerabilities.
 *
 * Answers the triage question "does *my* code actually touch this
 * vulnerable package, anywhere?". A critical CVE in `axios` is
 * meaningful if `import from 'axios'` exists somewhere in my source;
 * it's usually inert noise if axios is a transitive dev-dep nothing
 * actually loads.
 *
 * Input is the aggregated `ImportsResult` (language packs already
 * extract per-file specifiers; the dispatcher unions them). Output is
 * a boolean per `DepVulnFinding.reachable`.
 *
 * Matching is *coarse* — name-level, not call-graph level. Importing
 * `lodash` flags every lodash finding as reachable even if the call
 * sites only touch safe paths. A precise per-advisory reachability
 * check (Snyk-style AST walking into the package itself) belongs in
 * 10h.8 (optional snyk overlay); this module is the OSS-only
 * predecessor the rest of dxkit ships with.
 *
 * Pure functions so renders can be tested without filesystem.
 */

import type { DepVulnFinding, ImportsResult } from '../../languages/capabilities/types';

/**
 * Project an import specifier to the external package name it
 * references, or null for relative / absolute / protocol specifiers.
 *
 * Handles three ecosystems consistently:
 *
 *   - npm scoped: `@scope/name` or `@scope/name/subpath` → `@scope/name`
 *   - npm bare:   `lodash` or `lodash/get` → `lodash`
 *   - Python:     `foo.bar.baz` (from ImportsResult's raw specifier
 *                 form) → `foo` (top-level module is the package name)
 *   - Go:         `github.com/user/repo/subpkg` → `github.com/user/repo`
 *                 (3-slash module-path convention; detected by the
 *                 dotted first segment)
 *   - Rust / C#:  not reliably mapped (crate paths / namespaces
 *                 don't equal package names). Rust's `use serde`
 *                 does resolve though, since `serde` is both crate
 *                 and extracted specifier.
 *
 * Pure; exported for unit tests.
 */
export function specifierToPackage(spec: string): string | null {
  if (!spec) return null;
  // Relative or absolute paths aren't external deps.
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  // URLs / protocol imports aren't deps either.
  if (spec.includes('://')) return null;

  // Scoped npm: @scope/name, @scope/name/subpath
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }

  const slashParts = spec.split('/');

  // Go module convention: first segment has a dot (github.com, golang.org,
  // gitlab.com) → keep 3-segment module path.
  if (slashParts[0].includes('.') && slashParts.length >= 3) {
    return slashParts.slice(0, 3).join('/');
  }

  // TS bare (`lodash`, `lodash/get`) or Python dotted (`foo.bar`,
  // `foo`) — top-level module name is everything before the first
  // `/` or `.`.
  return slashParts[0].split('.')[0];
}

/**
 * Build a set of external package names referenced from anywhere in
 * the repo's source. Empty set is safe — means "no imports parsed",
 * which callers treat as "reachability unknown" (leave findings'
 * `reachable` unset rather than mass-false).
 */
export function buildReachablePackageSet(imports: ImportsResult): Set<string> {
  const set = new Set<string>();
  for (const specs of imports.extracted.values()) {
    for (const spec of specs) {
      const pkg = specifierToPackage(spec);
      if (pkg) set.add(pkg);
    }
  }
  return set;
}

/**
 * Annotate every finding's `reachable` field. `true` when the finding's
 * `package` is in the reachable set; `false` otherwise. Unsetting is
 * intentionally avoided — we always classify once the set is built,
 * because an empty set (no imports parsed) skips this helper entirely
 * at the call site in `gatherDepVulns`.
 */
export function markReachable(findings: DepVulnFinding[], reachable: ReadonlySet<string>): void {
  for (const f of findings) {
    f.reachable = reachable.has(f.package);
  }
}
