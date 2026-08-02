/**
 * The learn page renderer — ONE self-contained HTML document (issue #244).
 *
 * Hard constraints, all load-bearing:
 *   - ZERO external loads: no CDN scripts, no fonts, no images. Inline CSS
 *     only, no JavaScript at all in this (read-only) increment. The page
 *     must open from file:// on an offline machine.
 *   - STRICTLY read-only: every "enable X" renders the exact command to run
 *     (or the sentence to tell your agent); the one write path
 *     (`configure --apply`) stays canonical and is only ever QUOTED here.
 *   - Repo-derived strings are escaped at the boundary; the curated docs go
 *     through the pinned markdown subset renderer.
 */
import type { LearnBundle, LearnCapability, LearnDoc } from './bundle';
import type { LearnRepoStatus } from './repo-status';
import { escapeHtml, markdownToHtml, slugify } from './markdown';

const CSS = `
:root {
  --bg-primary:#0d1117; --bg-secondary:#161b22; --bg-card:#1c2129;
  --bg-tertiary:#21262d; --border:#30363d; --text-primary:#e6edf3;
  --text-secondary:#c9d1d9; --text-muted:#8b949e; --accent-blue:#58a6ff;
  --accent-green:#3fb950; --accent-red:#f85149; --accent-amber:#d29922;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  background:var(--bg-primary); color:var(--text-secondary); display:flex; min-height:100vh; }
code, pre { font-family:'SF Mono','Fira Code',Consolas,monospace; }
.sidebar { width:250px; background:var(--bg-secondary); border-right:1px solid var(--border);
  padding:20px 14px; position:sticky; top:0; align-self:flex-start; height:100vh; overflow-y:auto; flex-shrink:0; }
.sidebar h1 { font-size:16px; color:var(--text-primary); padding:0 8px 4px; }
.sidebar .version { font-size:11px; color:var(--text-muted); padding:0 8px 14px; }
.sidebar a { display:block; color:var(--text-secondary); text-decoration:none; font-size:13px;
  padding:6px 8px; border-radius:6px; }
.sidebar a:hover { background:var(--bg-tertiary); color:var(--text-primary); }
.nav-label { font-size:10px; text-transform:uppercase; letter-spacing:.8px;
  color:var(--text-muted); padding:14px 8px 4px; }
.main { flex:1; padding:32px 40px 80px; max-width:980px; }
h2.section { font-size:20px; color:var(--text-primary); margin:36px 0 6px; padding-bottom:8px;
  border-bottom:1px solid var(--border); }
.section-sub { color:var(--text-muted); font-size:13px; margin-bottom:16px; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
.card { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
.card .cmd { font-size:14px; color:var(--accent-blue); font-weight:600; }
.card .aliases { font-size:11px; color:var(--text-muted); }
.card .runtime { float:right; font-size:11px; color:var(--text-muted); background:var(--bg-tertiary);
  padding:2px 8px; border-radius:10px; }
.card p { font-size:12.5px; line-height:1.55; margin-top:8px; }
.card .knobs { margin-top:8px; font-size:11.5px; color:var(--text-muted); }
.card .knobs code { color:var(--accent-amber); }
.doc { background:var(--bg-card); border:1px solid var(--border); border-radius:10px;
  padding:22px 26px; margin-bottom:18px; }
.doc h1 { font-size:21px; color:var(--text-primary); margin-bottom:12px; }
.doc h2 { font-size:17px; color:var(--text-primary); margin:22px 0 8px; }
.doc h3 { font-size:14.5px; color:var(--text-primary); margin:16px 0 6px; }
.doc h4 { font-size:13px; color:var(--text-primary); margin:12px 0 4px; }
.doc p, .doc li { font-size:13.5px; line-height:1.65; }
.doc p { margin-bottom:10px; }
.doc ul, .doc ol { padding-left:22px; margin-bottom:12px; }
.doc pre { background:var(--bg-primary); border:1px solid var(--border); border-radius:8px;
  padding:12px 14px; font-size:12.5px; overflow-x:auto; margin:10px 0 14px; line-height:1.5; }
.doc code { background:var(--bg-tertiary); padding:1px 5px; border-radius:4px; font-size:12px; }
.doc pre code { background:none; padding:0; }
.doc a { color:var(--accent-blue); text-decoration:none; }
.doc strong { color:var(--text-primary); }
.doc blockquote { border-left:3px solid var(--border); padding-left:14px; color:var(--text-muted); margin-bottom:10px; }
.status-line { display:flex; gap:10px; align-items:baseline; padding:8px 12px; border-radius:8px; font-size:13px; }
.status-line.ok { color:var(--text-secondary); }
.status-line.fail { background:var(--bg-card); border:1px solid var(--border); margin-bottom:8px; }
.badge-ok { color:var(--accent-green); }
.badge-fail { color:var(--accent-red); }
.badge-warn { color:var(--accent-amber); }
.fix { font-size:12.5px; color:var(--text-muted); margin:4px 0 2px 24px; line-height:1.55; }
.fix code { background:var(--bg-primary); border:1px solid var(--border); padding:2px 7px;
  border-radius:5px; color:var(--accent-blue); user-select:all; }
.pill-row { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 16px; }
.pill { font-size:12px; background:var(--bg-card); border:1px solid var(--border);
  border-radius:14px; padding:4px 12px; color:var(--text-secondary); }
.note { font-size:12.5px; color:var(--text-muted); background:var(--bg-card);
  border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin:10px 0; line-height:1.6; }
.ask-row { display:flex; gap:12px; align-items:center; margin:8px 0; flex-wrap:wrap; }
.ask-row label { font-size:12.5px; color:var(--text-muted); display:flex; gap:6px; align-items:center; }
.ask-row input, .ask-row select, .ask-row textarea { background:var(--bg-primary); color:var(--text-primary);
  border:1px solid var(--border); border-radius:6px; padding:6px 9px; font-size:12.5px; font-family:inherit; }
.ask-row textarea { flex:1; min-width:260px; }
.ask-row button { background:var(--accent-blue); color:#fff; border:none; border-radius:6px;
  padding:8px 18px; font-size:13px; cursor:pointer; }
#chat { margin:12px 0; display:flex; flex-direction:column; gap:8px; }
.chat-msg { padding:9px 12px; border-radius:8px; font-size:13px; line-height:1.6; white-space:pre-wrap; }
.chat-user { background:var(--bg-tertiary); align-self:flex-end; max-width:85%; }
.chat-assistant { background:var(--bg-primary); border:1px solid var(--border); max-width:95%; }
#ask-error { font-size:12.5px; margin-top:6px; }
`;

function capCard(c: LearnCapability, knobs: LearnBundle['knobs']): string {
  const own = knobs.filter((k) => k.command === c.id);
  return `<div class="card">
    ${c.typicalRuntime ? `<span class="runtime">${escapeHtml(c.typicalRuntime)}</span>` : ''}
    <span class="cmd">${escapeHtml(c.id)}</span>
    ${c.aliases?.length ? `<span class="aliases">(${c.aliases.map(escapeHtml).join(', ')})</span>` : ''}
    <p>${escapeHtml(c.docsBlurb ?? c.summary)}</p>
    ${
      own.length > 0
        ? `<div class="knobs">policy knobs: ${own.map((k) => `<code>${escapeHtml(k.path)}</code>`).join(' ')}</div>`
        : ''
    }
  </div>`;
}

function docSection(d: LearnDoc): string {
  return `<section id="doc-${escapeHtml(d.slug)}"><div class="doc">${markdownToHtml(d.markdown)}</div></section>`;
}

function statusSection(status: LearnRepoStatus): string {
  const parts: string[] = [];
  parts.push(`<h2 class="section" id="repo-status">This repo</h2>`);
  if (!status.installed) {
    parts.push(
      `<div class="note">dxkit is not installed in this repository yet. The zero-question path: <code>npm init @vyuhlabs/dxkit -- --yes</code>, then <code>vyuh-dxkit doctor</code>.</div>`,
    );
  }
  if (status.policy) {
    const p = status.policy;
    parts.push(`<div class="pill-row">
      ${p.preset ? `<span class="pill">preset: ${escapeHtml(p.preset)}</span>` : ''}
      <span class="pill">custom checks: ${p.checksCount}</span>
      <span class="pill">pack lint gate: ${p.lintEnabled ? 'on' : 'off'}</span>
      ${p.lanes.map((l) => `<span class="pill">lane: ${escapeHtml(l)}</span>`).join('')}
    </div>`);
  }
  for (const b of status.baselines) {
    parts.push(
      `<div class="status-line ok"><span class="badge-ok">●</span> baseline <code>${escapeHtml(b.name)}</code>: ${b.entryCount} grandfathered findings${b.capturedAt ? `, captured ${escapeHtml(b.capturedAt.slice(0, 10))}` : ''}</div>`,
    );
  }
  if (status.lastVerdict) {
    const v = status.lastVerdict;
    const word = v.unattributableCount > 0 ? 'CANNOT GATE' : v.blocks ? 'BLOCKED' : 'PASSED';
    const cls = word === 'PASSED' ? 'badge-ok' : 'badge-fail';
    parts.push(
      `<div class="status-line ok"><span class="${cls}">●</span> last guardrail verdict: ${word}${v.blockingCount ? ` (${v.blockingCount} blocking)` : ''}${v.warningCount ? `, ${v.warningCount} warnings` : ''} <span style="color:var(--text-muted)">(${escapeHtml(v.ranAt.slice(0, 16))})</span></div>`,
    );
  }

  const doctor = status.doctor;
  if (doctor) {
    parts.push(`<h2 class="section" id="setup-panel">Set up this repo</h2>
      <p class="section-sub">Live requirements check (doctor). Every item is read-only here: copy the command, or tell your agent the sentence. The one write path is <code>vyuh-dxkit configure --apply</code>.</p>`);
    const failing = doctor.checks.filter((c) => !c.ok);
    const passing = doctor.checks.filter((c) => c.ok);
    if (failing.length === 0) {
      parts.push(
        `<div class="status-line ok"><span class="badge-ok">●</span> all ${passing.length} doctor checks pass</div>`,
      );
    }
    for (const c of failing) {
      parts.push(`<div class="status-line fail"><div>
        <span class="badge-fail">✗</span> ${escapeHtml(c.label)}
        ${c.fix ? `<div class="fix">${escapeHtml(c.fix.hint)}</div>` : ''}
        ${c.fix?.command ? `<div class="fix"><code>${escapeHtml(c.fix.command)}</code></div>` : ''}
      </div></div>`);
    }
    if (doctor.recommendations?.length) {
      parts.push(
        `<p class="section-sub" style="margin-top:14px">Doctor also recommends for this repo:</p>`,
      );
      for (const r of doctor.recommendations) {
        parts.push(`<div class="status-line fail"><div>
          <span class="badge-warn">→</span> <strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.recommendation.reason)}
          <div class="fix"><code>${escapeHtml(r.recommendation.command)}</code></div>
        </div></div>`);
      }
    }
    if (passing.length > 0 && failing.length > 0) {
      parts.push(
        `<div class="status-line ok" style="margin-top:8px"><span class="badge-ok">●</span> ${passing.length} other checks pass</div>`,
      );
    }
  }
  return parts.join('\n');
}

export interface RenderLearnOptions {
  /** ISO timestamp shown in the footer; omit for a deterministic page. */
  generatedAt?: string;
  /**
   * Serve mode (`learn --serve`): adds the assistant panel + its inline
   * script, which talks ONLY to same-origin localhost endpoints. The static
   * file mode stays entirely script-free — that page must open from file://
   * offline, and its tests pin the absence of any <script>.
   */
  serve?: boolean;
}

/** The assistant panel + inline JS for serve mode. No external loads; all
 *  repo/provider strings are inserted via textContent, never innerHTML. */
function assistantSection(): string {
  return `<h2 class="section" id="assistant">Ask the assistant</h2>
<p class="section-sub">Grounded in this page's content${''} and answered by YOUR provider with YOUR key (bring-your-own-key). dxkit relays your question from this machine directly to the provider; nothing is stored.</p>
<div class="doc" id="assistant-panel">
  <div class="ask-row">
    <label>Provider <select id="drv"></select></label>
    <label>Model <input id="model" list="model-suggestions" placeholder="model id"><datalist id="model-suggestions"></datalist></label>
  </div>
  <div class="ask-row" id="baseurl-row" hidden>
    <label>Base URL <input id="baseurl" placeholder="https://your-endpoint/v1"></label>
  </div>
  <div class="ask-row" id="key-row">
    <span id="key-env-note" hidden>Using the API key from your terminal environment (<code id="key-env-name"></code>). It never reaches this page.</span>
    <label id="key-input-label">API key <input id="key" type="password" placeholder="pasted key stays in this tab's memory only"></label>
  </div>
  <div class="ask-row" id="detail-row" hidden>
    <label><input type="checkbox" id="detail"> Include finding-level detail from this repo (off = summaries and counts only)</label>
  </div>
  <details class="note" id="sent-note"><summary>Exactly what is sent with each question</summary><ul id="disclosure"></ul></details>
  <div id="chat"></div>
  <div class="ask-row">
    <textarea id="q" rows="3" placeholder="e.g. Why is my PR blocked? What should this repo adopt next?"></textarea>
    <button id="ask">Ask</button>
  </div>
  <div id="ask-error" class="badge-fail"></div>
</div>
<script>
(function () {
  'use strict';
  var state = { drivers: [] };
  function el(id) { return document.getElementById(id); }
  function refreshStatus() {
    var detail = el('detail').checked ? '1' : '0';
    return fetch('/api/status?detail=' + detail).then(function (r) { return r.json(); }).then(function (s) {
      state.drivers = s.drivers;
      if (s.repoMode) el('detail-row').hidden = false;
      var drv = el('drv');
      if (drv.options.length === 0) {
        s.drivers.forEach(function (d) {
          var o = document.createElement('option');
          o.value = d.id; o.textContent = d.label + (d.envKeyPresent ? ' (key found in env)' : '');
          drv.appendChild(o);
        });
      }
      var ul = el('disclosure');
      ul.replaceChildren();
      s.disclosure.forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      });
      syncDriver();
    });
  }
  function currentDriver() {
    var id = el('drv').value;
    for (var i = 0; i < state.drivers.length; i++) if (state.drivers[i].id === id) return state.drivers[i];
    return null;
  }
  function syncDriver() {
    var d = currentDriver();
    if (!d) return;
    el('baseurl-row').hidden = !d.needsBaseUrl;
    var dl = el('model-suggestions');
    dl.replaceChildren();
    d.suggestedModels.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    });
    if (!el('model').value) el('model').value = d.defaultModel;
    el('key-env-note').hidden = !d.envKeyPresent;
    el('key-input-label').hidden = d.envKeyPresent;
    el('key-env-name').textContent = d.keyEnv;
  }
  function addMsg(role, text) {
    var div = document.createElement('div');
    div.className = 'chat-msg chat-' + role;
    div.textContent = text;
    el('chat').appendChild(div);
    div.scrollIntoView();
    return div;
  }
  var history = [];
  function ask() {
    var q = el('q').value.trim();
    if (!q) return;
    el('ask-error').textContent = '';
    el('q').value = '';
    addMsg('user', q);
    var pending = addMsg('assistant', '…');
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        driverId: el('drv').value,
        model: el('model').value.trim(),
        baseUrl: el('baseurl').value.trim(),
        browserKey: el('key').value,
        detail: el('detail').checked,
        question: q,
        history: history
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) {
          pending.textContent = '';
          el('ask-error').textContent = res.body.error || 'request failed';
          return;
        }
        pending.textContent = res.body.answer;
        history.push({ role: 'user', content: q });
        history.push({ role: 'assistant', content: res.body.answer });
      })
      .catch(function (e) { pending.textContent = ''; el('ask-error').textContent = String(e); });
  }
  el('ask').addEventListener('click', ask);
  el('drv').addEventListener('change', function () { el('model').value = ''; syncDriver(); });
  el('detail').addEventListener('change', refreshStatus);
  refreshStatus();
})();
</script>`;
}

export function renderLearnHtml(
  bundle: LearnBundle,
  status: LearnRepoStatus | null,
  opts: RenderLearnOptions = {},
): string {
  const core = bundle.capabilities.filter((c) => c.tier === 'core');
  const more = bundle.capabilities.filter((c) => c.tier === 'more');
  const groups = [...new Set(more.map((c) => c.groupLabel))];

  const nav: string[] = [];
  nav.push(`<div class="nav-label">Guide</div>`);
  for (const d of bundle.docs) {
    nav.push(`<a href="#doc-${escapeHtml(d.slug)}">${escapeHtml(d.title)}</a>`);
  }
  nav.push(`<div class="nav-label">Capabilities</div>`);
  nav.push(`<a href="#core">Start here</a>`);
  for (const g of groups) nav.push(`<a href="#group-${slugify(g)}">${escapeHtml(g)}</a>`);
  if (status) {
    nav.push(`<div class="nav-label">This repo</div>`);
    nav.push(`<a href="#repo-status">Status</a>`);
    if (status.doctor) nav.push(`<a href="#setup-panel">Set up this repo</a>`);
  }

  const body: string[] = [];
  for (const d of bundle.docs) body.push(docSection(d));

  body.push(`<h2 class="section" id="core">Start here</h2>
    <p class="section-sub">The five commands most repos live in.</p>
    <div class="cards">${core.map((c) => capCard(c, bundle.knobs)).join('\n')}</div>`);
  for (const g of groups) {
    const caps = more.filter((c) => c.groupLabel === g);
    body.push(`<h2 class="section" id="group-${slugify(g)}">${escapeHtml(g)}</h2>
      <div class="cards">${caps.map((c) => capCard(c, bundle.knobs)).join('\n')}</div>`);
  }
  if (status) body.push(statusSection(status));
  if (opts.serve) {
    nav.push(`<div class="nav-label">Assistant</div>`);
    nav.push(`<a href="#assistant">Ask the assistant</a>`);
    body.push(assistantSection());
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dxkit learn</title>
<style>${CSS}</style>
</head>
<body>
<nav class="sidebar">
  <h1>dxkit learn</h1>
  <div class="version">v${escapeHtml(bundle.version)}${status ? ' · with repo status' : ' · capability guide'}</div>
  ${nav.join('\n  ')}
</nav>
<main class="main">
${body.join('\n')}
${opts.generatedAt ? `<p class="section-sub" style="margin-top:40px">Generated ${escapeHtml(opts.generatedAt)} · fully offline page: no scripts, no external loads.</p>` : ''}
</main>
</body>
</html>
`;
}
