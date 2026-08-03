/**
 * The learn page renderer — ONE self-contained HTML document (issues #244,
 * #245, plus the UI modernization pass).
 *
 * Hard constraints, all load-bearing and pinned by test:
 *   - ZERO external loads: no CDN, no fonts, no remote images, no fetch to
 *     anywhere but the page's own localhost origin (serve mode only). The
 *     static file opens from file:// on an offline machine, fully working.
 *   - All JavaScript is INLINE and self-contained. The static page's script
 *     performs no network requests at all (search, theme, copy, nav
 *     highlighting are pure client-side over embedded data).
 *   - STRICTLY read-only: every "enable X" renders the exact command; the
 *     one write path (`configure --apply`) is only ever QUOTED.
 *   - Repo-derived strings are escaped at the boundary; docs go through the
 *     pinned markdown subset renderer; assistant answers are rendered
 *     server-side by that SAME renderer (never a client-side engine).
 *
 * Theme: light + dark via design tokens; default follows
 * prefers-color-scheme, the toggle persists to localStorage.
 */
import type { LearnBundle, LearnCapability, LearnDoc } from './bundle';
import type { LearnRepoStatus } from './repo-status';
import { escapeHtml, markdownToHtml, slugify } from './markdown';
import { CSS } from './page-css';
import { BASE_JS, ASSISTANT_JS } from './page-js';

/* ─────────────────────────── search index ─────────────────────────── */

interface SearchEntry {
  /** Display title. */
  t: string;
  /** Kind label shown in the palette. */
  k: string;
  /** Anchor (#...) to jump to. */
  a: string;
  /** Snippet searched + shown. */
  s: string;
}

function buildSearchIndex(bundle: LearnBundle, status: LearnRepoStatus | null): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const c of bundle.capabilities) {
    out.push({
      t: c.id,
      k: c.tier === 'core' ? 'core command' : 'command',
      a: `#cap-${c.id}`,
      s: c.docsBlurb ?? c.summary,
    });
  }
  for (const kn of bundle.knobs) {
    out.push({
      t: kn.path,
      k: 'policy knob',
      a: `#cap-${kn.command}`,
      s: kn.note ?? `configured via ${kn.command}`,
    });
  }
  for (const d of bundle.docs) {
    out.push({ t: d.title, k: 'doc', a: `#doc-${d.slug}`, s: firstProse(d.markdown) });
    for (const line of d.markdown.split('\n')) {
      const h = line.match(/^##\s+(.+)$/);
      if (h) out.push({ t: h[1], k: 'doc section', a: `#${slugify(h[1])}`, s: d.title });
    }
  }
  for (const f of bundle.policyFields) {
    out.push({
      t: f.path,
      k: 'policy field',
      a: '#policy-reference',
      s: f.description.slice(0, 160),
    });
  }
  for (const r of bundle.reference) {
    out.push({
      t: r.title,
      k: 'reference',
      a: `#ref-${slugify(r.relPath)}`,
      s: `docs/${r.relPath}`,
    });
  }
  for (const s of bundle.skills) {
    out.push({ t: s.name, k: 'agent skill', a: '#skills', s: s.description.slice(0, 160) });
  }
  for (const t of bundle.tasks) {
    out.push({ t: t.id, k: 'remediation task', a: '#tasks', s: t.summary });
  }
  if (status?.doctor) {
    for (const c of status.doctor.checks.filter((x) => !x.ok)) {
      out.push({
        t: c.label,
        k: 'setup item',
        a: '#setup-panel',
        s: c.fix?.hint ?? 'failing doctor check',
      });
    }
  }
  return out;
}

function firstProse(md: string): string {
  for (const line of md.split('\n')) {
    const l = line.trim();
    if (l.length > 0 && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('<!--')) {
      return l.slice(0, 160);
    }
  }
  return '';
}

/* ─────────────────────────── sections ─────────────────────────── */

function capCard(c: LearnCapability, knobs: LearnBundle['knobs']): string {
  const own = knobs.filter((k) => k.command === c.id);
  return `<div class="card" id="cap-${escapeHtml(c.id)}">
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
  return `<section class="view" id="doc-${escapeHtml(d.slug)}" data-title="${escapeHtml(d.title)}" data-crumb="Guide"><div class="doc">${markdownToHtml(d.markdown)}</div></section>`;
}

function repoStatusView(status: LearnRepoStatus): string {
  const parts: string[] = [];
  parts.push(`<h2 class="section">This repo</h2>`);
  if (!status.installed) {
    parts.push(
      `<div class="note">dxkit is not installed in this repository yet. The zero-question path: <code>npm init @vyuhlabs/dxkit -- --yes</code>, then <code>vyuh-dxkit doctor</code>.</div>`,
    );
  }
  if (status.policy) {
    const p = status.policy;
    parts.push(`<div class="pill-row">
      ${p.preset ? `<span class="pill">preset: <strong>${escapeHtml(p.preset)}</strong></span>` : ''}
      <span class="pill">custom checks: ${p.checksCount}</span>
      <span class="pill">pack lint gate: ${p.lintEnabled ? 'on' : 'off'}</span>
      ${p.lanes.map((l) => `<span class="pill">lane: ${escapeHtml(l)}</span>`).join('')}
    </div>`);
  }
  for (const b of status.baselines) {
    parts.push(
      `<div class="status-line"><span class="badge-ok">●</span> baseline <code>${escapeHtml(b.name)}</code>: ${b.entryCount} grandfathered findings${b.capturedAt ? `, captured ${escapeHtml(b.capturedAt.slice(0, 10))}` : ''}</div>`,
    );
  }
  if (status.lastVerdict) {
    const v = status.lastVerdict;
    const word = v.unattributableCount > 0 ? 'CANNOT GATE' : v.blocks ? 'BLOCKED' : 'PASSED';
    const cls = word === 'PASSED' ? 'badge-ok' : 'badge-fail';
    parts.push(
      `<div class="status-line"><span class="${cls}">●</span> last guardrail verdict: <strong>${word}</strong>${v.blockingCount ? ` (${v.blockingCount} blocking)` : ''}${v.warningCount ? `, ${v.warningCount} warnings` : ''} <span style="color:var(--muted)">(${escapeHtml(v.ranAt.slice(0, 16))})</span></div>`,
    );
  }
  return `<section class="view" id="repo-status" data-title="This repo" data-crumb="This repo">${parts.join('\n')}</section>`;
}

function setupView(status: LearnRepoStatus): string {
  const doctor = status.doctor;
  if (!doctor) return '';
  const parts: string[] = [];
  parts.push(`<h2 class="section">Set up this repo</h2>
      <p class="section-sub">Live requirements check (doctor). Everything here is read-only: copy the command, or tell your agent the sentence. The one write path is <code>vyuh-dxkit configure --apply</code>.</p>`);
  const failing = doctor.checks.filter((c) => !c.ok);
  const passing = doctor.checks.filter((c) => c.ok);
  if (failing.length === 0) {
    parts.push(
      `<div class="status-line"><span class="badge-ok">●</span> all ${passing.length} doctor checks pass</div>`,
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
      `<div class="status-line" style="margin-top:8px"><span class="badge-ok">●</span> ${passing.length} other checks pass</div>`,
    );
  }
  return `<section class="view" id="setup-panel" data-title="Set up this repo" data-crumb="This repo">${parts.join('\n')}</section>`;
}

/* ─────────────────────────── assistant panel (serve) ─────────────────────────── */

function assistantPanel(): string {
  return `
<button class="assistant-fab" id="fab">✦ Ask dxkit <kbd style="opacity:.7;font-size:10px">Ctrl+/</kbd></button>
<aside class="assistant-panel" id="apanel" aria-label="dxkit assistant">
  <div class="ap-head">
    <span class="t">✦ dxkit assistant</span>
    <span class="sub">bring-your-own-key · local relay · executes nothing</span>
    <button class="close" id="ap-close" title="Close">✕</button>
  </div>
  <div class="ap-config">
    <div class="ap-row">
      <label>Provider <select id="drv"></select></label>
      <label>Model <select id="model-select"></select></label>
      <input type="text" id="model-custom" placeholder="model id" hidden>
    </div>
    <div class="ap-row" id="baseurl-row" hidden>
      <label>Base URL <input type="text" id="baseurl" placeholder="https://your-endpoint/v1"></label>
    </div>
    <div class="ap-row" id="key-row">
      <span id="key-env-note" hidden>Key from your terminal env (<code id="key-env-name"></code>) — it never reaches this page.</span>
      <label id="key-input-label">API key <input type="password" id="key" placeholder="stays in this tab's memory only"></label>
    </div>
    <div class="ap-row" id="detail-row" hidden>
      <label><input type="checkbox" id="detail"> Include finding-level detail (off = summaries and counts only)</label>
    </div>
    <div class="ap-row"><span id="models-note" class="models-note"></span></div>
    <details class="ap-disclosure" id="sent-note"><summary>Exactly what is sent with each question</summary><ul id="disclosure"></ul></details>
    <details class="ap-disclosure"><summary>How this assistant works</summary>
      <ul>
        <li>It answers from a fixed knowledge pack: this dxkit version's own registries (every command and policy field), the shipped docs, and — in a repo — this repo's dxkit status (policy, doctor results, baselines, last verdict), gathered when the server started.</li>
        <li>It does NOT read your source code, does not browse the internet or GitHub, and cannot run anything. Its knowledge is version-locked to the installed dxkit.</li>
        <li>Your question + the grounding go directly from this machine to the provider you chose, with your key. dxkit stores nothing.</li>
      </ul>
    </details>
  </div>
  <div class="ap-chat" id="chat">
    <div class="ap-empty" id="chat-empty">Ask anything about dxkit${''} or this repo.<br><br>“Why is my PR blocked?”<br>“What should we adopt next?”<br>“How do I defer a finding?”</div>
  </div>
  <div class="ap-error" id="ask-error"></div>
  <div class="ap-input">
    <textarea id="q" rows="1" placeholder="Ask… (Enter to send, Shift+Enter for a new line)"></textarea>
    <button id="ask">Send</button>
  </div>
</aside>`;
}

/* ─────────────────────────── page assembly ─────────────────────────── */

export interface RenderLearnOptions {
  /** ISO timestamp shown in the footer; omit for a deterministic page. */
  generatedAt?: string;
  /** Serve mode: adds the assistant panel + its script (same-origin only). */
  serve?: boolean;
}

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2563eb"/><text x="16" y="22" font-size="16" font-family="monospace" font-weight="bold" fill="#fff" text-anchor="middle">dx</text></svg>`,
  );

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
  nav.push(`<div class="nav-label">Knowledge base</div>`);
  if (bundle.policyFields.length > 0)
    nav.push(`<a href="#policy-reference">Policy fields (${bundle.policyFields.length})</a>`);
  if (bundle.skills.length > 0) nav.push(`<a href="#skills">Agent skills</a>`);
  if (bundle.tasks.length > 0) nav.push(`<a href="#tasks">Remediation tasks</a>`);
  if (bundle.reference.length > 0)
    nav.push(`<a href="#reference">Reference (${bundle.reference.length} pages)</a>`);
  if (status) {
    nav.push(`<div class="nav-label">This repo</div>`);
    nav.push(`<a href="#repo-status">Status</a>`);
    if (status.doctor) nav.push(`<a href="#setup-panel">Set up this repo</a>`);
  }

  const body: string[] = [];

  // Home / "Start here" view: hero + the core capability cards.
  body.push(`<section class="view" id="core" data-title="Start here" data-crumb="">
    <div class="hero">
      <h1>Understand dxkit in one sitting</h1>
      <p>dxkit gates <strong>changes</strong>, not repositories: existing debt is grandfathered, only net-new problems block. And it <strong>acts</strong> on what it finds — scheduled lanes and remediation agents bump dependencies, burn down debt, and improve tests and docs, landing only via pull requests that pass the same gate as a human change. Everything on this page ships with the package and works offline${opts.serve ? ' — and the assistant on the right answers from exactly this content' : ''}.</p>
      <div class="hero-actions">
        <a class="tbtn primary" href="#doc-how-dxkit-thinks">Read the mental model</a>
        <a class="tbtn" href="#reference">Browse the reference (${bundle.reference.length} pages)</a>
      </div>
    </div>
    <h2 class="section">Start here</h2>
    <p class="section-sub">The five commands most repos live in.</p>
    <div class="cards">${core.map((c) => capCard(c, bundle.knobs)).join('\n')}</div>
  </section>`);

  for (const d of bundle.docs) body.push(docSection(d));

  for (const g of groups) {
    const caps = more.filter((c) => c.groupLabel === g);
    body.push(`<section class="view" id="group-${slugify(g)}" data-title="${escapeHtml(g)}" data-crumb="Capabilities">
      <h2 class="section">${escapeHtml(g)}</h2>
      <div class="cards">${caps.map((c) => capCard(c, bundle.knobs)).join('\n')}</div></section>`);
  }
  if (bundle.skills.length > 0) {
    body.push(`<section class="view" id="skills" data-title="Agent skills" data-crumb="Knowledge base">
      <h2 class="section">Agent skills</h2>
      <p class="section-sub">Installed into <code>.claude/skills/</code> by init so a coding agent drives each capability conversationally.</p>
      <ul class="list-plain">${bundle.skills
        .map((s) => `<li><b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.description)}</li>`)
        .join('')}</ul></section>`);
  }
  if (bundle.tasks.length > 0) {
    body.push(`<section class="view" id="tasks" data-title="Remediation lane tasks" data-crumb="Knowledge base">
      <h2 class="section">Remediation lane tasks</h2>
      <p class="section-sub">What the scheduled remediation lane (and one-off dispatch campaigns) can run. Every task lands only via a PR through the same gate.</p>
      <ul class="list-plain">${bundle.tasks
        .map(
          (t) =>
            `<li><span class="tier">${escapeHtml(t.tier)} · ${escapeHtml(t.verify)}</span><b>${escapeHtml(t.id)}</b><br>${escapeHtml(t.summary)}<br><span class="task-why">Model tier: ${escapeHtml(t.tierWhy)}${t.hinge ? `<br>Score hinge: ${escapeHtml(t.hinge)}` : ''}</span></li>`,
        )
        .join('')}</ul>
      <div class="note">Run tasks two ways: the <strong>scheduled lane</strong> (cron, the tasks enabled in policy), or a <strong>one-off dispatch campaign</strong> from the GitHub Actions UI (Run workflow → pick a task or <code>custom</code> with a free-text prompt, plus spend/turn/minute overrides — clamped by <code>remediate.maxDispatchBudget</code>). Either way, work lands ONLY via a pull request through the same gate, with the dispatcher, prompt, model, and spend disclosed in the PR body.</div></section>`);
  }
  if (bundle.policyFields.length > 0) {
    const rows = bundle.policyFields
      .map(
        (f) =>
          `<tr><td><code>${escapeHtml(f.path)}</code></td><td>${escapeHtml(f.type)}${f.enum ? `<br><span class="task-why">${f.enum.map(escapeHtml).join(' | ')}</span>` : ''}</td><td>${f.default !== undefined ? `<code>${escapeHtml(f.default)}</code>` : ''}</td><td>${escapeHtml(f.description)}</td></tr>`,
      )
      .join('');
    body.push(`<section class="view" id="policy-reference" data-title="Policy field reference" data-crumb="Knowledge base">
      <h2 class="section">Policy field reference</h2>
      <p class="section-sub">Every field <code>.dxkit/policy.json</code> accepts — ${bundle.policyFields.length} fields, generated from the same schema the file validates against, so this table cannot drift from the product. See also the narrative <a href="#ref-${slugify('configuration/policy-guide.md')}">policy guide</a>.</p>
      <div class="doc"><table><thead><tr><th>Field</th><th>Type</th><th>Default</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`);
  }
  if (bundle.reference.length > 0) {
    const refGroups = [...new Set(bundle.reference.map((r) => r.group))];
    // The reference INDEX view: a wiki-style listing, one card per page.
    body.push(`<section class="view" id="reference" data-title="Reference" data-crumb="Knowledge base">
      <h2 class="section">Reference</h2>
      <p class="section-sub">The full documentation shelf, shipped with the package — ${bundle.reference.length} pages, all searchable (Ctrl+K).</p>
      ${refGroups
        .map(
          (g) => `<h3 class="ref-index-group">${escapeHtml(g)}</h3>
        <div class="cards">${bundle.reference
          .filter((r) => r.group === g)
          .map(
            (r) => `<a class="card ref-card" href="#ref-${slugify(r.relPath)}">
              <span class="cmd">${escapeHtml(r.title)}</span>
              <p>docs/${escapeHtml(r.relPath)}</p></a>`,
          )
          .join('')}</div>`,
        )
        .join('\n')}
    </section>`);
    // One view per reference page (wiki page-per-topic).
    for (const r of bundle.reference) {
      body.push(`<section class="view" id="ref-${slugify(r.relPath)}" data-title="${escapeHtml(r.title)}" data-crumb="Reference">
        <p class="section-sub"><a href="#reference">← Reference</a> · docs/${escapeHtml(r.relPath)}</p>
        <div class="doc">${markdownToHtml(r.markdown)}</div></section>`);
    }
  }
  if (status) {
    body.push(repoStatusView(status));
    body.push(setupView(status));
  }

  const searchIndexJson = JSON.stringify(buildSearchIndex(bundle, status)).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dxkit learn</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<header class="topbar">
  <span class="brand">dxkit <span class="v">v${escapeHtml(bundle.version)}</span>
    <span class="mode">${status ? 'repo mode' : 'guide'}</span></span>
  <button class="searchbtn" id="searchbtn" type="button">🔍 Search capabilities, docs, setup…<kbd>Ctrl K</kbd></button>
  <span class="spacer"></span>
  ${opts.serve ? `<button class="tbtn primary" id="assistant-open" type="button">✦ Ask dxkit</button>` : ''}
  <button class="tbtn" id="theme-toggle" type="button" title="Toggle theme">☾</button>
</header>
<div class="layout">
<nav class="sidebar">
  ${nav.join('\n  ')}
</nav>
<main class="main">
<div class="crumbs" id="crumbs"></div>
${body.join('\n')}
<div class="pagenav" id="pagenav"></div>
${opts.generatedAt ? `<p class="section-sub" style="margin-top:44px">Generated ${escapeHtml(opts.generatedAt)} · fully self-contained page: no external requests, works offline.</p>` : ''}
</main>
<aside class="toc" id="toc" aria-label="On this page"></aside>
</div>
<div class="palette-overlay" id="palette-overlay">
  <div class="palette">
    <input id="palette-input" type="text" placeholder="Search capabilities, docs, policy knobs…" autocomplete="off">
    <div class="palette-results" id="palette-results"></div>
  </div>
</div>
${opts.serve ? assistantPanel() : ''}
<script type="application/json" id="search-index">${searchIndexJson}</script>
<script>${BASE_JS}</script>
${opts.serve ? `<script>${ASSISTANT_JS}</script>` : ''}
</body>
</html>
`;
}
