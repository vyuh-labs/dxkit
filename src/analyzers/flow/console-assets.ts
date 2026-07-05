/**
 * Client-side assets for the interactive flow console — the CSS and the vanilla
 * JS app that render the console from its embedded JSON data island. Kept out of
 * `console.ts` so the pure HTML assembler stays small and the browser app reads
 * as one self-contained program.
 *
 * The app is deliberately dependency-free (beyond the optional bundled
 * vis-network the assembler inlines): it reads `#dxkit-flow-data`, builds the
 * endpoint cards + request runner, and — when the vis bundle is present — draws
 * the UI→API map. The request runner makes calls FROM THE BROWSER only; the base
 * URL and auth token are entered at runtime, live solely in the open tab, and
 * are never persisted, logged, or seen by dxkit or CI (design §E). dxkit itself
 * makes zero HTTP calls — it only generates this document.
 */

/** Console stylesheet — spliced into the document `<head>` by the assembler. */
export const CONSOLE_CSS = `
:root {
  --bg: #0f1117; --bg-card: #171a21; --bg-2: #1e222b; --border: #2a2f3a;
  --text: #e6e9ef; --text-dim: #9aa3b2; --accent: #4e79a7;
  --get: #59a14f; --post: #4e79a7; --put: #edc948; --patch: #b07aa1;
  --delete: #e15759; --other: #8c8c8c;
  --broken: #e15759; --affected: #edc948;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5; }
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
header.dx-head { padding: 20px 28px; border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, #12151c, var(--bg)); }
header.dx-head h1 { margin: 0 0 4px; font-size: 19px; }
header.dx-head .sub { color: var(--text-dim); font-size: 13px; }
.dx-safety { margin: 12px 28px 0; padding: 10px 14px; border-radius: 8px;
  background: rgba(78,121,167,0.12); border: 1px solid rgba(78,121,167,0.35);
  color: var(--text-dim); font-size: 12.5px; }
.dx-safety strong { color: var(--text); }
.dx-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end;
  padding: 16px 28px; border-bottom: 1px solid var(--border); }
.dx-controls .fld { display: flex; flex-direction: column; gap: 4px; }
.dx-controls label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--text-dim); }
input, textarea, select { background: var(--bg-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px;
  font-size: 13px; font-family: inherit; }
input:focus, textarea:focus { outline: 1px solid var(--accent); }
.dx-controls input { min-width: 260px; }
textarea { width: 100%; resize: vertical; min-height: 60px; }
.dx-summary { display: flex; gap: 22px; padding: 14px 28px; flex-wrap: wrap;
  border-bottom: 1px solid var(--border); }
.dx-summary .stat b { font-size: 20px; } .dx-summary .stat span { color: var(--text-dim);
  font-size: 12px; display: block; }
#dx-graph { height: 360px; margin: 0; border-bottom: 1px solid var(--border);
  background: var(--bg); }
#dx-graph.empty { height: auto; padding: 14px 28px; color: var(--text-dim); font-size: 12.5px; }
main { padding: 8px 28px 60px; }
.dx-section-h { margin: 22px 0 8px; font-size: 13px; text-transform: uppercase;
  letter-spacing: .05em; color: var(--text-dim); }
.ep { border: 1px solid var(--border); border-radius: 10px; margin: 10px 0;
  background: var(--bg-card); overflow: hidden; }
.ep.broken { border-color: var(--broken); }
.ep.affected { border-color: var(--affected); }
.ep-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
  cursor: pointer; user-select: none; }
.ep-head:hover { background: var(--bg-2); }
.verb { font-weight: 700; font-size: 11px; padding: 3px 8px; border-radius: 5px;
  color: #0f1117; min-width: 52px; text-align: center; }
.verb.GET { background: var(--get); } .verb.POST { background: var(--post); color:#fff;}
.verb.PUT { background: var(--put); } .verb.PATCH { background: var(--patch); color:#fff;}
.verb.DELETE { background: var(--delete); color:#fff;} .verb.OTHER { background: var(--other); }
.ep-path { font-weight: 600; }
.ep-tags { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.tag { font-size: 11px; padding: 2px 7px; border-radius: 20px; background: var(--bg-2);
  color: var(--text-dim); }
.tag.broken { background: rgba(225,87,89,0.18); color: #ff9a9b; }
.tag.affected { background: rgba(237,201,72,0.18); color: #f0d86b; }
.ep-body { padding: 0 14px 14px; display: none; }
.ep.open .ep-body { display: block; }
.ep-meta { color: var(--text-dim); font-size: 12.5px; margin: 4px 0 12px; }
.ep-meta .brk { color: #ff9a9b; }
.runner { display: grid; gap: 10px; }
.runner .row { display: flex; gap: 10px; flex-wrap: wrap; }
.runner .fld { display: flex; flex-direction: column; gap: 4px; flex: 1 1 180px; }
.runner label { font-size: 11px; color: var(--text-dim); }
.btn { background: var(--accent); color: #fff; border: none; border-radius: 6px;
  padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; align-self: flex-start; }
.btn:hover { filter: brightness(1.1); } .btn:disabled { opacity: .5; cursor: default; }
.resp { margin-top: 6px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); display: none; }
.resp.show { display: block; }
.resp .status { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.resp .status.ok { color: #8fd18a; } .resp .status.err { color: #ff9a9b; }
.resp pre { margin: 0; padding: 12px; overflow: auto; max-height: 300px; font-size: 12px;
  white-space: pre-wrap; word-break: break-word; }
.consumers { font-size: 12px; color: var(--text-dim); margin-top: 10px; }
.consumers .f { display: block; }
.empty-note { color: var(--text-dim); font-style: italic; padding: 8px 0; }
`;

/**
 * The browser app. Reads the JSON data island, renders the summary + request
 * runner cards, and — when `window.vis` (the inlined bundle) is present — draws
 * the flow map. Written as a plain IIFE string so the assembler can inline it
 * without a build step; it references no module system and no external globals
 * beyond the optional `vis`.
 */
export const CONSOLE_APP_JS = `
(function () {
  "use strict";
  var el = document.getElementById("dxkit-flow-data");
  var DATA = {};
  try { DATA = JSON.parse(el.textContent); } catch (e) { DATA = { endpoints: [], unconsumed: [], meta: {}, totals: {} }; }
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var verbClass = function (m) {
    return ["GET", "POST", "PUT", "PATCH", "DELETE"].indexOf(String(m).toUpperCase()) >= 0
      ? String(m).toUpperCase() : "OTHER";
  };
  var hasBody = function (m) { return ["POST", "PUT", "PATCH", "DELETE"].indexOf(String(m).toUpperCase()) >= 0; };

  // ---- global request config (lives only in this tab) ----
  var cfg = { baseUrl: "", auth: "" };
  var baseInput = document.getElementById("dx-base");
  var authInput = document.getElementById("dx-auth");
  if (baseInput) baseInput.addEventListener("input", function () { cfg.baseUrl = baseInput.value.trim(); });
  if (authInput) authInput.addEventListener("input", function () { cfg.auth = authInput.value; });

  // ---- endpoint cards ----
  var splitPath = function (p) { return String(p || "").split("{var}"); };

  function buildRunner(ep) {
    var wrap = document.createElement("div");
    wrap.className = "runner";
    var parts = splitPath(ep.path);
    var paramCount = parts.length - 1;

    var pathRow = document.createElement("div");
    pathRow.className = "row";
    var paramInputs = [];
    if (paramCount > 0) {
      for (var i = 0; i < paramCount; i++) {
        var f = document.createElement("div"); f.className = "fld";
        var lab = document.createElement("label"); lab.textContent = "path param " + (i + 1);
        var inp = document.createElement("input"); inp.placeholder = "value";
        f.appendChild(lab); f.appendChild(inp); pathRow.appendChild(f);
        paramInputs.push(inp);
      }
      wrap.appendChild(pathRow);
    }

    var mkArea = function (labelText, ph, val) {
      var f = document.createElement("div"); f.className = "fld"; f.style.flex = "1 1 100%";
      var lab = document.createElement("label"); lab.textContent = labelText;
      var ta = document.createElement("textarea"); ta.placeholder = ph; if (val) ta.value = val;
      f.appendChild(lab); f.appendChild(ta); wrap.appendChild(f);
      return ta;
    };
    var queryTa = mkArea("query params (one key=value per line)", "limit=10\\noffset=0", "");
    var headersTa = mkArea("headers (one Name: value per line)", "Accept: application/json",
      hasBody(ep.method) ? "Content-Type: application/json" : "");
    var bodyTa = hasBody(ep.method) ? mkArea("request body", '{\\n  "field": "value"\\n}', "") : null;

    var btn = document.createElement("button");
    btn.className = "btn"; btn.textContent = "Send request";
    wrap.appendChild(btn);

    var resp = document.createElement("div"); resp.className = "resp";
    var statusLine = document.createElement("div"); statusLine.className = "status";
    var pre = document.createElement("pre");
    resp.appendChild(statusLine); resp.appendChild(pre); wrap.appendChild(resp);

    function buildUrl() {
      var out = "";
      for (var i = 0; i < parts.length; i++) {
        out += parts[i];
        if (i < paramInputs.length) out += encodeURIComponent(paramInputs[i].value || "");
      }
      var qs = [];
      queryTa.value.split("\\n").forEach(function (ln) {
        var t = ln.trim(); if (!t) return;
        var eq = t.indexOf("=");
        var k = eq >= 0 ? t.slice(0, eq) : t;
        var v = eq >= 0 ? t.slice(eq + 1) : "";
        qs.push(encodeURIComponent(k.trim()) + "=" + encodeURIComponent(v.trim()));
      });
      var base = cfg.baseUrl.replace(/\\/$/, "");
      return base + out + (qs.length ? "?" + qs.join("&") : "");
    }
    function buildHeaders() {
      var h = {};
      headersTa.value.split("\\n").forEach(function (ln) {
        var t = ln.trim(); if (!t) return;
        var c = t.indexOf(":"); if (c < 0) return;
        h[t.slice(0, c).trim()] = t.slice(c + 1).trim();
      });
      if (cfg.auth) h["Authorization"] = cfg.auth;
      return h;
    }

    btn.addEventListener("click", function () {
      if (!cfg.baseUrl) {
        resp.className = "resp show";
        statusLine.className = "status err";
        statusLine.textContent = "Enter a Base URL (your dev/staging origin) at the top first.";
        pre.textContent = ""; return;
      }
      var url = buildUrl();
      var init = { method: ep.method, headers: buildHeaders() };
      if (bodyTa && bodyTa.value.trim()) init.body = bodyTa.value;
      resp.className = "resp show";
      statusLine.className = "status"; statusLine.textContent = ep.method + " " + url + " …";
      pre.textContent = "";
      btn.disabled = true;
      var t0 = Date.now();
      fetch(url, init).then(function (r) {
        var ct = r.headers.get("content-type") || "";
        return r.text().then(function (txt) { return { r: r, txt: txt, ct: ct }; });
      }).then(function (o) {
        var ms = Date.now() - t0;
        statusLine.className = "status " + (o.r.ok ? "ok" : "err");
        statusLine.textContent = o.r.status + " " + o.r.statusText + "  ·  " + ms + " ms";
        var body = o.txt;
        if (o.ct.indexOf("json") >= 0) { try { body = JSON.stringify(JSON.parse(o.txt), null, 2); } catch (e) {} }
        pre.textContent = body;
      }).catch(function (err) {
        statusLine.className = "status err";
        statusLine.textContent = "Request failed — " + err.message;
        pre.textContent = "This usually means CORS blocked the call or the server is unreachable.\\n" +
          "Run the API against a dev/staging origin that allows this page's origin, or enable CORS there.\\n" +
          "dxkit generated this console statically; the call is made by your browser, not dxkit.";
      }).then(function () { btn.disabled = false; });
    });
    return wrap;
  }

  function buildCard(ep) {
    var card = document.createElement("div");
    card.className = "ep" + (ep.broken ? " broken" : ep.affected ? " affected" : "");
    card.setAttribute("data-ep", ep.id);
    var head = document.createElement("div"); head.className = "ep-head";
    head.innerHTML =
      '<span class="verb ' + verbClass(ep.method) + '">' + esc(ep.method) + "</span>" +
      '<span class="ep-path mono">' + esc(ep.path) + "</span>" +
      '<span class="ep-tags">' +
        (ep.broken ? '<span class="tag broken">' + esc(ep.broken.verdict) + ": broken</span>" : "") +
        (ep.affected && !ep.broken ? '<span class="tag affected">touched by diff</span>' : "") +
        '<span class="tag">' + (ep.consumerCount || 0) + " caller" + (ep.consumerCount === 1 ? "" : "s") + "</span>" +
        '<span class="tag">' + esc(ep.via) + "</span>" +
      "</span>";
    var body = document.createElement("div"); body.className = "ep-body";
    var meta = document.createElement("div"); meta.className = "ep-meta";
    var whereLabel = ep.broken ? "called from " : "served at ";
    meta.innerHTML =
      whereLabel + "<span class=\\"mono\\">" + esc(ep.sourceFile) + (ep.line ? ":" + ep.line : "") + "</span>" +
      (ep.handler ? " · handler <span class=\\"mono\\">" + esc(ep.handler) + "</span>" : "") +
      (ep.broken ? ' · <span class="brk">net-new break: ' + esc(ep.broken.reason) + "</span>" : "");
    body.appendChild(meta);
    body.appendChild(buildRunner(ep));
    if (ep.consumerFiles && ep.consumerFiles.length) {
      var cons = document.createElement("div"); cons.className = "consumers";
      cons.innerHTML = "<b>Consumed by:</b>" +
        ep.consumerFiles.map(function (f) { return '<span class="f mono">' + esc(f) + "</span>"; }).join("");
      body.appendChild(cons);
    }
    card.appendChild(head); card.appendChild(body);
    head.addEventListener("click", function () { card.classList.toggle("open"); });
    return card;
  }

  function renderList(containerId, list, emptyText) {
    var c = document.getElementById(containerId);
    if (!c) return;
    if (!list.length) { c.innerHTML = '<div class="empty-note">' + esc(emptyText) + "</div>"; return; }
    list.forEach(function (ep) { c.appendChild(buildCard(ep)); });
  }

  // affected/broken first, then by caller count
  var order = function (a, b) {
    return (b.broken ? 1 : 0) - (a.broken ? 1 : 0) ||
      (b.affected ? 1 : 0) - (a.affected ? 1 : 0) ||
      (b.consumerCount || 0) - (a.consumerCount || 0) ||
      String(a.path).localeCompare(String(b.path));
  };
  renderList("dx-broken", (DATA.broken || []).slice().sort(order),
    "No net-new broken integrations — nothing this change breaks.");
  renderList("dx-endpoints", (DATA.endpoints || []).slice().sort(order),
    "No consumed endpoints in scope.");
  renderList("dx-unconsumed", (DATA.unconsumed || []).slice().sort(order),
    "No served-but-unconsumed endpoints in scope.");

  // ---- flow map (optional; needs the inlined vis bundle) ----
  var graphEl = document.getElementById("dx-graph");
  if (graphEl && window.vis && (DATA.endpoints || []).length) {
    try { drawGraph(graphEl, DATA); }
    catch (e) { graphEl.className = "empty"; graphEl.textContent = "Flow map unavailable: " + e.message; }
  } else if (graphEl) {
    graphEl.className = "empty";
    graphEl.textContent = window.vis
      ? "No endpoints in scope to map."
      : "Interactive map omitted (vis-network bundle absent). The request runner below still works.";
  }

  function drawGraph(container, data) {
    var nodes = [], edges = [], seenFile = {};
    (data.endpoints || []).forEach(function (ep) {
      var color = ep.broken ? "#e15759" : ep.affected ? "#edc948" : "#4e79a7";
      nodes.push({ id: ep.id, label: ep.method + " " + ep.path, shape: "box",
        color: { background: color, border: color }, font: { color: "#0f1117" } });
      (ep.consumerFiles || []).forEach(function (f) {
        var fid = "f:" + f;
        if (!seenFile[fid]) {
          seenFile[fid] = true;
          nodes.push({ id: fid, label: f.split("/").pop(), title: f, shape: "dot", size: 8,
            color: { background: "#9aa3b2", border: "#6b7280" }, font: { color: "#9aa3b2" } });
        }
        edges.push({ from: fid, to: ep.id, arrows: "to", color: { color: "#3a4150" } });
      });
    });
    var net = new window.vis.Network(container,
      { nodes: new window.vis.DataSet(nodes), edges: new window.vis.DataSet(edges) },
      { physics: { stabilization: true, barnesHut: { gravitationalConstant: -6000 } },
        interaction: { hover: true }, nodes: { borderWidth: 1 } });
    net.on("click", function (params) {
      if (!params.nodes.length) return;
      var id = params.nodes[0];
      var card = document.querySelector('[data-ep="' + id + '"]');
      if (card) { card.classList.add("open"); card.scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
  }
})();
`;
