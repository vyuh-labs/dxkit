/**
 * Shared vis-network vendor bundle reader — the ONE place that locates and
 * reads the offline-friendly `vis-network.min.js` dxkit ships alongside the
 * dashboard (Rule 2: one gather per external asset). Both the dashboard graph
 * tab (which swaps graphify's CDN `<script>` for this bundle) and the flow
 * console (which builds its own vis-network view) read the bundle through here,
 * so neither re-derives the vendor path or the missing-bundle fallback.
 *
 * `scripts/copy-templates.js` copies the bundle from `node_modules/vis-network`
 * into `dist/dashboard/vendor/` at build time; `__dirname` resolves to
 * `dist/dashboard` at runtime, so the default `VENDOR_DIR` points at that copy.
 * A missing bundle (dxkit built without `npm run build`) returns `undefined`
 * rather than throwing — the consumer degrades gracefully (an offline-only
 * note, or a list-only flow view).
 */

import * as fs from 'fs';
import * as path from 'path';

/** The bundled vis-network location, relative to the compiled module. */
export const VENDOR_DIR = path.join(__dirname, 'vendor');

/**
 * Read the bundled `vis-network.min.js`, or `undefined` when it is absent.
 * `vendorDir` is overridable so tests can point at a fixture without depending
 * on a real build having populated `dist/`.
 */
export function readVisNetworkBundle(vendorDir: string = VENDOR_DIR): string | undefined {
  const file = path.join(vendorDir, 'vis-network.min.js');
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf-8');
}
