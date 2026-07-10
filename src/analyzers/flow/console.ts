/**
 * The interactive flow console — a renderer over `FlowModel` (mirror of
 * `csv.ts`), producing a single self-contained HTML document. It is the
 * higher-value sibling of the CSV renderer (design §E): the UI→API map plus a
 * per-endpoint, browser-side request runner an author or reviewer can exercise.
 *
 * Load-bearing safety design: dxkit stays a STATIC analyzer — this module
 * assembles a document, it never makes an HTTP call. The document is
 * interactive client-side; the base URL and auth token are entered at runtime,
 * live only in the open browser tab, and are never baked into the artifact,
 * committed, logged, or seen by dxkit or CI. The generated HTML carries request
 * TEMPLATES only.
 *
 * Pure over its inputs (`buildFlowConsole` does no I/O): the vis-network bundle
 * is passed in already-read by the CLI layer, so this builder stays testable and
 * deterministic. The endpoint model is assembled from the flow map + optional
 * diff scope + optional gate findings by `console-view.ts`.
 */

import { CONSOLE_APP_JS, CONSOLE_CSS } from './console-assets';

/** One endpoint as the console renders it — a served route plus how the UI
 *  consumes it, and optional per-PR annotations (touched by the diff / broken
 *  by the gate). */
export interface ConsoleEndpoint {
  readonly id: string;
  readonly method: string;
  /** Normalized served path; `{var}` segments become fillable inputs. */
  readonly path: string;
  readonly via: string;
  readonly handler: string | null;
  readonly sourceFile: string;
  readonly line?: number;
  readonly consumerCount: number;
  readonly consumerFiles: readonly string[];
  /** The diff touched this endpoint's served file or a consuming file. */
  readonly affected?: boolean;
  /** The integration gate flagged this endpoint as a net-new break. */
  readonly broken?: { readonly reason: string; readonly verdict: 'block' | 'warn' } | null;
}

export interface FlowConsoleInput {
  readonly repoName?: string;
  readonly generatedAt: string;
  readonly dxkitVersion?: string;
  /** `full` = the whole map; `diff` = only endpoints the PR touches (§E). */
  readonly scope: 'full' | 'diff';
  readonly baseRef?: string;
  readonly diffFileCount?: number;
  readonly endpoints: readonly ConsoleEndpoint[];
  /** Served-but-unconsumed endpoints (dead-route or cross-repo candidates). */
  readonly unconsumed: readonly ConsoleEndpoint[];
  /** Net-new broken integrations the gate flagged for this change (§E: the gate
   *  says WHICH bindings broke, the console lets a reviewer exercise them). Each
   *  is a consumed call whose target route is missing/removed at HEAD, so it has
   *  no served endpoint in the map above — surfaced as its own section. Only
   *  populated in `diff` scope. */
  readonly broken: readonly ConsoleEndpoint[];
  readonly totals: { readonly endpoints: number; readonly bindings: number };
  /** Coverage honesty for the header: recognized call sites whose URL is
   *  dynamic — present in the code, absent from this console (unverifiable). */
  readonly dynamicCallSites?: number;
  /** The bundled vis-network source, or '' to omit the interactive map (the
   *  request runner still works). Injected by the CLI (I/O), so the builder
   *  stays pure. */
  readonly visNetworkBundle: string;
}

/** HTML-escape text destined for element content / attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize the data model for a `<script type="application/json">` island.
 * Escaping `<`/`>`/`&` (and the two line-separator code points JSON leaves raw)
 * makes the payload safe to embed regardless of what file paths or handler names
 * it carries — no string can break out of the script element or inject markup.
 */
export function serializeDataIsland(model: unknown): string {
  return JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Guard the inlined vis-network bundle against a stray `</script>` closing the
 *  surrounding element (mirror of the dashboard's defensive escape). */
function safeScriptBody(js: string): string {
  return js.replace(/<\/script>/gi, '<\\/script>');
}

function scopeLine(input: FlowConsoleInput): string {
  if (input.scope === 'diff') {
    const base = input.baseRef ? ` vs <code>${escapeHtml(input.baseRef)}</code>` : '';
    const files = input.diffFileCount != null ? ` · ${input.diffFileCount} changed file(s)` : '';
    return `Scoped to this change${base}${files} — showing only the integrations it touches.`;
  }
  return 'Full map — every UI→API integration dxkit found in this repo.';
}

/**
 * Assemble the self-contained console HTML. The data model is embedded as a
 * JSON island the inlined app reads; CSS + app JS + (optional) vis-network are
 * inlined so the file opens offline with no external fetch.
 */
export function buildFlowConsole(input: FlowConsoleInput): string {
  const model = {
    meta: {
      repoName: input.repoName ?? null,
      generatedAt: input.generatedAt,
      dxkitVersion: input.dxkitVersion ?? null,
      scope: input.scope,
      baseRef: input.baseRef ?? null,
      diffFileCount: input.diffFileCount ?? null,
    },
    totals: input.totals,
    endpoints: input.endpoints,
    unconsumed: input.unconsumed,
    broken: input.broken,
  };
  const dataIsland = serializeDataIsland(model);
  const visTag = input.visNetworkBundle
    ? `<script>${safeScriptBody(input.visNetworkBundle)}</script>`
    : '';

  const title = input.repoName ? `Flow console — ${escapeHtml(input.repoName)}` : 'Flow console';
  const scopedCount = input.endpoints.length + input.unconsumed.length;

  // The broken-integrations section only makes sense for a diffed view (the
  // gate needs a base to diff against). In full scope it is omitted entirely.
  // Coverage honesty in the header: this console shows what static extraction
  // can see; say plainly what it can't, so "all green" is never over-read.
  const coverageNote =
    input.dynamicCallSites && input.dynamicCallSites > 0
      ? `<div class="dx-safety">${input.dynamicCallSites} recognized call site(s) build their URL at runtime and are not shown here — flow cannot statically verify them (\`doctor --json\` lists their locations under flow.coverage).</div>\n`
      : '';

  const brokenSection =
    input.scope === 'diff'
      ? `  <div class="dx-section-h">Net-new broken integrations</div>
  <div id="dx-broken"></div>
`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${CONSOLE_CSS}</style>
</head>
<body>
<header class="dx-head">
  <h1>${title}</h1>
  <div class="sub">${scopeLine(input)}</div>
</header>

<div class="dx-safety">
  <strong>Runs in your browser.</strong> Enter a Base URL (a dev or staging origin — never prod)
  and, if needed, an auth token below. Both stay only in this tab: they are never committed,
  logged, or sent to dxkit or CI. dxkit generated this page statically and makes no requests
  itself. The API must allow this page's origin (CORS), or open the file against a local/dev server.
</div>

<div class="dx-controls">
  <div class="fld">
    <label for="dx-base">Base URL</label>
    <input id="dx-base" type="url" placeholder="https://staging.example.com" autocomplete="off" spellcheck="false" />
  </div>
  <div class="fld">
    <label for="dx-auth">Authorization header (optional)</label>
    <input id="dx-auth" type="password" placeholder="Bearer …" autocomplete="off" spellcheck="false" />
  </div>
</div>

<div class="dx-summary">
  <div class="stat"><b>${input.totals.endpoints}</b><span>endpoints served</span></div>
  <div class="stat"><b>${input.totals.bindings}</b><span>UI→API bindings</span></div>
  <div class="stat"><b>${scopedCount}</b><span>in this view</span></div>
</div>
${coverageNote}

<div id="dx-graph"></div>

<main>
${brokenSection}  <div class="dx-section-h">Consumed endpoints</div>
  <div id="dx-endpoints"></div>
  <div class="dx-section-h">Served but unconsumed</div>
  <div id="dx-unconsumed"></div>
</main>

<script id="dxkit-flow-data" type="application/json">${dataIsland}</script>
${visTag}
<script>${safeScriptBody(CONSOLE_APP_JS)}</script>
</body>
</html>
`;
}
