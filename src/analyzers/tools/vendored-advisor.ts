/**
 * Advisory detection for files that *look* vendored / external but
 * fell through the dxkit exclusion chain.
 *
 * The bundled `default-exclusions.gitignore` covers the common
 * conventions (`vendor/`, `third_party/`, `third-party/`, `vendored/`,
 * `playground/`, `lexical-playground/`, `node_modules/`, `dist/`, ...)
 * but no curated list can capture every customer's vendored-code
 * organization. A common case the bundled defaults deliberately do
 * NOT exclude is `libs/` — many real codebases (Lerna monorepos, Nx
 * workspaces, npm workspaces) host first-party packages under that
 * directory, so blanket-excluding it would silently hide legitimate
 * source.
 *
 * Instead of forcing a choice between "false-positive exclusions"
 * and "vendored files distorting metrics," this module surfaces
 * customer-visible guidance: when a path that LOOKS vendored slips
 * into a metric like `largestFiles`, the renderer appends a tip
 * pointing at the `.dxkit-ignore` escape hatch. Customers keep
 * authority over what's in scope; we keep the report honest by
 * naming what looks suspicious.
 *
 * Detection is conservative — only path segments that strongly
 * signal vendored code in the wild trigger the advisory. False-
 * positives are acceptable (the tip is advisory, not an action);
 * false-negatives just leave the metric as-is.
 */

/**
 * Path tokens that strongly suggest a file is vendored / external in
 * its containing directory's role. Matched as case-insensitive path
 * segments (`/libs/` matches `public/snapXReditor/libs/colorpicker/`
 * but not a file named `libs-utils.ts`).
 *
 * Keep this list tight — only patterns we've observed in real
 * customer audits as the dominant signal that a path is vendored
 * code the project team doesn't maintain. Patterns that ALSO
 * frequently host first-party source (e.g. `assets/`, `data/`,
 * `examples/`) are deliberately omitted.
 */
const SUSPECT_VENDORED_TOKENS = [
  '/libs/',
  '/colorpicker/',
  '/playground/',
  '/lexical-playground/',
  '/bundled/',
  '/external/',
  '/_vendor/',
  '/third_party/',
  '/third-party/',
  '/vendored/',
];

/**
 * Check if a relative POSIX path contains a suspect-vendored token.
 * Anchors the check with leading slash so `/libs/` matches a directory
 * boundary, not a filename like `libs-helper.ts`.
 */
export function looksVendored(relPath: string): boolean {
  const anchored = ('/' + relPath).toLowerCase();
  return SUSPECT_VENDORED_TOKENS.some((t) => anchored.includes(t));
}

/**
 * Filter a `largestFiles`-shaped list to entries that look vendored.
 * Used by report renderers to emit a single advisory block ("these
 * files look vendored; consider `.dxkit-ignore`") when the top-N
 * leaks suspect paths through.
 */
export function suspectVendoredEntries<T extends { path: string }>(files: ReadonlyArray<T>): T[] {
  return files.filter((f) => looksVendored(f.path));
}
