/**
 * Inlined assets for the `describe` contract map. Kept in one module (like
 * `flow/console-assets.ts`) so the HTML builder stays pure and does no I/O.
 * Two themes (the flow console is dark-only; this is net-new light+dark).
 *
 * The app JS reads the `#dxkit-contract-data` JSON island and draws a
 * vis-network graph of calls → routes, with the seams (unresolved calls,
 * unconsumed routes) colored so they pop in a screenshot. Colors live in JS
 * because vis-network paints to a canvas and cannot read CSS variables.
 */

export const MAP_CSS = `
:root {
  --bg: #ffffff; --panel: #f6f7f9; --border: #e2e5ea; --text: #1b1f27;
  --muted: #5b6270; --accent: #2f6feb;
  --observed: #2e9e5b; --derived: #2f6feb; --inferred: #d98a1f; --unknown: #d1443f;
}
:root[data-theme="dark"] {
  --bg: #0f1117; --panel: #161a22; --border: #262c38; --text: #e6e9ef;
  --muted: #9aa4b2; --accent: #6aa1ff;
  --observed: #46c17b; --derived: #6aa1ff; --inferred: #e3a94a; --unknown: #ff6b64;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1117; --panel: #161a22; --border: #262c38; --text: #e6e9ef;
    --muted: #9aa4b2; --accent: #6aa1ff;
    --observed: #46c17b; --derived: #6aa1ff; --inferred: #e3a94a; --unknown: #ff6b64;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--text); }
header { padding: 18px 22px 10px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 2px; font-size: 18px; }
h1 .sub { color: var(--muted); font-weight: 400; font-size: 14px; }
.prov { color: var(--muted); font-size: 12px; margin-top: 4px; }
.dirty { color: var(--inferred); }
.wrap { display: flex; gap: 0; height: calc(100vh - 92px); min-height: 420px; }
#net { flex: 1 1 auto; min-width: 0; }
aside { width: 320px; flex: 0 0 320px; border-left: 1px solid var(--border);
  overflow-y: auto; padding: 16px; background: var(--panel); }
.stat-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
.chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px;
  font-size: 12px; background: var(--bg); }
.chip b { font-variant-numeric: tabular-nums; }
.seam { border-color: var(--unknown); }
.dead { border-color: var(--inferred); }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
  margin: 18px 0 6px; }
.legend div, .labels div { display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 13px; }
.dot { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; }
.bar { width: 22px; height: 3px; border-radius: 2px; flex: 0 0 auto; }
ul.models { list-style: none; margin: 4px 0; padding: 0; }
ul.models li { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0;
  border-bottom: 1px solid var(--border); font-size: 13px; }
ul.models .tag { color: var(--muted); font-size: 11px; }
.notes { font-size: 12px; color: var(--muted); }
.notes li { margin: 4px 0; }
.toolbar { position: absolute; top: 14px; right: 336px; display: flex; gap: 8px; }
button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
.empty { color: var(--muted); font-style: italic; }
footer { padding: 8px 22px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`;

export const MAP_APP_JS = `
(function () {
  var el = document.getElementById('dxkit-contract-data');
  var DATA = JSON.parse(el.textContent);
  var LABEL_VARS = { observed: '--observed', derived: '--derived', inferred: '--inferred', unknown: '--unknown' };
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
  function labelColor(l) { return cssVar(LABEL_VARS[l] || '--muted'); }

  var net = null;
  function draw() {
    if (typeof vis === 'undefined' || !document.getElementById('net')) return;
    var groupColors = {
      route: cssVar('--observed'),
      'route-dead': cssVar('--inferred'),
      call: cssVar('--accent'),
      'call-unresolved': cssVar('--unknown'),
    };
    var nodes = DATA.nodes.map(function (n) {
      var c = groupColors[n.group] || cssVar('--muted');
      return {
        id: n.id, label: n.label, title: n.title,
        shape: n.group.indexOf('route') === 0 ? 'box' : 'ellipse',
        color: { background: cssVar('--panel'), border: c, highlight: { background: cssVar('--panel'), border: c } },
        borderWidth: (n.group === 'route-dead' || n.group === 'call-unresolved') ? 3 : 1,
        font: { color: cssVar('--text'), size: 13 },
      };
    });
    var edges = DATA.edges.map(function (e) {
      var c = labelColor(e.label);
      return { from: e.from, to: e.to, title: e.label + (e.reason ? ' (' + e.reason + ')' : ''),
        color: { color: c, highlight: c }, dashes: e.label === 'unknown' || e.label === 'inferred',
        arrows: 'to', smooth: { type: 'cubicBezier' } };
    });
    if (net) { net.destroy(); net = null; }
    net = new vis.Network(
      document.getElementById('net'),
      { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
      { layout: { randomSeed: 7 },
        physics: { stabilization: { iterations: 250 }, barnesHut: { springLength: 130 } },
        interaction: { hover: true, tooltipDelay: 120 },
        nodes: { margin: 8 } }
    );
  }

  var toggle = document.getElementById('theme-toggle');
  if (toggle) toggle.addEventListener('click', function () {
    var root = document.documentElement;
    var cur = root.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : (cur === 'light' ? 'dark' : 'light');
    root.setAttribute('data-theme', next);
    draw();
  });

  draw();
})();
`;
