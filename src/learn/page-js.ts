/**
 * The learn page's inline scripts, split from render.ts for module size.
 * Both are plain-string constants embedded verbatim into the page:
 *   - PAGE_JS runs in BOTH modes and performs ZERO network requests
 *     (theme, Ctrl+K search over the embedded index, copy buttons, nav);
 *   - ASSISTANT_JS is serve-mode only and talks ONLY to same-origin
 *     /api/ paths. Pinned by test/learn/serve.test.ts.
 */

export /** Base page behavior: theme, search palette, copy buttons, active nav.
 *  Runs in BOTH modes; performs zero network requests. Plain string concat
 *  only (no template placeholders) so the embedded source stays literal. */
const BASE_JS = `
(function () {
  'use strict';
  function el(id) { return document.getElementById(id); }

  /* theme */
  var stored = null;
  try { stored = localStorage.getItem('dxkit-theme'); } catch (e) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var b = el('theme-toggle');
    if (b) b.textContent = t === 'dark' ? '☀' : '☾';
  }
  applyTheme(stored || (prefersDark ? 'dark' : 'light'));
  el('theme-toggle').addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('dxkit-theme', next); } catch (e) {}
    applyTheme(next);
  });

  /* copy buttons */
  var targets = document.querySelectorAll('.doc pre, .fix');
  targets.forEach(function (t) {
    var codeText = t.classList.contains('fix')
      ? (t.querySelector('code') ? t.querySelector('code').textContent : '')
      : t.textContent;
    if (!codeText || !codeText.trim()) return;
    var b = document.createElement('button');
    b.className = 'copybtn'; b.type = 'button'; b.textContent = 'copy';
    b.addEventListener('click', function () {
      var done = function () { b.textContent = 'copied'; b.classList.add('done');
        setTimeout(function () { b.textContent = 'copy'; b.classList.remove('done'); }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(codeText.trim()).then(done, done);
      } else { done(); }
    });
    t.appendChild(b);
  });

  /* active nav */
  var links = Array.prototype.slice.call(document.querySelectorAll('.sidebar a[href^="#"]'));
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var observed = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  if ('IntersectionObserver' in window && observed.length) {
    var active = null;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          if (active) active.classList.remove('active');
          active = byId[en.target.id];
          if (active) active.classList.add('active');
        }
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    observed.forEach(function (s) { io.observe(s); });
  }

  /* search palette */
  var indexEl = el('search-index');
  var INDEX = indexEl ? JSON.parse(indexEl.textContent) : [];
  var overlay = el('palette-overlay'); var input = el('palette-input');
  var results = el('palette-results'); var sel = 0; var shown = [];
  function openPalette() { overlay.classList.add('open'); input.value = ''; render(''); input.focus(); }
  function closePalette() { overlay.classList.remove('open'); }
  function render(q) {
    var ql = q.trim().toLowerCase(); sel = 0;
    shown = !ql ? INDEX.slice(0, 10) : INDEX
      .map(function (e) {
        var t = e.t.toLowerCase(); var s = (e.s || '').toLowerCase();
        var score = t === ql ? 0 : t.indexOf(ql) === 0 ? 1 : t.indexOf(ql) >= 0 ? 2 : s.indexOf(ql) >= 0 ? 3 : -1;
        return { e: e, score: score };
      })
      .filter(function (r) { return r.score >= 0; })
      .sort(function (a, b) { return a.score - b.score; })
      .slice(0, 12)
      .map(function (r) { return r.e; });
    results.replaceChildren();
    if (!shown.length) {
      var d = document.createElement('div'); d.className = 'palette-empty';
      d.textContent = 'No matches.'; results.appendChild(d); return;
    }
    shown.forEach(function (e, i) {
      var b = document.createElement('button');
      b.className = 'presult' + (i === sel ? ' sel' : ''); b.type = 'button';
      var t = document.createElement('div'); t.className = 'rt';
      var k = document.createElement('span'); k.className = 'rk'; k.textContent = e.k;
      t.appendChild(k); t.appendChild(document.createTextNode(e.t));
      var s = document.createElement('div'); s.className = 'rs'; s.textContent = e.s || '';
      b.appendChild(t); b.appendChild(s);
      b.addEventListener('click', function () { go(e); });
      results.appendChild(b);
    });
  }
  function go(e) {
    closePalette();
    /* open every ancestor <details> so anchors inside the reference shelf land visibly */
    var target = document.getElementById(e.a.slice(1));
    var p = target;
    while (p) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; }
    location.hash = e.a;
    if (target) target.scrollIntoView({ block: 'start' });
  }
  el('searchbtn').addEventListener('click', openPalette);
  overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closePalette(); });
  input.addEventListener('input', function () { render(input.value); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      sel = Math.max(0, Math.min(shown.length - 1, sel + (ev.key === 'ArrowDown' ? 1 : -1)));
      Array.prototype.forEach.call(results.children, function (c, i) { c.classList.toggle('sel', i === sel); });
    } else if (ev.key === 'Enter' && shown[sel]) { go(shown[sel]); }
    else if (ev.key === 'Escape') { closePalette(); }
  });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openPalette(); }
  });
})();
`;

export /** Assistant behavior (serve mode only): same-origin localhost fetch only. */
const ASSISTANT_JS = `
(function () {
  'use strict';
  function el(id) { return document.getElementById(id); }
  var state = { drivers: [], history: [] };
  var CUSTOM_SENTINEL = '__custom__';

  /* panel open/close */
  function openPanel() { el('apanel').classList.add('open'); el('q').focus(); }
  function closePanel() { el('apanel').classList.remove('open'); }
  el('fab').addEventListener('click', openPanel);
  el('assistant-open').addEventListener('click', openPanel);
  el('ap-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === '/') { ev.preventDefault();
      el('apanel').classList.contains('open') ? closePanel() : openPanel(); }
  });

  function refreshStatus() {
    var detail = el('detail').checked ? '1' : '0';
    return fetch('/api/status?detail=' + detail).then(function (r) { return r.json(); }).then(function (s) {
      state.drivers = s.drivers;
      if (s.repoMode) el('detail-row').hidden = false;
      var drv = el('drv');
      if (drv.options.length === 0) {
        s.drivers.forEach(function (d) {
          var o = document.createElement('option');
          o.value = d.id; o.textContent = d.label + (d.envKeyPresent ? ' · key in env' : '');
          drv.appendChild(o);
        });
      }
      var ul = el('disclosure');
      ul.replaceChildren();
      s.disclosure.forEach(function (line) {
        var li = document.createElement('li'); li.textContent = line; ul.appendChild(li);
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
    var d = currentDriver(); if (!d) return;
    el('baseurl-row').hidden = !d.needsBaseUrl;
    var ms = el('model-select');
    ms.replaceChildren();
    if (d.routing) {
      var auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = 'Auto — ' + d.routing.fast + ' ↔ ' + d.routing.deep;
      ms.appendChild(auto);
    }
    d.suggestedModels.forEach(function (m) {
      var o = document.createElement('option'); o.value = m; o.textContent = m; ms.appendChild(o);
    });
    var custom = document.createElement('option');
    custom.value = CUSTOM_SENTINEL; custom.textContent = 'Other model…';
    ms.appendChild(custom);
    ms.value = d.routing ? 'auto' : (d.suggestedModels[0] || CUSTOM_SENTINEL);
    el('model-custom').hidden = ms.value !== CUSTOM_SENTINEL;
    el('key-env-note').hidden = !d.envKeyPresent;
    el('key-input-label').hidden = d.envKeyPresent;
    el('key-env-name').textContent = d.keyEnv;
  }
  function chosenModel() {
    var v = el('model-select').value;
    if (v === CUSTOM_SENTINEL) return el('model-custom').value.trim();
    return v;
  }

  function addMsg(role, node) {
    var empty = el('chat-empty'); if (empty) empty.remove();
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    if (typeof node === 'string') div.textContent = node; else div.appendChild(node);
    el('chat').appendChild(div);
    div.scrollIntoView({ block: 'end' });
    return div;
  }
  function addMeta(text) {
    var m = document.createElement('div'); m.className = 'msg-meta'; m.textContent = text;
    el('chat').appendChild(m);
  }
  function typingNode() {
    var t = document.createElement('span'); t.className = 'typing';
    for (var i = 0; i < 3; i++) t.appendChild(document.createElement('i'));
    return t;
  }

  function ask() {
    var q = el('q').value.trim(); if (!q) return;
    el('ask-error').textContent = ''; el('q').value = ''; autoGrow();
    addMsg('user', q);
    var pending = addMsg('assistant', typingNode());
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        driverId: el('drv').value,
        model: chosenModel(),
        baseUrl: el('baseurl').value.trim(),
        browserKey: el('key').value,
        detail: el('detail').checked,
        question: q,
        history: state.history
      })
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) {
          pending.remove();
          el('ask-error').textContent = res.body.error || 'request failed';
          return;
        }
        pending.replaceChildren();
        /* answerHtml is rendered server-side by dxkit's pinned markdown
           renderer, which escapes all input — safe to inject. */
        pending.innerHTML = res.body.answerHtml || '';
        if (!res.body.answerHtml) pending.textContent = res.body.answer;
        var meta = 'served by ' + res.body.servedModel +
          (res.body.routed ? ' · auto-routed: ' + res.body.routeReason : '') +
          ' · key: ' + res.body.keySource;
        addMeta(meta);
        state.history.push({ role: 'user', content: q });
        state.history.push({ role: 'assistant', content: res.body.answer });
      })
      .catch(function (e) { pending.remove(); el('ask-error').textContent = String(e); });
  }
  function autoGrow() {
    var t = el('q'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 130) + 'px';
  }
  el('ask').addEventListener('click', ask);
  el('q').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ask(); }
  });
  el('q').addEventListener('input', autoGrow);
  el('model-select').addEventListener('change', function () {
    el('model-custom').hidden = el('model-select').value !== CUSTOM_SENTINEL;
  });
  el('drv').addEventListener('change', syncDriver);
  el('detail').addEventListener('change', refreshStatus);
  refreshStatus();
})();
`;
