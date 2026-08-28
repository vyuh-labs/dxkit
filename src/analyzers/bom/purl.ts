/**
 * Package-url (purl) derivation for the SBOM export, the ONE home of
 * purl-spec encoding knowledge (Rule 2). The purl TYPE for a BoM row
 * comes from the owning language pack's `purlType` declaration (Rule 6);
 * this module only knows the purl spec's per-type shape rules: which
 * types put what in the namespace, and how segments percent-encode.
 *
 * Honesty contract: `buildPurl` returns null whenever a valid purl
 * cannot be derived from the `(package, version)` pair the gathers
 * carry: an unknown type, or a name that lacks the structure the type
 * requires (a maven name with no `group:artifact` colon, a composer
 * name with no `vendor/name` slash). Callers disclose the omission;
 * they never fabricate a lookalike purl.
 */

/**
 * The purl types this builder can derive from a bare (package, version)
 * pair. Every pack-declared `LanguageSupport.purlType` must appear here,
 * pinned by `test/languages-contract.test.ts` so a pack cannot declare a
 * type the builder would silently fail closed on.
 */
export const SUPPORTED_PURL_TYPES: ReadonlySet<string> = new Set([
  'npm',
  'pypi',
  'golang',
  'cargo',
  'nuget',
  'maven',
  'gem',
  'composer',
]);

/** Percent-encode one purl segment. Everything encodeURIComponent leaves
 *  bare is purl-safe; '@' (npm scopes) and '+' (build metadata in
 *  versions) are the load-bearing encodings. */
function seg(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Derive a purl string, or null when the type is unknown or the package
 * name lacks the structure the type requires. Per-type rules (purl spec):
 *
 * - npm: scoped names split at the '/'; `@scope` is the namespace
 *   (encoded, so `@` becomes `%40`); unscoped names have none.
 * - pypi: PEP 503 normalization (lowercase, `_`/`.` runs fold to `-`).
 * - golang: the module path's last segment is the name, the rest the
 *   namespace (slashes between namespace segments stay literal);
 *   lowercased per spec.
 * - maven: `group:artifact` splits at the colon into namespace + name;
 *   a name with no colon cannot yield a valid maven purl.
 * - composer: `vendor/name` splits at the slash; vendor-less names
 *   cannot yield a valid composer purl.
 * - cargo / gem / nuget: plain name, no namespace.
 */
export function buildPurl(type: string, pkg: string, version: string): string | null {
  if (!pkg || !version || version === 'unknown') return null;
  switch (type) {
    case 'npm': {
      if (pkg.startsWith('@')) {
        const slash = pkg.indexOf('/');
        if (slash <= 1 || slash === pkg.length - 1) return null;
        const scope = pkg.slice(0, slash);
        const name = pkg.slice(slash + 1);
        return `pkg:npm/${seg(scope)}/${seg(name)}@${seg(version)}`;
      }
      return `pkg:npm/${seg(pkg)}@${seg(version)}`;
    }
    case 'pypi': {
      const name = pkg.toLowerCase().replace(/[._]+/g, '-');
      return `pkg:pypi/${seg(name)}@${seg(version)}`;
    }
    case 'golang': {
      const parts = pkg.toLowerCase().split('/').filter(Boolean);
      if (parts.length === 0) return null;
      const name = parts.pop()!;
      const ns = parts.map(seg).join('/');
      return ns
        ? `pkg:golang/${ns}/${seg(name)}@${seg(version)}`
        : `pkg:golang/${seg(name)}@${seg(version)}`;
    }
    case 'maven': {
      const colon = pkg.indexOf(':');
      if (colon <= 0 || colon === pkg.length - 1) return null;
      const group = pkg.slice(0, colon);
      const artifact = pkg.slice(colon + 1);
      if (artifact.includes(':')) return null;
      return `pkg:maven/${seg(group)}/${seg(artifact)}@${seg(version)}`;
    }
    case 'composer': {
      const slash = pkg.indexOf('/');
      if (slash <= 0 || slash === pkg.length - 1) return null;
      const vendor = pkg.slice(0, slash);
      const name = pkg.slice(slash + 1);
      if (name.includes('/')) return null;
      return `pkg:composer/${seg(vendor)}/${seg(name)}@${seg(version)}`;
    }
    case 'cargo':
    case 'gem':
    case 'nuget':
      return `pkg:${type}/${seg(pkg)}@${seg(version)}`;
    default:
      // Fail closed on a type this builder does not model: never emit
      // a guessed shape for an unmodeled ecosystem.
      return null;
  }
}
