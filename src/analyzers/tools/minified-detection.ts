/**
 * Minified / bundled source-file detection.
 *
 * Complements the autogen-header probe by catching another class of
 * machine-emitted files that frequently land in customer
 * `src/` / `public/` trees: minified or bundled JavaScript / CSS.
 * These files are technically "source" by extension but carry no
 * engineering signal — they're build output (webpack / vite /
 * esbuild hash-suffixed chunks), CDN-downloaded libraries dropped
 * into `public/`, or pre-minified vendored editors. When they slip
 * past the standard exclusions they distort:
 *
 *   • `largestFileLines` + `largestFilePath` ("Largest file: 18K
 *     lines" points at a webpack chunk, not a human-authored file)
 *   • `filesOver500Lines` (every minified JS file is one line at
 *     thousands of chars, so doesn't inflate this; but the BUNDLE
 *     CHUNKS that span multiple lines do)
 *   • `densestFile` from graphify (4,000+ functions in a single
 *     minified file)
 *   • Top Files by Size (the table reads as "split these" but the
 *     files are all autogen artifacts)
 *
 * Detection heuristic: read the first ~4KB, count newlines, compare
 * to byte length. If average bytes-per-line crosses a threshold the
 * file is almost certainly minified or a hash-suffixed bundle chunk.
 * Threshold picked at 500 bytes/line — well above typical
 * hand-written source (~80–120 cols, ~100 bytes/line including
 * indentation) and well below typical minified output (often
 * 5,000–50,000 bytes per "line" in single-line minified files, or
 * 200–800 bytes/line in webpack bundles with semicolon-split
 * chunks).
 *
 * Scope: applied to `.js`, `.jsx`, `.mjs`, `.cjs`, `.css`, `.scss`,
 * `.sass`, `.less`. NOT applied to `.ts` / `.tsx` because TS source
 * is rarely minified in-place (the minified output lands in a
 * separate `dist/` directory which is already excluded by the
 * standard ignore list); checking every .ts file would burn I/O
 * for no benefit.
 *
 * Repo-specific autogen that doesn't match this heuristic (e.g.
 * vendor-tool–emitted classes with hand-typeable filenames + no
 * autogen header) is best handled via `.dxkit-ignore` — a per-repo
 * customization the customer maintains.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Extensions where minified content is plausibly present in the source tree. */
const MINIFIABLE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
]);

/** Bytes-per-line floor above which the file is almost certainly
 *  minified / bundled. Calibrated to admit hand-written code at any
 *  reasonable line length while rejecting any minifier output. */
const MIN_BYTES_PER_LINE_FOR_MINIFIED = 500;

/** Sample size — large enough to get reliable line statistics on
 *  even the shortest minified chunk, small enough to keep the I/O
 *  cost negligible vs. the existing autogen-header probe. */
const SAMPLE_BYTES = 4096;

/**
 * True when the file at `absPath` looks like minified / bundled
 * output by the bytes-per-line heuristic. Returns false on read
 * errors or for files whose extension isn't in
 * `MINIFIABLE_EXTENSIONS` — over-include is preferable to silently
 * dropping legit source.
 */
export function isLikelyMinified(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  if (!MINIFIABLE_EXTENSIONS.has(ext)) return false;

  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(SAMPLE_BYTES);
    const n = fs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
    if (n === 0) return false;
    // Count newlines in the sample. A single-line file with N bytes
    // and zero newlines reports bytesPerLine = N (way above the
    // floor). A normal source file with N bytes and N/100 newlines
    // reports ~100 bytes/line.
    let newlines = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0x0a) newlines++;
    }
    const linesInSample = Math.max(1, newlines);
    const bytesPerLine = n / linesInSample;
    return bytesPerLine >= MIN_BYTES_PER_LINE_FOR_MINIFIED;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
