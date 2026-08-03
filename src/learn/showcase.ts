/**
 * The learn page's first screen — the product showcase.
 *
 * This is deliberately a DEMO surface, not documentation: the page is the
 * product's front door (`learn --serve` is the org one-liner), so the first
 * sixty seconds show the artifact — real verdict output, the refusal tier,
 * the remediation envelope — before any capability listing. Everything here
 * is static HTML/CSS (self-contained page contract: no external loads, no
 * fetch in static mode); the three-act walkthrough is driven by a small
 * stepper in page-js.ts that degrades to all-acts-stacked without JS.
 *
 * The verdict/envelope text mirrors the REAL renderer shapes
 * (check-renderers.ts verdict banners + formatPairLines, the remediate PR
 * summary) so what the page shows is what the product prints. If those
 * shapes change, update these blocks with them.
 */

import { dxkitCli } from '../self-invocation';

/** The three-act loop walkthrough: BLOCKED → bounded repair → PASSED. */
const ACT_BLOCKED = `$ ${dxkitCli('guardrail check')}

Guardrail BLOCKED — 1 new regression

Blocking (1)
  ADDED [critical] secret src/payments/stripe-sync.ts:41
  · block-rule: policy block-rule fired: newSecret
  · fingerprint: 3f9c2a51de8b4c07  (allowlist add --fingerprint=3f9c2a51de8b4c07)

exit 1 — the exact finding, its durable fingerprint, and the paved path out.`;

const ACT_REMEDIATE = `## dxkit agentic remediation

Task: **fix-vulns** — outcome: **landed**

### Agent envelope
- driver: claude-code
- model: sonnet (auto tier)
- spend: $1.84 over 34 turns  (caps: 80 turns, 30 min, $5)

### Verification
Correctness floor (attributed vs the pre-agent entry run): passed
Guardrail: PASSED

The agent's own claim of success is never trusted — the floor and the
guardrail ran before anything landed.`;

const ACT_PASSED = `$ ${dxkitCli('guardrail check')}

Guardrail PASSED

Same gate, same baseline, same fingerprints — for the agent's PR and for
yours. There is no side door.`;

const ACT_CANNOT_GATE = `Guardrail CANNOT GATE — 3 findings on block-rule kind (secret) cannot be attributed

Cannot attribute — refusing to pass (3)
  · 3 findings covered by block rule newSecret cannot be attributed —
    secret: gitleaks 8.18.4 → 8.21.0 since the baseline was captured
  · dispatch the baseline-refresh workflow to re-capture the anchor from CI
    and restore attribution; the guardrail refuses to pass until then`;

function term(text: string, label: string): string {
  return `<div class="term-wrap"><div class="term-bar"><span></span><span></span><span></span><em>${label}</em></div><pre class="term">${text}</pre></div>`;
}

/** Stat tiles: evidence before adjectives. Numbers from docs/benchmarks.md. */
function statTiles(): string {
  const tiles = [
    {
      n: '0 / 16',
      s: 'dirty stops with the Stop-gate armed (11/16 for the same agent ungated)',
    },
    { n: '0', s: 'false net-new findings on the tested line-shift, rename, and churn cases' },
    {
      n: '+49%',
      s: 'measured cost of deferring a repair to a cold session (test-gap task; the secret-task premium was weak)',
    },
    { n: '10', s: 'language ecosystems, one deterministic verdict contract' },
  ];
  return `<div class="stats">${tiles
    .map(
      (t) =>
        `<div class="stat"><div class="stat-n">${t.n}</div><div class="stat-s">${t.s}</div></div>`,
    )
    .join(
      '',
    )}<p class="stat-note">Controlled seeded-regression benchmark; methodology, claim boundaries, and offline-replayable harnesses in <a href="#ref-benchmarksmd">the benchmark docs</a>.</p></div>`;
}

/** The six causes of a finding delta — the verdict epistemics, as a table. */
function sixCauses(): string {
  const rows: Array<[string, string]> = [
    ['the change introduced it', '<strong>the only cause that blocks</strong>'],
    [
      'the scan didn’t fully observe the current side',
      'per-kind observation disclosures, never silent',
    ],
    ['the finding moved (line shift, rename)', 'git-aware identity matching, durable fingerprints'],
    ['a scanner changed underneath you', 'per-kind recall contexts (tool + plugin + config)'],
    ['dxkit itself changed what it can see', 'versioned observation epochs'],
    ['a truncated or partial prior report', 'multiset-aware pair matching'],
  ];
  return `<table class="causes"><thead><tr><th>A finding delta can mean…</th><th>ruled out with…</th></tr></thead><tbody>${rows
    .map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`)
    .join('')}</tbody></table>`;
}

/** The comparison triptych: the two failure modes, then the closed loop. */
function triptych(): string {
  const cols = [
    {
      t: 'Detection alone',
      d: 'Findings pile up. On a brownfield repo the gate cries wolf on five-year-old debt until someone turns it off.',
    },
    {
      t: 'Autofix alone',
      d: 'Diffs merge on the say-so of the same class of model that wrote the bug. Nobody re-verified.',
    },
    {
      t: 'dxkit: the closed loop',
      d: 'Baseline the debt → gate only the net-new → bounded agents repair → the SAME gate verifies → a receipt lands in the PR.',
      hi: true,
    },
  ];
  return `<div class="trip">${cols
    .map((c) => `<div class="trip-col${c.hi ? ' trip-hi' : ''}"><h4>${c.t}</h4><p>${c.d}</p></div>`)
    .join('')}</div>`;
}

export interface ShowcaseOpts {
  /** Serving locally (assistant panel live) vs the static file. */
  serve: boolean;
  /** Number of reference pages in the bundle (for the browse CTA). */
  referenceCount: number;
}

/** The slice of LearnRepoStatus the home view reads (structural, so this
 *  module needs no import from repo-status). */
export interface RepoHomeStatus {
  cwd: string;
  installed: boolean;
  doctor: {
    checks: ReadonlyArray<{ label: string; ok: boolean; advisory?: boolean }>;
  } | null;
  policy: { preset?: string; lanes: string[] } | null;
  baselines: Array<{ name: string; capturedAt?: string; entryCount: number }>;
  lastVerdict: {
    blocks: boolean;
    blockingCount: number;
    warningCount: number;
    unattributableCount: number;
    ranAt: string;
  } | null;
  jobs?: Array<{ name: string; nextRunUtc?: string }>;
  /** Tier-1 repo profile projection (repo-status.ts owns the reads). */
  profile?: {
    graph: {
      functionCount: number;
      fileCount: number;
      refreshedAt?: string;
      stale: boolean;
    } | null;
    debt: { bySeverity: Record<string, number> } | null;
  };
}

/** Canonical severity display order for the debt shape. */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'unrated'];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The repo-mode HOME view: when a repo is present, the first screen is THAT
 * repo — its verdict, baseline, automation, and what needs attention — with
 * the product showcase one click away. Zero-context mode keeps the showcase
 * as home. Everything here is a projection of LearnRepoStatus (the one
 * canonical gather); this view computes nothing of its own.
 */
export function renderRepoHome(status: RepoHomeStatus, opts: { serve: boolean }): string {
  const repoName = esc(status.cwd.replace(/\/+$/, '').split('/').pop() ?? 'this repo');

  // Serve mode makes every tile ASKABLE: clicking opens the assistant with
  // a question matched to what the tile shows (same mechanism as the
  // chips). The static page has no assistant, so tiles stay plain.
  const dq = (q: string): string =>
    opts.serve ? ` data-q="${esc(q)}" role="button" tabindex="0"` : '';

  // Tile 1: the gate.
  const v = status.lastVerdict;
  const verdictWord = v
    ? v.unattributableCount > 0
      ? 'CANNOT GATE'
      : v.blocks
        ? 'BLOCKED'
        : 'PASSED'
    : null;
  const verdictTile = v
    ? `<div class="stat"${dq('Explain our last guardrail verdict. What should we do about it?')}><div class="stat-n ${verdictWord === 'PASSED' ? 'ok' : 'bad'}">${verdictWord}</div><div class="stat-s">last guardrail verdict (${esc(v.ranAt.slice(0, 10))})${v.blockingCount ? ` · ${v.blockingCount} blocking` : ''}${v.warningCount ? ` · ${v.warningCount} warnings` : ''}</div></div>`
    : `<div class="stat"${dq('How do I run the guardrail here and read its verdict?')}><div class="stat-n">—</div><div class="stat-s">no cached verdict yet · run <code>vyuh-dxkit guardrail check</code></div></div>`;

  // Tile 2: the baseline, with the debt's severity shape when known.
  const b = status.baselines[0];
  const bySev = status.profile?.debt?.bySeverity ?? {};
  const sevShape = SEVERITY_ORDER.filter((k) => (bySev[k] ?? 0) > 0)
    .map((k) => `${bySev[k]} ${k}`)
    .join(' · ');
  const baselineTile = b
    ? `<div class="stat"${dq('What does our debt look like?')}><div class="stat-n">${b.entryCount}</div><div class="stat-s">grandfathered findings in baseline <code>${esc(b.name)}</code>${b.capturedAt ? `, captured ${esc(b.capturedAt.slice(0, 10))}` : ''}${sevShape ? ` · ${esc(sevShape)}` : ''}</div></div>`
    : `<div class="stat"${dq('How do I create a baseline here, and what does it do?')}><div class="stat-n">—</div><div class="stat-s">no committed baseline · <code>vyuh-dxkit baseline create</code> (or the refresh lane)</div></div>`;

  // Tile 3: automation.
  const jobs = status.jobs ?? [];
  const nextRun = jobs
    .map((j) => j.nextRunUtc)
    .filter((x): x is string => !!x)
    .sort()[0];
  const autoTile = `<div class="stat"${dq('What do our installed dxkit workflows do, and when do they run?')}><div class="stat-n">${jobs.length}</div><div class="stat-s">dxkit workflows installed${nextRun ? ` · next scheduled run ${esc(nextRun)} UTC` : ''}</div></div>`;

  // Tile 4: the map (tier-1 profile; freshness always stated).
  const g = status.profile?.graph;
  const graphTile = g
    ? `<div class="stat"${dq('Is the code graph fresh here, and what are its hub functions?')}><div class="stat-n">${g.functionCount.toLocaleString('en-US')}</div><div class="stat-s">functions in the code graph, ${g.fileCount.toLocaleString('en-US')} files${g.refreshedAt ? ` · refreshed ${esc(g.refreshedAt.slice(0, 10))}` : ''}${g.stale ? ` · STALE — <code>vyuh-dxkit describe</code>` : ''}</div></div>`
    : `<div class="stat"${dq('How do I set up the code graph here, and what does it enable?')}><div class="stat-n">—</div><div class="stat-s">code graph not set up · <code>vyuh-dxkit describe</code></div></div>`;

  // Tile 5: setup health (advisory items are advice, not gaps).
  const failing = (status.doctor?.checks ?? []).filter((c) => !c.ok && !c.advisory);
  const setupTile =
    failing.length === 0
      ? `<div class="stat"${dq("Is anything missing in this repo's dxkit setup?")}><div class="stat-n ok">✓</div><div class="stat-s">doctor: everything wired</div></div>`
      : `<div class="stat"${dq("What is missing in this repo's setup, and how do I fix it?")}><div class="stat-n bad">${failing.length}</div><div class="stat-s">setup item${failing.length === 1 ? '' : 's'} to finish · <a href="#setup-panel">see remedies</a></div></div>`;

  const attention =
    failing.length > 0
      ? `<h2 class="section">Needs attention</h2>
         <ul class="list-plain">${failing
           .slice(0, 3)
           .map((c) => `<li>${esc(c.label)}</li>`)
           .join('')}</ul>
         <p class="section-sub"><a href="#setup-panel">Set up this repo</a> has the exact remedy for each.</p>`
      : '';

  const notInstalled = !status.installed
    ? `<div class="note">dxkit is not fully installed here (no manifest). The zero-question path: <code>npm init @vyuhlabs/dxkit -- --yes</code>, then <code>vyuh-dxkit doctor</code>.</div>`
    : '';

  return `<section class="view" id="home" data-title="${repoName}" data-crumb="">
    <div class="hero">
      <h1>${repoName}</h1>
      <p>This repo, as dxkit sees it right now. The knowledge base behind it covers every command, policy field, and lane${opts.serve ? ', and the assistant answers from this repo’s live status' : ''}.</p>
      <div class="hero-actions">
        <a class="tbtn primary" href="#repo-status">Full status</a>
        <a class="tbtn" href="#setup-panel">Set up this repo</a>
        <a class="tbtn" href="#core">What is dxkit?</a>
        ${opts.serve ? `<button class="tbtn" id="home-ask">Ask the assistant</button>` : ''}
      </div>
      ${notInstalled}
    </div>
    <div class="stats">${verdictTile}${baselineTile}${autoTile}${graphTile}${setupTile}</div>
    ${attention}</section>`;
}

/**
 * The full "Start here" hero + showcase, minus the capability cards that
 * render.ts appends after it (they stay in render.ts so the card layout has
 * one owner).
 */
export function renderShowcaseHero(opts: ShowcaseOpts): string {
  const assistantLine = opts.serve
    ? `<p class="hero-assist">The assistant on this page answers from exactly this knowledge base, and from this repo’s live status when one is present. Your key stays on this machine; by default it sends summaries, never raw findings. Press <kbd>Ctrl</kbd>+<kbd>/</kbd> to ask it anything on this page.</p>`
    : `<p class="hero-assist">Serve this page locally and it gains a BYO-key assistant grounded in exactly this content: <code>npx --yes @vyuhlabs/dxkit learn --serve</code></p>`;

  return `<div class="hero">
      <h1>Map the code. Prove each change is safe to merge.<br>Fix the debt. Repeat.</h1>
      <p>Coding agents write more code than anyone can review by hand. dxkit covers the gap with three things: a <strong>living map</strong> of the codebase that grounds agents in real structure before they edit, a <strong>deterministic check</strong> that proves each change is safe to merge, and a <strong>repair crew</strong> of agents that bump dependencies, fix vulnerabilities, and improve tests, with every fix landing through that same check. Everything on this page ships with the package and works offline.</p>
      <div class="hero-actions">
        <a class="tbtn primary" href="#doc-how-dxkit-thinks">Read the mental model</a>
        <a class="tbtn" href="#cap-evaluate">Try it read-only: <code>evaluate</code></a>
        <a class="tbtn" href="#doc-quickstart-developer">The gate blocked my PR</a>
        <a class="tbtn" href="#reference">Reference (${opts.referenceCount} pages)</a>
      </div>
      ${assistantLine}
    </div>

    <h2 class="section">One loop, three verdicts</h2>
    <p class="section-sub">This is the product working, output verbatim. Click through the acts, or just watch.</p>
    <div class="acts" id="acts">
      <div class="act-tabs" role="tablist">
        <button class="act-tab on" data-act="0">1 · An agent’s change arrives</button>
        <button class="act-tab" data-act="1">2 · A bounded agent repairs</button>
        <button class="act-tab" data-act="2">3 · Same gate, now provable</button>
      </div>
      <div class="act on">${term(ACT_BLOCKED, 'guardrail check')}</div>
      <div class="act">${term(ACT_REMEDIATE, 'the remediation PR body')}</div>
      <div class="act">${term(ACT_PASSED, 'guardrail check')}</div>
    </div>

    ${statTiles()}

    <h2 class="section">The gate that can say “I don’t know”</h2>
    <p class="section-sub">Every other gate answers pass or fail. A gate that cannot attribute a delta and passes anyway is lying to you, so this one refuses, names the cause, and names the remedy. A tool upgrade is never blamed on whoever opened the next PR.</p>
    ${term(ACT_CANNOT_GATE, 'the refusal tier')}
    ${sixCauses()}

    <h2 class="section">Why a closed loop</h2>
    ${triptych()}`;
}
