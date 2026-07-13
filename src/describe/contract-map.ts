/**
 * The holistic contract map HTML: dxkit's own deeper call graph JOINED to the
 * HTTP contract layer, across repos. Swimlanes per repo, left→right
 * callers → routes → handlers, seams (broken call / dead route) glowing,
 * cross-repo edges distinct, on-demand expand of each handler's internal +
 * framework calls (the depth graphify drops). Honesty rides on the picture.
 *
 * Pure builder (mirror of `buildFlowConsole`): vis-network bundle passed in,
 * data embedded as an escaped JSON island, no I/O. DETERMINISTIC: node x/y are
 * computed here and physics is off, so the same tree → byte-identical HTML.
 */
import { escapeHtml, serializeDataIsland, safeScriptBody } from '../analyzers/flow/console';
import { MAP_CSS, MAP_APP_JS } from './map-assets';
import type { HolisticGraph } from './holistic';
import type { RepoCardDoc } from './repo-card-schema';

function stat(label: string, value: number | string, cls = ''): string {
  return `<span class="stat ${cls}">${escapeHtml(label)} <b>${escapeHtml(String(value))}</b></span>`;
}

function legend(): string {
  const nodeTypes = [
    ['--observed', 'endpoint — served & consumed'],
    ['--inferred', 'dead route — nothing calls it'],
    ['--unknown', 'broken call — reaches no route'],
    ['--accent', 'cross-repo call'],
    ['--fn', 'function · ×N = calls it makes'],
  ];
  const edgeTypes = [
    ['--fn', 'calls (fn → fn)'],
    ['--observed', 'serves / consumes'],
    ['--derived', 'cross-repo contract'],
  ];
  return (
    nodeTypes
      .map(
        ([v, d]) =>
          `<div class="leg"><span class="dot" style="background:var(${v})"></span>${escapeHtml(d)}</div>`,
      )
      .join('') +
    '<h2>Edges</h2>' +
    edgeTypes
      .map(
        ([v, d]) =>
          `<div class="leg"><span class="bar" style="background:var(${v})"></span>${escapeHtml(d)}</div>`,
      )
      .join('')
  );
}

export interface ContractMapOptions {
  readonly card: RepoCardDoc;
  readonly holistic: HolisticGraph;
  /** vis-network UMD bundle; '' degrades to the panels-only view. */
  readonly visNetworkBundle: string;
}

/** Assemble the self-contained holistic contract-map HTML (pure, deterministic). */
export function buildContractMap(opts: ContractMapOptions): string {
  const { card, holistic, visNetworkBundle } = opts;
  const island = serializeDataIsland({
    nodes: holistic.nodes,
    edges: holistic.edges,
    fns: holistic.fns,
  });

  const d = holistic.depth;
  const s = holistic.seams;
  const depthLine =
    d.functions > 0
      ? `${d.functions.toLocaleString()} functions · ${d.meanFanout} calls/fn · ${(d.internalCalls + d.externalCalls).toLocaleString()} calls mapped`
      : 'no functions resolved';
  const dirty = card.provenance.workingTreeDirty ? ' · uncommitted changes' : '';

  const graphPane = visNetworkBundle
    ? '<div id="net"></div>'
    : '<div id="net"></div><p style="padding:16px;color:var(--muted)">Interactive graph unavailable (built without the vis-network bundle).</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(card.stack.name)} — dxkit contract map</title>
<style>${MAP_CSS}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(card.stack.name)} <span class="sub">holistic contract map</span></h1>
  <div class="prov">${escapeHtml(holistic.repos.join(' · ') || card.stack.name)} · ${escapeHtml(
    card.provenance.branch,
  )}@${escapeHtml(card.provenance.commitSha)}${escapeHtml(dirty)}</div>
  <div class="hero">
    ${stat('routes', holistic.counts.routes)}
    ${stat('calls', holistic.counts.calls)}
    ${s.brokenCalls > 0 ? stat('broken calls', s.brokenCalls, 'seam') : ''}
    ${s.deadRoutes > 0 ? stat('dead routes', s.deadRoutes, 'dead') : ''}
    ${s.crossRepoEdges > 0 ? stat('cross-repo links', s.crossRepoEdges, 'cross') : ''}
    <span class="stat big">🔎 ${escapeHtml(depthLine)}</span>
  </div>
  <div class="disclose">${holistic.notes
    .map((n) => escapeHtml(n))
    .join(' · ')}<span id="cap-note"></span></div>
  <div class="toolbar-in"><input id="search" type="text" placeholder="filter routes / calls…" autocomplete="off" /></div>
</header>
<div class="toolbar">
  <span class="views">
    <button id="v-full" class="view on" type="button">Full code graph</button>
    <button id="v-request" class="view" type="button">Request paths</button>
    <button id="v-seam" class="view" type="button">Seam</button>
  </span>
  <button id="theme-toggle" type="button">Theme</button>
</div>
<div class="wrap">
  ${graphPane}
  <div id="net-msg" class="show"><span class="spin"></span>Loading…</div>
  <aside>
    <h2>Legend</h2>
    ${legend()}
    <h2>How to explore</h2>
    <p class="hint"><b>Double-click</b> a route → its handler → its internal calls, drilling one level deeper each time · <b>drag</b> nodes to explore · <b>click</b> to trace a path · <b>hover</b> to highlight · <b>click empty space</b> to reset.</p>
  </aside>
</div>
<footer>Nothing was written to your repo. Generated by dxkit ${escapeHtml(card.dxkitVersion)} · ${escapeHtml(
    card.generatedAt,
  )}</footer>
<script id="dxkit-contract-data" type="application/json">${island}</script>
${visNetworkBundle ? `<script>${safeScriptBody(visNetworkBundle)}</script>` : ''}
<script>${safeScriptBody(MAP_APP_JS)}</script>
</body>
</html>
`;
}
