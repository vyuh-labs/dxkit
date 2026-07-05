/**
 * Dashboard graph-viz tab renderer — embeds graphify's vis.js viewer.
 *
 * Sprint 3 pivot (2026-05-27): rather than build a custom cytoscape
 * tier drill-down, we embed the interactive viewer graphify itself
 * ships. The upstream `graphify.export.to_html` writes a self-
 * contained vis.js HTML page to `.dxkit/reports/graph.html` as a
 * side-effect of `gatherGraphifyGraph` (see `analyzers/tools/
 * graphify.ts`). This renderer:
 *
 *   1. reads that HTML
 *   2. swaps graphify's unpkg.com `<script src=…vis-network…>` tag for
 *      an inline `<script>` containing the locally-bundled
 *      `vis-network.min.js` (offline-friendly per dxkit's posture —
 *      no third-party fetch when the user opens the dashboard)
 *   3. emits the swapped HTML inside an `<iframe srcdoc>` so the
 *      embedded viewer's CSS + JS namespace stays isolated from the
 *      host dashboard
 *
 * Empty-state branches when `graph.html` is missing (gather never
 * ran, graph exceeded the 5000-node viz cap, etc.). Vendor-missing
 * branch when `dist/dashboard/vendor/vis-network.min.js` is absent
 * (`npm run build` hasn't run).
 *
 * Per CLAUDE.md Rule 12, we still flow `graph.json` reads through
 * `loadGraph` even though the renderer doesn't consume `graph.json`
 * itself — the loader doubles as our existence check before we go
 * read `graph.html` off disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadGraph } from '../explore/load';
import { dxkitCli } from '../self-invocation';
import { VENDOR_DIR, readVisNetworkBundle } from './vendor';

/** Default report location, relative to cwd. (Vendor dir lives in `vendor.ts`.) */
const GRAPH_HTML_REL = path.join('.dxkit', 'reports', 'graph.html');

/** Options accepted by the tab renderer. */
export interface GraphTabOptions {
  /**
   * Project root. The renderer reads `.dxkit/reports/graph.json` for
   * the existence check (via Rule 12's `loadGraph`) and then loads
   * `.dxkit/reports/graph.html` from disk for embedding.
   */
  cwd?: string;
  /**
   * Override the vendor directory. Tests pass a tmpdir with a fake
   * `vis-network.min.js` so they don't depend on `npm run build`
   * having populated `dist/dashboard/vendor/`.
   */
  vendorDir?: string;
  /**
   * Override the on-disk path to graphify's `graph.html`. Defaults
   * to `<cwd>/.dxkit/reports/graph.html`. Tests use a fixture path.
   */
  graphHtmlPath?: string;
}

/**
 * One-stop renderer. Returns:
 *   - `html`: the HTML fragment to splice into the dashboard body
 *     (the new "Graph" tab pane).
 *   - `navBadge`: the badge text the sidebar shows next to "Graph"
 *     (community count when ready; "—" otherwise).
 *   - `hasData`: convenience boolean — true when a viewable graph
 *     was found and the iframe will render.
 */
export function renderGraphTab(opts: GraphTabOptions): {
  html: string;
  navBadge: string;
  hasData: boolean;
} {
  const cwd = opts.cwd;
  const graphHtmlPath = opts.graphHtmlPath ?? (cwd ? path.join(cwd, GRAPH_HTML_REL) : '');
  const vendorDir = opts.vendorDir ?? VENDOR_DIR;

  // Rule-12-friendly existence check via the canonical loader. Failure
  // = missing/corrupt graph.json = empty state regardless of whether
  // graph.html happens to be on disk.
  let communityCount = 0;
  if (cwd) {
    try {
      const graph = loadGraph(cwd);
      communityCount = graph.communities.length;
    } catch {
      // fall through to empty-state
    }
  }

  if (!cwd || communityCount === 0) {
    return {
      html: renderEmptyState('No graph data found.', emptyStateMessage()),
      navBadge: '—',
      hasData: false,
    };
  }

  if (!graphHtmlPath || !fs.existsSync(graphHtmlPath)) {
    // Graph.json exists but graph.html doesn't — the gather ran but
    // skipped the viz emission (most likely the 5000-node MAX_NODES_FOR_VIZ
    // guard tripped, or graphify is too old to know about to_html). Tell
    // the user what we know.
    return {
      html: renderEmptyState(
        'Interactive viewer skipped.',
        `Graph data exists (\`.dxkit/reports/graph.json\`, ${communityCount} communities) but graphify's interactive viewer wasn't generated. Common causes: the graph exceeds graphify's 5000-node viewer cap, or the installed graphify is older than v0.5 (run \`${dxkitCli('tools install')}\` to refresh).`,
      ),
      navBadge: String(communityCount),
      hasData: false,
    };
  }

  const visBundle = readVisNetworkBundle(vendorDir);
  if (!visBundle) {
    return {
      html: renderEmptyState(
        'vis-network bundle missing.',
        'The dashboard ships an offline-friendly vis-network alongside the graphify viewer; the bundle at `dist/dashboard/vendor/vis-network.min.js` is not present. This typically means dxkit was built without `npm run build`. Run the build and regenerate the dashboard.',
      ),
      navBadge: String(communityCount),
      hasData: false,
    };
  }

  let upstreamHtml: string;
  try {
    upstreamHtml = fs.readFileSync(graphHtmlPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      html: renderEmptyState('Failed to read graph.html.', `Error: ${msg}`),
      navBadge: '—',
      hasData: false,
    };
  }

  // Read the sidecar meta if present so we can surface "aggregated view"
  // honestly to the user. Absent meta = older graphify run before the
  // sidecar landed; treat as 'full' and skip the banner.
  const meta = readGraphHtmlMeta(graphHtmlPath);
  const annotatedHtml =
    meta?.mode === 'aggregated' ? injectAggregateBanner(upstreamHtml, meta) : upstreamHtml;

  const offlineHtml = inlineVisNetwork(annotatedHtml, visBundle);
  const iframe = buildSrcdocIframe(offlineHtml);

  return {
    html: `<div id="graph-tab-pane" class="graph-tab-pane" style="display:none">${iframe}</div>`,
    navBadge: String(communityCount),
    hasData: true,
  };
}

// ─── HTML manipulation ───────────────────────────────────────────────────────

/** Sidecar metadata produced by the graphify gather. */
interface GraphHtmlMeta {
  mode: 'full' | 'aggregated';
  totalNodes: number;
  totalEdges: number;
  communities: number;
  aggregatedNodeCount: number | null;
}

function readGraphHtmlMeta(graphHtmlPath: string): GraphHtmlMeta | undefined {
  const metaPath = `${graphHtmlPath}.meta.json`;
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'mode' in parsed &&
      (parsed as { mode: unknown }).mode &&
      typeof (parsed as { mode: unknown }).mode === 'string'
    ) {
      return parsed as GraphHtmlMeta;
    }
  } catch {
    // ignore — absent/corrupt meta = no banner, viewer still works
  }
  return undefined;
}

/**
 * Prepend a small banner inside graphify's `<body>` explaining that
 * the visible view is community-aggregated. Surfaced for honesty —
 * the user should understand each node is a cluster, not a symbol,
 * when the full graph exceeded the 5000-node viz cap.
 *
 * Exported for tests.
 */
export function injectAggregateBanner(html: string, meta: GraphHtmlMeta): string {
  const banner = `
<div id="dxkit-aggregated-banner" style="position:fixed;top:8px;left:8px;right:300px;z-index:1000;padding:10px 14px;background:rgba(78,121,167,0.92);color:#fff;border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:1.45;box-shadow:0 2px 8px rgba(0,0,0,0.4);">
  <strong>Community-aggregated view.</strong>
  Each node is a Louvain cluster of related symbols, not an individual symbol — the full graph (${meta.totalNodes.toLocaleString()} symbols, ${meta.totalEdges.toLocaleString()} edges) exceeds vis.js's 5,000-node interactive cap.
  Showing ${meta.communities.toLocaleString()} communities; node size = member count.
  Use <code style="background:rgba(255,255,255,0.18);padding:1px 5px;border-radius:3px;">${dxkitCli('explore')}</code> to drill into a specific community.
</div>`;
  // Inject right after <body> so the banner sits above the canvas
  // without disturbing graphify's existing flex layout.
  const bodyIdx = html.indexOf('<body');
  if (bodyIdx === -1) return html;
  const tagEnd = html.indexOf('>', bodyIdx);
  if (tagEnd === -1) return html;
  return html.slice(0, tagEnd + 1) + banner + html.slice(tagEnd + 1);
}

/**
 * Replace graphify's `<script src="https://unpkg.com/vis-network/...">`
 * with an inline `<script>` containing the bundled vis-network source.
 * The replacement is conservative — we match the upstream tag exactly
 * (with optional version pin + path variations) and bail to the
 * untouched HTML if the pattern doesn't fit. That way an upstream
 * graphify change to a different CDN URL is surfaced as "viewer works
 * online only" rather than a corrupt swap.
 *
 * Exported for tests; downstream consumers should use `renderGraphTab`.
 */
export function inlineVisNetwork(upstreamHtml: string, visBundle: string): string {
  // Conservative match for the upstream HTML's
  // `<script ... src="...vis-network...">` tag. Inline-script body is
  // JS, so a `<` inside the bundle would close the surrounding
  // <script> tag prematurely if we naively concatenated —
  // vis-network's minified UMD doesn't contain `</script>` substrings,
  // but defensively escape just in case.
  const safeBundle = visBundle.replace(/<\/script>/gi, '<\\/script>');
  const inline = `<script>${safeBundle}</script>`;
  const pattern = /<script\b[^>]*\bsrc=(["'])[^"']*vis-network[^"']*\1[^>]*><\/script>/i;
  if (!pattern.test(upstreamHtml)) {
    // No CDN script to swap. Return upstream verbatim — graphify either
    // already bundles vis-network or the upstream format changed; in
    // either case our offline-conversion is a no-op rather than a corruption.
    return upstreamHtml;
  }
  // Use a function-form replacement so $1/$&/$' inside the bundle source
  // are not interpreted as `replace`'s magic backreferences. vis-network's
  // minified UMD contains `"$1"` (a regex capture-group reference inside
  // a string literal); a bare string replacement would silently eat it
  // and corrupt the bundle.
  return upstreamHtml.replace(pattern, () => inline);
}

/**
 * HTML-encode the supplied HTML so it can sit safely inside an
 * `<iframe srcdoc="…">` attribute. Only the characters that
 * specifically break the attribute boundary — `&`, `"`, and `<` — get
 * escaped. (`<` would prematurely close the iframe's start tag in the
 * outer document if naive UTF-8 left it unescaped.)
 */
export function encodeForSrcdoc(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function buildSrcdocIframe(html: string): string {
  const encoded = encodeForSrcdoc(html);
  return `<iframe
  id="graph-iframe"
  class="graph-iframe"
  title="Code graph — interactive viewer"
  loading="lazy"
  sandbox="allow-scripts allow-same-origin"
  srcdoc="${encoded}"
></iframe>`;
}

// ─── Empty-state rendering ───────────────────────────────────────────────────

function emptyStateMessage(): string {
  return (
    'Run `' +
    dxkitCli('health .') +
    '` to generate the repo graph (graphify produces `.dxkit/reports/graph.json` + `graph.html` automatically), then reload this dashboard.'
  );
}

function renderEmptyState(headline: string, body: string): string {
  return `<div id="graph-tab-pane" class="graph-tab-pane graph-tab-empty" style="display:none">
  <div class="graph-empty-card">
    <div class="graph-empty-icon">🗺️</div>
    <h2>${escapeHtml(headline)}</h2>
    <p>${body}</p>
  </div>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Embedded CSS (spliced into the host dashboard's style block) ────────────

/**
 * CSS for the graph tab. The host dashboard at
 * `src/analyzers/dashboard/index.ts` splices this into its global
 * `<style>` block via a sibling import. The iframe gets a fixed-height
 * fill of the tab area; the empty-state card centers vertically.
 */
export const GRAPH_TAB_CSS = `
.graph-tab-pane { flex: 1; flex-direction: column; padding: 24px 28px; overflow: hidden; }
.graph-tab-empty.graph-tab-pane { display: flex; align-items: center; justify-content: center; min-height: 400px; padding: 60px 32px; }
.graph-empty-card { text-align: center; padding: 48px 32px; background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border); max-width: 640px; }
.graph-empty-icon { font-size: 56px; margin-bottom: 16px; }
.graph-empty-card h2 { font-size: 22px; color: var(--text-primary); margin-bottom: 12px; }
.graph-empty-card p { color: var(--text-secondary); line-height: 1.55; }
.graph-empty-card code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; }
.graph-iframe { width: 100%; height: 100%; min-height: 600px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); }
`;
