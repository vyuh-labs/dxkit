/**
 * The `describe` contract map: a self-contained, screenshot-worthy HTML view
 * of a repo's HTTP seams. Calls → routes, verdict-colored by how confidently
 * dxkit bound them, with the two seam classes (a call that reaches no route,
 * a route nothing calls) drawn to stand out. Honesty is printed on the
 * picture: the epistemic-label legend and the disclosure notes ride along.
 *
 * Pure builder (mirror of `buildFlowConsole`): the vis-network bundle is
 * passed in (the CLI pre-reads it), the data model is embedded as an escaped
 * JSON island, and no file I/O happens here. Deterministic output: nodes and
 * edges are sorted and the layout seed is fixed, so two runs on the same tree
 * produce byte-identical HTML (screenshot-stable).
 */
import { escapeHtml, serializeDataIsland, safeScriptBody } from '../analyzers/flow/console';
import { labelForBinding } from './repo-card';
import { MAP_CSS, MAP_APP_JS } from './map-assets';
import type { DescribeInput } from './gather';
import type { RepoCardDoc } from './repo-card-schema';
import type { EpistemicLabel } from '../evidence/conventions';

export interface ContractMapNode {
  readonly id: string;
  readonly label: string;
  readonly group: 'route' | 'route-dead' | 'call' | 'call-unresolved';
  readonly title: string;
}
export interface ContractMapEdge {
  readonly from: string;
  readonly to: string;
  readonly label: EpistemicLabel;
  readonly reason: string;
}
export interface ContractMapGraph {
  readonly nodes: readonly ContractMapNode[];
  readonly edges: readonly ContractMapEdge[];
}

const MAX_LABEL = 48;
const clip = (s: string): string => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s);
const routeKey = (method: string, path: string): string => `r|${method}|${path}`;
const callKey = (method: string, target: string): string => `c|${method}|${target}`;

/** Project the flow model into a call→route seam graph (pure, deterministic). */
export function projectContractMap(input: DescribeInput): ContractMapGraph {
  const { flow } = input;

  const routes = new Map<string, { node: ContractMapNode; consumed: boolean }>();
  for (const r of flow.routes) {
    const id = routeKey(r.method, r.path);
    if (routes.has(id)) continue;
    routes.set(id, {
      consumed: false,
      node: {
        id,
        label: clip(`${r.method} ${r.path}`),
        group: 'route',
        title: `served · via ${r.via} · ${r.file}:${r.line}`,
      },
    });
  }

  const calls = new Map<string, ContractMapNode>();
  const edgeSet = new Map<string, ContractMapEdge>();
  for (const b of flow.bindings) {
    const target = b.call.path ?? b.call.rawUrl;
    const cid = callKey(b.call.method, target);
    const resolved = b.route !== null;
    const prev = calls.get(cid);
    // A call target is "resolved" if ANY of its bindings resolved.
    if (!prev || (resolved && prev.group === 'call-unresolved')) {
      calls.set(cid, {
        id: cid,
        label: clip(`${b.call.method} ${target}`),
        group: resolved ? 'call' : 'call-unresolved',
        title: `calls · ${b.reason} · ${b.call.file}:${b.call.line}`,
      });
    }
    if (b.route) {
      const rid = routeKey(b.route.method, b.route.path);
      const entry = routes.get(rid);
      if (entry) entry.consumed = true;
      const label = labelForBinding(b.reason);
      const ekey = `${cid}>${rid}|${label}`;
      if (!edgeSet.has(ekey)) edgeSet.set(ekey, { from: cid, to: rid, label, reason: b.reason });
    }
  }

  // Dynamic call sites: unknown by construction, shown so the honesty is visual.
  for (const d of flow.dynamicCalls) {
    const cid = `d|${d.file}|${d.line}`;
    calls.set(cid, {
      id: cid,
      label: clip(`${d.receiver} (dynamic)`),
      group: 'call-unresolved',
      title: `dynamic URL (resolved at runtime) · ${d.file}:${d.line}`,
    });
  }

  const routeNodes: ContractMapNode[] = [...routes.values()].map(({ node, consumed }) =>
    consumed ? node : { ...node, group: 'route-dead', title: node.title + ' · unconsumed' },
  );
  const nodes = [...routeNodes, ...calls.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeSet.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.label.localeCompare(b.label),
  );
  return { nodes, edges };
}

function chip(label: string, value: number, cls = ''): string {
  return `<span class="chip ${cls}">${escapeHtml(label)} <b>${value}</b></span>`;
}

function labelLegend(): string {
  const rows: Array<[EpistemicLabel, string]> = [
    ['observed', 'dxkit parsed it'],
    ['derived', 'from a declared contract'],
    ['inferred', 'heuristic (has confidence)'],
    ['unknown', 'exists, unresolvable'],
  ];
  return rows
    .map(
      ([l, d]) =>
        `<div><span class="bar" style="background:var(--${l})"></span><b>${l}</b> — ${escapeHtml(d)}</div>`,
    )
    .join('');
}

function modelsList(card: RepoCardDoc, input: DescribeInput): string {
  const models = input.models.models;
  if (models.length === 0 && input.models.dynamicModels.length === 0)
    return '<p class="empty">No data models declared.</p>';
  const rows = [...models]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (m) =>
        `<li><span>${escapeHtml(m.name)}</span><span class="tag">${escapeHtml(m.via)} · ${m.fields.length} field(s)</span></li>`,
    )
    .join('');
  const dyn = input.models.dynamicModels.length
    ? `<li><span class="empty">${input.models.dynamicModels.length} runtime-shaped model(s)</span><span class="tag">unknown</span></li>`
    : '';
  void card;
  return `<ul class="models">${rows}${dyn}</ul>`;
}

export interface ContractMapOptions {
  readonly card: RepoCardDoc;
  readonly input: DescribeInput;
  readonly graph: ContractMapGraph;
  /** vis-network UMD bundle; '' degrades to the panels-only view. */
  readonly visNetworkBundle: string;
}

/** Assemble the self-contained contract-map HTML (pure). */
export function buildContractMap(opts: ContractMapOptions): string {
  const { card, input, graph, visNetworkBundle } = opts;
  const island = serializeDataIsland({ nodes: graph.nodes, edges: graph.edges });
  const dirty = card.provenance.workingTreeDirty
    ? ' <span class="dirty">· uncommitted changes</span>'
    : '';
  const notes = card.notes.length
    ? `<ul class="notes">${card.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '<p class="empty">No disclosures — the picture is fully observed.</p>';
  const graphPane = visNetworkBundle
    ? '<div id="net"></div>'
    : '<div id="net"></div><p class="empty" style="padding:16px">Interactive graph unavailable (dxkit built without the vis-network bundle). Counts and lists below are complete.</p>';

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
  <h1>${escapeHtml(card.stack.name)} <span class="sub">contract map</span></h1>
  <div class="prov">${escapeHtml(card.stack.languages.join(', ') || 'unknown stack')}${
    card.stack.framework ? ` · ${escapeHtml(card.stack.framework)}` : ''
  } · ${escapeHtml(card.provenance.branch)}@${escapeHtml(card.provenance.commitSha)}${dirty}</div>
  <div class="stat-row">
    ${chip('routes', card.flow.routes.total)}
    ${chip('calls', card.flow.calls.total)}
    ${chip('unresolved calls', card.flow.unresolvedCalls, 'seam')}
    ${chip('unconsumed routes', card.flow.unconsumedRoutes, 'dead')}
    ${chip('models', card.models.models.total)}
  </div>
</header>
<div class="toolbar"><button id="theme-toggle" type="button">Toggle theme</button></div>
<div class="wrap">
  ${graphPane}
  <aside>
    <h2>Node types</h2>
    <div class="legend">
      <div><span class="dot" style="background:var(--observed)"></span>served route</div>
      <div><span class="dot" style="background:var(--inferred)"></span>unconsumed route (dead surface)</div>
      <div><span class="dot" style="background:var(--accent)"></span>client call</div>
      <div><span class="dot" style="background:var(--unknown)"></span>unresolved call (integration gap)</div>
    </div>
    <h2>Edge confidence</h2>
    <div class="labels">${labelLegend()}</div>
    <h2>Data models</h2>
    ${modelsList(card, input)}
    <h2>Honesty</h2>
    ${notes}
  </aside>
</div>
<footer>Nothing was written to your repo. Generated by dxkit ${escapeHtml(
    card.dxkitVersion,
  )} · ${escapeHtml(card.generatedAt)}</footer>
<script id="dxkit-contract-data" type="application/json">${island}</script>
${visNetworkBundle ? `<script>${safeScriptBody(visNetworkBundle)}</script>` : ''}
<script>${safeScriptBody(MAP_APP_JS)}</script>
</body>
</html>
`;
}
