/**
 * Benign security conventions — the ONE source of truth for "this looks like a
 * secret / a committed env file, but it is a near-universal INTENTIONAL
 * convention, not a finding." Every secret / env-in-git detector consults these
 * predicates so the false-positive floor is fixed in one place, not
 * re-litigated per scanner or per language pack.
 *
 * Why this exists (round-3 dogfood, template repos): a `.env.example` is not a
 * leaked `.env`; `password: 'password'` in a seed script and `apiKey =
 * 'your-api-key'` in demo content are not credentials. Left unmodeled, every
 * template-based repo starts its baseline with the same handful of false
 * positives, and every new secret pattern a language pack adds re-introduces
 * them. Centralizing the conventions means a new pack's patterns inherit the
 * exemptions automatically.
 *
 * Design bias: minimize FALSE NEGATIVES. A predicate only returns true for a
 * value/path that is UNAMBIGUOUSLY a placeholder or example convention — never
 * a broad substring match that could swallow a real credential.
 */

/** Filename segments that mark an env file as an example / template — safe to
 *  commit, never a leaked secret. `.env.example`, `.env.sample`,
 *  `.env.template`, `.env.dist`, `.env.defaults`, `.env.local.example`. */
const EXAMPLE_ENV_MARKERS: ReadonlySet<string> = new Set([
  'example',
  'sample',
  'template',
  'tmpl',
  'dist',
  'defaults',
]);

/** The basename of a POSIX/Windows path (no path module — pure + tiny). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Is this an EXAMPLE / template env file (a committed convention), as opposed to
 * a real `.env` / `.env.production` that leaks secrets? Matches a basename that
 * is `env` / `.env` followed by an example marker segment
 * (`.env.example`, `.env.local.sample`, …). A bare `.env` or `.env.production`
 * returns false — those genuinely should count.
 */
export function isExampleEnvFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (!/^\.?env(\.|$)/.test(base)) return false;
  return base.split('.').some((seg) => EXAMPLE_ENV_MARKERS.has(seg));
}

/** Exact placeholder secret values (case-insensitive) — a real credential is
 *  never literally one of these. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'password',
  'passw0rd',
  'changeme',
  'change-me',
  'secret',
  'mysecret',
  'test',
  'testing',
  'example',
  'todo',
  'none',
  'null',
  'undefined',
  'placeholder',
  'dummy',
  'sample',
  'redacted',
  'apikey',
  'api-key',
  'api_key',
  'your-api-key',
  'your_api_key',
  'yourapikey',
  'xxx',
  'xxxx',
]);

/**
 * Does a captured secret VALUE look like an obvious placeholder / demo literal
 * rather than a real credential? True only for values that are unambiguously
 * fake: an exact placeholder token, a bracketed placeholder (`<your-key>`,
 * `${VAR}`, `{{VAR}}`, `%VAR%`), a `your-…` / `…-here` template, or a run of one
 * repeated character (`xxxxx`, `*****`, `00000`). Deliberately narrow to avoid
 * suppressing a real secret that merely contains a common word.
 */
export function isPlaceholderSecret(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  const lower = v.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lower)) return true;
  if (/^[<{$%[].*[>}%\]]$/.test(v)) return true; // <your-key> ${VAR} {{VAR}} %VAR% [redacted]
  if (/^your[-_]/.test(lower)) return true; // your-secret, your_token_here
  if (/[-_](here|goes[-_]?here|placeholder)$/.test(lower)) return true; // token-here, key_goes_here
  if (v.length >= 3 && /^(.)\1+$/.test(v)) return true; // xxxxx, *****, 000000
  return false;
}
