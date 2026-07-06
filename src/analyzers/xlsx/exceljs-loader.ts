/**
 * Lazy loader for the OPTIONAL `exceljs` dependency.
 *
 * exceljs is only needed for the `--xlsx` export of the BOM + licenses reports —
 * a niche output format — yet it is a heavy dependency that pulls a vulnerable
 * transitive `uuid@8.3.2`. Shipping it as a hard `dependencies` entry forced it
 * (and that advisory) into EVERY dxkit consumer's tree, even those that never
 * export xlsx. So it's declared as an OPTIONAL peer (npm 7+ does not auto-install
 * it) plus a dxkit devDependency (for dxkit's own build/tests), and loaded here
 * at the call site via a dynamic import. Consumers who want xlsx install it
 * themselves; everyone else never pays for it.
 *
 * Every xlsx builder resolves the module through `loadExcelJS()` (Rule 2 — one
 * loader) so the "not installed" path degrades to a single clear message rather
 * than an unhandled `ERR_MODULE_NOT_FOUND`. Type annotations use a type-only
 * import of `exceljs`, which is erased at compile time and creates no runtime
 * dependency.
 */

/** Thrown when `--xlsx` is requested but the optional `exceljs` package is not
 *  installed. The CLI catches this and prints the install hint (no stack). */
export class XlsxUnavailableError extends Error {
  constructor() {
    super(
      'XLSX export requires the optional "exceljs" package, which is not installed. ' +
        'Add "exceljs" as a dev dependency with your package manager and re-run with ' +
        '--xlsx, or use the JSON report instead.',
    );
    this.name = 'XlsxUnavailableError';
  }
}

/**
 * Dynamically load the exceljs module namespace (it uses `export =`, so its
 * `Workbook` etc. are on the namespace, not a `.default`). Throws
 * {@link XlsxUnavailableError} when the package isn't installed (the only
 * expected failure), so callers can surface a clean hint. The `import('exceljs')`
 * type resolves at compile time via the devDependency; at runtime it fails
 * softly when absent.
 */
export async function loadExcelJS(): Promise<typeof import('exceljs')> {
  try {
    return await import('exceljs');
  } catch {
    throw new XlsxUnavailableError();
  }
}
